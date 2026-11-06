// Mana sites: magnetized ore bodies bend the incoming stellar mana stream into collision sites.
// Two opposed fields pair it up (AM2, heat), three make a gale (AM3), four alternating ones absorb heat (AM4).
// Lore: "Untitled Book/Magic System/Mana Cycle.md". Uses its own PRNG, so the map's other random rolls never shift
import Alea from "alea";
import type { MapData } from "@/model/options/options-schema";
import type { Point } from "@/types/global";
import { minmax, rn } from "@/utils/number-utils";

type ManaSettings = NonNullable<MapData["mana"]>;
type ManaSource = ManaSettings["sources"][number];
type Projection = (x: number, y: number) => Point;

/** a cell's site is its Active Mana count; 0 is plain ground */
export const SITE = { none: 0, hot: 2, gale: 3, cold: 4 } as const;
type SiteType = (typeof SITE)[keyof typeof SITE];

export interface Gale {
  cells: number[]; // the plume's path, the gale's own site cell first
  dx: number; // unit direction the gale blows in
  dy: number;
}

export interface ManaSites {
  type: Uint8Array; // SITE value per grid cell
  intensity: Float32Array; // 0 at a site's edge, up to 1 in its core
  gales: Gale[];
  strength: number; // effect multiplier the map was generated with
}

interface Reading {
  type: SiteType;
  level: number; // [0, 1]: how deep inside the site the cell is
  dx: number;
  dy: number;
}

interface StrongField {
  polarity: number;
  field: number;
  angle: number; // where the source sits, seen from the cell
  ux: number; // unit vector from the source to the cell
  uy: number;
}

const STRONG_FIELD = 0.35; // a source takes part in a collision above this share of its peak field
const MAX_SOURCES = 200;
const MAX_REACH = 100; // cells
const QUAD_SHARE = 1 / 3; // share of sources placed as four-fold ore bodies
const QUAD_SPREAD = 0.6; // quadrupole arm length, in source radii
const RADIUS_MIN = 0.08; // source radius as a share of the map's shorter side
const RADIUS_MAX = 0.16;
const MAX_HEAT = 25; // °C added by AM2 at full intensity and strength 1
const MAX_CHILL = 30; // °C drained by AM4
const HEAT_CAP = 50; // °C: lake evaporation divides by (80 - temp), so stay well clear of it
const MAX_DRYING = 0.8; // share of precipitation AM2 boils off at full power
const GALE_MOISTURE = 30; // precipitation a gale drops at its site cell, fading along its path
const FORWARD = 0.5; // a gale only moves to a neighbor within ~60° of its direction
const NEUTRAL: Reading = { type: SITE.none, level: 0, dx: 0, dy: 0 };

class ManaModule {
  /** place the ore bodies of a new map from the request: the commit point from generation to map options */
  placeSources(): void {
    const { sources, strength, reach } = options.generation.mana;
    const { width, height } = options.map.graph;
    const random = Alea(`${options.map.seed}-mana`);
    options.map.mana = { strength, reach, sources: createSources(random, sources, width, height) };
  }

  /** classify every grid cell from the stored sources; deterministic, so the renderer may ask at any time */
  getSites(): ManaSites | null {
    const mana = options.map.mana;
    if (!mana || !mana.sources.length || mana.strength <= 0) return null;

    const { points } = grid;
    const type = new Uint8Array(points.length);
    const intensity = new Float32Array(points.length);
    const directions = new Float32Array(points.length * 2);

    for (let cell = 0; cell < points.length; cell++) {
      const reading = readCell(points[cell], mana.sources);
      if (reading.type === SITE.none) continue;
      type[cell] = reading.type;
      intensity[cell] = reading.level * polarBoost(points[cell][1]);
      directions[cell * 2] = reading.dx;
      directions[cell * 2 + 1] = reading.dy;
    }

    const reach = minmax(Math.round(mana.reach), 0, MAX_REACH);
    return { type, intensity, gales: findGales(type, intensity, directions, reach), strength: mana.strength };
  }

