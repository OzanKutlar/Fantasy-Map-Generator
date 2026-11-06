import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Grid } from "@/model/graph/grid-generator";
import { Options } from "@/model/options/options-model";
import { Mana, SITE } from "./mana-generator";

type Source = { x: number; y: number; polarity: 1 | -1; radius: number };

const quadrupole = (cx: number, cy: number, radius: number): Source[] =>
  [0, 1, 2, 3].map(
    (k): Source => ({
      x: cx + Math.cos((k * Math.PI) / 2) * radius * 0.6,
      y: cy + Math.sin((k * Math.PI) / 2) * radius * 0.6,
      polarity: k % 2 ? -1 : 1,
      radius
    })
  );

// far apart, so each site forms on its own: a cold quadrupole, a hot pair, a windy triple
const SOURCES: Source[] = [
  ...quadrupole(400, 300, 60),
  { x: 150, y: 150, polarity: 1, radius: 50 },
  { x: 180, y: 150, polarity: -1, radius: 50 },
  { x: 600, y: 445, polarity: 1, radius: 50 },
  { x: 630, y: 445, polarity: -1, radius: 50 },
  { x: 615, y: 471, polarity: 1, radius: 50 }
];

const nearestCell = (x: number, y: number): number => {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  grid.points.forEach(([px, py], cell) => {
    const distance = Math.hypot(px - x, py - y);
    if (distance < bestDistance) {
      best = cell;
      bestDistance = distance;
    }
  });
  return best;
};

const useSources = (strength = 1) => {
  options.map.mana = { strength, reach: 6, sources: structuredClone(SOURCES) };
};

beforeEach(() => {
  options = Options.getDefaultOptions();
  options.map.seed = "mana";
  options.map.graph = { width: 800, height: 600, points: 4000, sampling: "square", jitter: 0.9 };
  vi.stubGlobal("grid", Grid.generate("mana"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("placeSources", () => {
  it("places the same sources for the same seed without touching Math.random", () => {
    const random = vi.spyOn(Math, "random");
    Mana.placeSources();
    const first = structuredClone(options.map.mana);
    Mana.placeSources();
    Mana.getSites();

    expect(options.map.mana).toEqual(first);
    expect(first?.sources).toHaveLength(options.generation.mana.sources);
    expect(random).not.toHaveBeenCalled();
  });
});

describe("land placement", () => {
  it("puts every ore body on land when the land share is 1", () => {
    // the left half of the map is land, the right half sea
    grid.cells.h = Uint8Array.from(grid.points, ([x]) => (x < 400 ? 30 : 10));
    options.generation.mana.land = 1;
    Mana.placeSources();

    // a quadrupole arm reaches at most 0.6 x the largest radius (0.16 x 600) past its land center
    const sources = options.map.mana?.sources ?? [];
    expect(sources).toHaveLength(options.generation.mana.sources);
    expect(sources.every(({ x }) => x < 460)).toBe(true);
  });
});

describe("without mana", () => {
  it("returns the climate arrays untouched", () => {
    const temp = new Int8Array(grid.points.length).fill(10);
    const prec = new Uint8Array(grid.points.length).fill(50);

    expect(Mana.getSites()).toBeNull();
    expect(Mana.applyHeat(temp)).toBe(temp);
    expect(Mana.applyMoisture(prec)).toBe(prec);
  });
});

describe("sites", () => {
  it("chills a quadrupole core and heats the ground between an opposed pair", () => {
    useSources();
    const coldCell = nearestCell(400, 300);
    const hotCell = nearestCell(165, 150);
    const sites = Mana.getSites();
    const heated = Mana.applyHeat(new Int8Array(grid.points.length).fill(10));

    expect(sites?.type[coldCell]).toBe(SITE.cold);
    expect(sites?.type[hotCell]).toBe(SITE.hot);
    expect(heated[coldCell]).toBeLessThan(10);
    expect(heated[hotCell]).toBeGreaterThan(10);
  });

  it("never heats past the cap", () => {
    useSources(10);
    const heated = Mana.applyHeat(new Int8Array(grid.points.length).fill(45));

    expect(heated[nearestCell(165, 150)]).toBe(50);
    expect(Math.max(...heated)).toBeLessThanOrEqual(50);
  });

  it("dries hot ground and wets the gale's path", () => {
    useSources();
    const sites = Mana.getSites();
    if (!sites) throw new Error("Expected mana sites");
    const wet = Mana.applyMoisture(new Uint8Array(grid.points.length).fill(50));

    expect(sites.type[nearestCell(615, 454)]).toBe(SITE.gale);
    const distanceToTriple = (cell: number) => Math.hypot(grid.points[cell][0] - 615, grid.points[cell][1] - 454);
    const gale = [...sites.gales].sort((a, b) => distanceToTriple(a.cells[0]) - distanceToTriple(b.cells[0]))[0];

    expect(wet[gale.cells[0]]).toBeGreaterThan(50);
    expect(wet[nearestCell(165, 150)]).toBeLessThan(50);
  });
});

describe("projectSources", () => {
  it("leaves the sources as they are under an identity projection", () => {
    Mana.placeSources();
    const before = structuredClone(options.map.mana);
    Mana.projectSources((x, y) => [x, y], 1);

    expect(options.map.mana).toEqual(before);
  });
});
