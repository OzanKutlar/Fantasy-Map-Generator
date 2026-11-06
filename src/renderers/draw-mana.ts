// Mana sites: hot (AM2) and cold (AM4) ground, and the gales (AM3) blowing out of their own sites
import { Grid } from "@/model/graph/grid-generator";
import { type Gale, Mana, type ManaSites, SITE } from "@/model/physical/mana-generator";
import { log } from "@/utils/logger";
import { ensureEl } from "@/utils/node-utils";
import { rn } from "@/utils/number-utils";

const ARROW_HEAD = 5; // px
const MIN_OPACITY = 0.35; // a site's faint edge stays visible

export function drawMana(): void {
  log.time("drawMana");
  const sites = Mana.getSites();
  ensureEl("manaHot").innerHTML = sites ? buildRegions(sites, SITE.hot) : "";
  ensureEl("manaCold").innerHTML = sites ? buildRegions(sites, SITE.cold) : "";
  ensureEl("manaGale").innerHTML = sites ? buildGales(sites) : "";
  log.timeEnd("drawMana");
}

function buildRegions({ type, intensity }: ManaSites, site: number): string {
  const polygons: string[] = [];
  for (let cell = 0; cell < type.length; cell++) {
    if (type[cell] !== site) continue;
    const opacity = rn(MIN_OPACITY + (1 - MIN_OPACITY) * Math.min(intensity[cell], 1), 2);
    polygons.push(`<polygon points="${Grid.getPolygon(cell)}" fill-opacity="${opacity}"/>`);
  }
  return polygons.join("");
}

function buildGales({ gales }: ManaSites): string {
  const paths = gales.filter(gale => gale.cells.length > 1).map(galePath);
  return paths.length ? `<path d="${paths.join("")}" fill="none"/>` : "";
}

/** the plume's path with an arrowhead at its end: two strokes back from the tip at ±30° */
function galePath({ cells }: Gale): string {
  const points = cells.map(cell => grid.points[cell]);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${rn(x, 1)},${rn(y, 1)}`).join("");

  const [x0, y0] = points[points.length - 2];
  const [x1, y1] = points[points.length - 1];
  const length = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / length;
  const uy = (y1 - y0) / length;
  const [lx, ly] = [x1 - ARROW_HEAD * (ux * 0.87 - uy * 0.5), y1 - ARROW_HEAD * (uy * 0.87 + ux * 0.5)];
  const [rx, ry] = [x1 - ARROW_HEAD * (ux * 0.87 + uy * 0.5), y1 - ARROW_HEAD * (uy * 0.87 - ux * 0.5)];

  return `${line}M${rn(lx, 1)},${rn(ly, 1)}L${rn(x1, 1)},${rn(y1, 1)}L${rn(rx, 1)},${rn(ry, 1)}`;
}