  /** AM2 sites heat, AM4 sites chill. A new array, or the input itself when the map has no mana */
  applyHeat(temp: Int8Array): Int8Array {
    const sites = this.getSites();
    if (!sites || sites.type.length !== temp.length) return temp;

    const result = Int8Array.from(temp);
    for (let cell = 0; cell < temp.length; cell++) {
      const power = sites.intensity[cell] * sites.strength;
      if (sites.type[cell] === SITE.hot) {
        result[cell] = Math.round(Math.min(temp[cell] + MAX_HEAT * power, Math.max(HEAT_CAP, temp[cell])));
      } else if (sites.type[cell] === SITE.cold) {
        result[cell] = Math.round(Math.max(temp[cell] - MAX_CHILL * power, -128));
      }
    }
    return result;
  }

  /** AM2 sites boil moisture off, AM3 gales carry it downwind. A new array, or the input itself without mana */
  applyMoisture(prec: Uint8Array): Uint8Array {
    const sites = this.getSites();
    if (!sites || sites.type.length !== prec.length) return prec;

    const wet = Float32Array.from(prec);
    for (let cell = 0; cell < wet.length; cell++) {
      if (sites.type[cell] !== SITE.hot) continue;
      wet[cell] *= 1 - MAX_DRYING * Math.min(sites.intensity[cell] * sites.strength, 1);
    }
    for (const gale of sites.gales) addPlume(wet, gale, sites.strength);

    return Uint8Array.from(wet, value => minmax(Math.round(value), 0, 255));
  }

  /** move the ore bodies with the land when the map is resampled (submap tool) */
  projectSources(projection: Projection, scale: number): void {
    const mana = options.map.mana;
    if (!mana || !(scale > 0)) return;
    mana.sources = mana.sources.map(source => {
      const [x, y] = projection(source.x, source.y);
      return { ...source, x: rn(x, 1), y: rn(y, 1), radius: Math.max(rn(source.radius * scale, 2), 0.01) };
    });
  }
}

function createSources(random: () => number, requested: number, width: number, height: number): ManaSource[] {
  const total = minmax(Math.round(requested), 0, MAX_SOURCES);
  const side = Math.min(width, height);
  const pickRadius = () => rn(side * (RADIUS_MIN + random() * (RADIUS_MAX - RADIUS_MIN)), 2);
  const sources: ManaSource[] = [];

  const quadrupoles = Math.floor((total * QUAD_SHARE) / 4);
  for (let q = 0; q < quadrupoles; q++) sources.push(...createQuadrupole(random, pickRadius(), width, height));

  for (let i = sources.length; i < total; i++) {
    sources.push({
      x: rn(random() * width, 1),
      y: rn(random() * height, 1),
      polarity: random() < 0.5 ? 1 : -1,
      radius: pickRadius()
    });
  }
  return sources;
}

/** four sources around one center with alternating polarity: a cold core ringed by hot and windy fringes */
function createQuadrupole(random: () => number, radius: number, width: number, height: number): ManaSource[] {
  const cx = random() * width;
  const cy = random() * height;
  const turn = (random() * Math.PI) / 2;
  const spread = radius * QUAD_SPREAD;

  return [0, 1, 2, 3].map((k): ManaSource => {
    const angle = turn + (k * Math.PI) / 2;
    return {
      x: rn(cx + Math.cos(angle) * spread, 1),
      y: rn(cy + Math.sin(angle) * spread, 1),
      polarity: k % 2 ? -1 : 1,
      radius
    };
  });
}

function readCell([x, y]: Point, sources: ManaSource[]): Reading {
  const strong: StrongField[] = [];
  for (const source of sources) {
    const ox = x - source.x;
    const oy = y - source.y;
    const distance = Math.hypot(ox, oy);
    const field = Math.exp(-((distance / source.radius) ** 2));
    if (field < STRONG_FIELD) continue;
    const length = distance || 1;
    strong.push({ polarity: source.polarity, field, angle: Math.atan2(-oy, -ox), ux: ox / length, uy: oy / length });
  }

  if (strong.length < 2 || strong.length > 4) return NEUTRAL;

  const weakest = Math.min(...strong.map(({ field }) => field));
  const level = (weakest - STRONG_FIELD) / (1 - STRONG_FIELD);

  if (strong.length === 2) {
    return strong[0].polarity !== strong[1].polarity ? { ...NEUTRAL, type: SITE.hot, level } : NEUTRAL;
  }
  if (strong.length === 3) return { type: SITE.gale, level, ...galeDirection(strong) };
  return alternates(strong) ? { ...NEUTRAL, type: SITE.cold, level } : NEUTRAL;
}

