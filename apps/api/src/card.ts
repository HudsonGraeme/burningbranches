import {
  TERRAIN_COLOR,
  TERRAIN_LABEL,
  clamp01,
  mulberry32,
  speciesAt,
  speciesIndexForPath,
  type BiomeManifest,
  type Plot,
  type Terrain,
} from '@burningbranches/schema';
import { textWidth } from './font.js';
import { encodePNG } from './png.js';
import { Raster, mixColor, unpack } from './raster.js';

const W = 1200;
const H = 630;
const MAP = 630;
const MAP_X = W - MAP - 6;
const MAP_Y = 0;

const INK = 0xf2ede4;
const MUTED = 0x8d8577;
const PANEL = 0x0e100d;
const EMBER = 0xff7a2f;

export interface Summary {
  plots: number;
  burning: number;
  ash: number;
  dirt: number;
  canopyShare: number;
  burningShare: number;
  oldestYears: number;
  tallest: number;
  ageYears: number;
}

export function summarize(manifest: BiomeManifest): Summary {
  let burning = 0;
  let ash = 0;
  let dirt = 0;
  let canopy = 0;
  let oldest = 0;
  let tallest = 0;

  for (const plot of manifest.plots) {
    const t = plot.biome.terrain;
    if (t === 'burning') burning++;
    else if (t === 'ash') ash++;
    else if (t === 'dirt') dirt++;
    if (t === 'youngForest' || t === 'matureForest' || t === 'oldGrowth') canopy++;
    oldest = Math.max(oldest, plot.metrics.dormantYears);
    tallest = Math.max(tallest, plot.biome.treeHeight);
  }

  const total = Math.max(1, manifest.plots.length);
  // The forest is grown against the project's real age, so that is what the card reports.
  const spanMs =
    new Date(manifest.scan.generatedAt).getTime() - new Date(manifest.repo.createdAt).getTime();

  return {
    plots: manifest.plots.length,
    burning,
    ash,
    dirt,
    canopyShare: canopy / total,
    burningShare: (burning + ash) / total,
    oldestYears: oldest,
    tallest,
    ageYears: spanMs / (365.25 * 86_400_000),
  };
}

export async function renderCard(manifest: BiomeManifest): Promise<Uint8Array> {
  const raster = new Raster(W, H);
  raster.clear(PANEL);

  drawMap(raster, manifest);
  drawPanel(raster, manifest);

  return encodePNG(W, H, raster.data);
}

function drawMap(raster: Raster, manifest: BiomeManifest): void {
  const size = manifest.world.size;
  const scale = MAP / size;
  const maxElevation = Math.max(1, manifest.world.maxElevation);

  raster.rect(MAP_X, MAP_Y, MAP, H, 0x0b0d0a);

  const plots = manifest.plots;
  for (const plot of plots) {
    const [rx, ry, rw, rh] = plot.rect;
    const x = MAP_X + rx * scale;
    const y = MAP_Y + ry * scale;
    const w = Math.max(1, rw * scale);
    const h = Math.max(1, rh * scale);

    const lift = clamp01(plot.elevation / maxElevation);
    const base = TERRAIN_COLOR[plot.biome.terrain];
    const shaded = mixColor(mixColor(base, 0x000000, 0.34), 0xffffff, lift * 0.22);
    raster.rect(x, y, w, h, shaded);
  }

  for (const plot of plots) drawCanopy(raster, plot, scale);

  for (const plot of plots) {
    if (plot.biome.fire <= 0.05) continue;
    const [rx, ry, rw, rh] = plot.rect;
    const cx = MAP_X + (rx + rw / 2) * scale;
    const cy = MAP_Y + (ry + rh / 2) * scale;
    const radius = Math.max(4, Math.min(rw, rh) * scale * 0.9);
    raster.glow(cx, cy, radius * 2.2, EMBER, 0.5 * plot.biome.fire);
    raster.glow(cx, cy, radius, 0xffd08a, 0.45 * plot.biome.fire);
  }

  // Territory borders at the top of the tree keep the districts legible at card size.
  for (const region of manifest.regions) {
    if (region.depth !== 1) continue;
    const [rx, ry, rw, rh] = region.rect;
    outline(
      raster,
      MAP_X + rx * scale,
      MAP_Y + ry * scale,
      rw * scale,
      rh * scale,
      0x000000,
      0.28,
    );
  }

  // Feather the seam between panel and map instead of cutting a hard edge.
  for (let i = 0; i < 90; i++) {
    raster.rect(MAP_X + i, 0, 1, H, PANEL, Math.pow(1 - i / 90, 2) * 0.95);
  }
}