/** the polarity-weighted push of three converging streams */
function galeDirection(strong: StrongField[]): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const { polarity, field, ux, uy } of strong) {
    dx += polarity * field * ux;
    dy += polarity * field * uy;
  }
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { dx: 1, dy: 0 };
  return { dx: dx / length, dy: dy / length };
}

/** four sources whose polarity flips at every step around the cell: a quadrupole focus */
function alternates(strong: StrongField[]): boolean {
  const ring = [...strong].sort((a, b) => a.angle - b.angle);
  return ring.every((field, i) => field.polarity !== ring[(i + 1) % ring.length].polarity);
}

/** mana streams come down the field lines near the poles, so sites there run stronger */
function polarBoost(y: number): number {
  const { latN, latT } = options.map.geography.coordinates;
  const latitude = latN - (y / options.map.graph.height) * latT;
  return 0.5 + (0.5 * Math.min(Math.abs(latitude), 90)) / 90;
}

function findGales(type: Uint8Array, intensity: Float32Array, directions: Float32Array, reach: number): Gale[] {
  const seen = new Uint8Array(type.length);
  const gales: Gale[] = [];

  for (let cell = 0; cell < type.length; cell++) {
    if (type[cell] !== SITE.gale || seen[cell]) continue;
    const origin = strongestInRegion(cell, type, intensity, seen);
    const dx = directions[origin * 2];
    const dy = directions[origin * 2 + 1];
    gales.push({ cells: march(origin, dx, dy, reach), dx, dy });
  }
  return gales;
}

/** flood the connected gale region from `start`, marking it seen; returns its strongest cell */
function strongestInRegion(start: number, type: Uint8Array, intensity: Float32Array, seen: Uint8Array): number {
  const neighbors = grid.cells.c;
  const queue = [start];
  seen[start] = 1;
  let strongest = start;

  // bounded: every cell enters the queue at most once
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    if (intensity[cell] > intensity[strongest]) strongest = cell;
    for (const neighbor of neighbors[cell]) {
      if (neighbor >= type.length || seen[neighbor] || type[neighbor] !== SITE.gale) continue;
      seen[neighbor] = 1;
      queue.push(neighbor);
    }
  }
  return strongest;
}

function march(start: number, dx: number, dy: number, reach: number): number[] {
  const path = [start];
  let current = start;
  for (let step = 0; step < reach; step++) {
    if (grid.cells.b[current]) break; // map edge
    const next = nextAlong(current, dx, dy);
    if (next === -1) break;
    path.push(next);
    current = next;
  }
  return path;
}

/** the neighbor that lies most along the direction, -1 when none points forward */
function nextAlong(cell: number, dx: number, dy: number): number {
  const { points } = grid;
  const [x0, y0] = points[cell];
  let best = -1;
  let bestAlignment = FORWARD;

  for (const neighbor of grid.cells.c[cell]) {
    if (neighbor >= points.length) continue;
    const [x1, y1] = points[neighbor];
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const alignment = ((x1 - x0) * dx + (y1 - y0) * dy) / length;
    if (alignment > bestAlignment) {
      bestAlignment = alignment;
      best = neighbor;
    }
  }
  return best;
}

/** a gale drops moisture along its path, fading with distance, and spills half of it on either side */
function addPlume(wet: Float32Array, { cells }: Gale, strength: number): void {
  const neighbors = grid.cells.c;
  cells.forEach((cell, step) => {
    const moisture = GALE_MOISTURE * strength * (1 - step / cells.length);
    wet[cell] += moisture;
    for (const neighbor of neighbors[cell]) {
      if (neighbor < wet.length) wet[neighbor] += moisture / 2;
    }
  });
}

export const Mana = new ManaModule();