function drawCanopy(raster: Raster, plot: Plot, scale: number): void {
  const density = plot.biome.density;
  if (density < 0.06 || plot.biome.treeHeight < 0.5) return;

  const [rx, ry, rw, rh] = plot.rect;
  const areaPx = rw * scale * rh * scale;
  if (areaPx < 3) return;

  const species = speciesAt(speciesIndexForPath(plot.path));
  const count = Math.min(240, Math.max(1, Math.round(areaPx * 0.05 * density)));
  const maturity = clamp01(plot.biome.treeHeight / 30);
  const foliage = mixColor(species.foliage, 0x0a1a0c, 0.25 - maturity * 0.2);
  const lit = mixColor(foliage, 0xd7e2a0, 0.22);
  const shadow = mixColor(foliage, 0x000000, 0.55);
  const charred = plot.biome.burn > 0.3;

  // A seeded stream, not sequential hash salts. Salting by index correlates the samples and
  // paints the canopy as diagonal scratches instead of scattered crowns.
  const random = mulberry32(plot.id * 2654435761 + 17);

  for (let i = 0; i < count; i++) {
    const px = MAP_X + (rx + random() * rw) * scale;
    const py = MAP_Y + (ry + random() * rh) * scale;
    const radius = Math.max(0.7, (0.7 + maturity * 2.1) * (0.75 + random() * 0.55));
    const crown = charred ? 0x2a2320 : random() > 0.72 ? lit : foliage;
    disc(raster, px + radius * 0.45, py + radius * 0.5, radius, shadow, charred ? 0.35 : 0.5);
    disc(raster, px, py, radius, crown, charred ? 0.7 : 0.94);
  }
}

function disc(
  raster: Raster,
  cx: number,
  cy: number,
  radius: number,
  color: number,
  alpha: number,
): void {
  const [r, g, b] = unpack(color);
  const x0 = Math.floor(cx - radius);
  const x1 = Math.ceil(cx + radius);
  const y0 = Math.floor(cy - radius);
  const y1 = Math.ceil(cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > radius) continue;
      const edge = clamp01(radius - d);
      raster.blend(x, y, r, g, b, alpha * edge);
    }
  }
}

function outline(
  raster: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  alpha: number,
): void {
  raster.rect(x, y, w, 1, color, alpha);
  raster.rect(x, y + h - 1, w, 1, color, alpha);
  raster.rect(x, y, 1, h, color, alpha);
  raster.rect(x + w - 1, y, 1, h, color, alpha);
}

function drawPanel(raster: Raster, manifest: BiomeManifest): void {
  const summary = summarize(manifest);
  const left = 52;
  /** Everything in the panel has to clear the map, so this is the hard right edge for text. */
  const textWidthBudget = MAP_X - left - 30;
  const column = Math.floor(textWidthBudget / 3);

  raster.verticalGradient(0, 0, MAP_X + 40, H, 0x11140f, 0x080907);

  raster.rect(left, 56, 42, 4, EMBER);
  raster.text('BURNINGBRANCHES.DEV', left, 74, 2, MUTED, 0.85, 2);

  const title = `${manifest.repo.owner}/${manifest.repo.name}`;
  const titleScale = fitScale(title, textWidthBudget, 2, 5);
  raster.text(title, left, 110, titleScale, INK, 1, 1);

  if (manifest.repo.description) {
    const line = truncate(manifest.repo.description, Math.floor(textWidthBudget / 12));
    raster.text(line, left, 118 + titleScale * 9, 2, MUTED, 0.9, 1);
  }

  const statsY = 208;
  stat(raster, left, statsY, 'FILES MAPPED', summary.plots.toLocaleString());
  stat(raster, left + column, statsY, 'PROJECT AGE', formatAge(summary.ageYears));
  stat(raster, left + column * 2, statsY, 'TALLEST', `${summary.tallest.toFixed(0)} m`);

  const statsY2 = statsY + 70;
  stat(raster, left, statsY2, 'CANOPY', `${Math.round(summary.canopyShare * 100)}%`);
  stat(raster, left + column, statsY2, 'SCORCHED', `${Math.round(summary.burningShare * 100)}%`);
  stat(
    raster,
    left + column * 2,
    statsY2,
    'BURNING NOW',
    summary.burning.toLocaleString(),
    summary.burning > 0 ? EMBER : INK,
  );

  const legend: Terrain[] = ['oldGrowth', 'matureForest', 'youngForest', 'dirt', 'ash', 'burning'];
  let ly = statsY2 + 96;
  raster.text('LEGEND', left, ly, 2, MUTED, 0.7, 2);
  ly += 26;
  for (const terrain of legend) {
    raster.rect(left, ly, 14, 14, TERRAIN_COLOR[terrain]);
    raster.text(TERRAIN_LABEL[terrain], left + 26, ly + 3, 2, INK, 0.82, 1);
    ly += 24;
  }

  const scanned = new Date(manifest.scan.generatedAt);
  raster.text(
    `Grown from ${manifest.scan.windows} eras of history  ${scanned.toISOString().slice(0, 10)}`,
    left,
    H - 46,
    2,
    MUTED,
    0.75,
    1,
  );
}

function stat(
  raster: Raster,
  x: number,
  y: number,
  label: string,
  value: string,
  color = INK,
): void {
  raster.text(label, x, y, 2, MUTED, 0.72, 1);
  raster.text(value, x, y + 22, 3, color, 1, 1);
}

function formatAge(years: number): string {
  if (years < 1 / 12) return `${Math.max(1, Math.round(years * 365))} d`;
  if (years < 1) return `${Math.round(years * 12)} mo`;
  return `${years.toFixed(1)} yr`;
}

/** Largest scale at which the string still fits the panel, so long names never bleed into the map. */
function fitScale(text: string, budget: number, min: number, max: number): number {
  for (let scale = max; scale > min; scale--) {
    if (textWidth(text, scale, 1) <= budget) return scale;
  }
  return min;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/[^\x20-\x7e]/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}
