import {
  TERRAIN_COLOR,
  fbm2D,
  seedFor,
  type BiomeManifest,
  type Plot,
} from '@burningbranches/schema';

export const GRID = 512;

/**
 * The manifest is a set of rectangles. The scene needs a continuous surface, so plots are
 * rasterised into a grid, the firebreak gaps between directories are filled as trails, and
 * the elevation is blurred so the terrain rolls instead of stepping.
 */
export interface Field {
  grid: number;
  world: number;
  elevation: Float32Array;
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
  burn: Float32Array;
  fire: Float32Array;
  plotId: Int32Array;
}

const TRAIL_COLOR = 0x5c4c33;

/**
 * Domain warp applied when the treemap is rasterised. The layout stays exactly where the
 * algorithm put it, but the boundaries between plots stop being straight lines and start
 * interlocking the way real stands of different age meet.
 */
const WARP_COARSE = 7.5;
const WARP_FINE = 2.6;

export function buildField(manifest: BiomeManifest): Field {
  const cells = GRID * GRID;
  const world = manifest.world.size;
  const scale = GRID / world;

  const elevation = new Float32Array(cells);
  const red = new Float32Array(cells);
  const green = new Float32Array(cells);
  const blue = new Float32Array(cells);
  const burn = new Float32Array(cells);
  const fire = new Float32Array(cells);
  const plotId = new Int32Array(cells).fill(-1);

  const base = new Int32Array(cells).fill(-1);
  for (const plot of manifest.plots) {
    const [rx, ry, rw, rh] = plot.rect;
    const x0 = Math.max(0, Math.floor(rx * scale));
    const y0 = Math.max(0, Math.floor(ry * scale));
    const x1 = Math.min(GRID, Math.ceil((rx + rw) * scale));
    const y1 = Math.min(GRID, Math.ceil((ry + rh) * scale));
    for (let y = y0; y < y1; y++) {
      const row = y * GRID;
      for (let x = x0; x < x1; x++) base[row + x] = plot.id;
    }
  }

  const seed = seedFor(`${manifest.repo.owner}/${manifest.repo.name}`);
  const plots = manifest.plots;
  const palette = plots.map((plot) => {
    const color = TERRAIN_COLOR[plot.biome.terrain];
    return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
  });

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = y * GRID + x;
      const sx = Math.round(x + warp(seed, x, y, 0));
      const sy = Math.round(y + warp(seed, x, y, 977));
      const source =
        sx >= 0 && sy >= 0 && sx < GRID && sy < GRID ? base[sy * GRID + sx]! : base[i]!;
      if (source < 0) continue;

      const plot = plots[source];
      const tint = palette[source];
      if (!plot || !tint) continue;

      plotId[i] = source;
      elevation[i] = plot.elevation;
      red[i] = tint[0]!;
      green[i] = tint[1]!;
      blue[i] = tint[2]!;
      burn[i] = plot.biome.burn;
      fire[i] = plot.biome.fire;
    }
  }

  fillGaps(elevation, red, green, blue, plotId);
  jitterColor(red, green, blue, plotId);
  boxBlur(elevation, 2);
  boxBlur(red, 1);
  boxBlur(green, 1);
  boxBlur(blue, 1);
  boxBlur(burn, 1);

  return { grid: GRID, world, elevation, red, green, blue, burn, fire, plotId };
}

/** Directory gaps become walkable trails rather than holes in the terrain. */
function fillGaps(
  elevation: Float32Array,
  red: Float32Array,
  green: Float32Array,
  blue: Float32Array,
  plotId: Int32Array,
): void {
  const tr = ((TRAIL_COLOR >> 16) & 0xff) / 255;
  const tg = ((TRAIL_COLOR >> 8) & 0xff) / 255;
  const tb = (TRAIL_COLOR & 0xff) / 255;

  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    const snapshot = plotId.slice();
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = y * GRID + x;
        if (snapshot[i] !== -1) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
            const n = ny * GRID + nx;
            if (snapshot[n] === -1) continue;
            sum += elevation[n]!;
            count++;
          }
        }
        if (count === 0) continue;
        elevation[i] = sum / count - 0.6;
        red[i] = tr;
        green[i] = tg;
        blue[i] = tb;
        plotId[i] = -2;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** Breaks up the flat fill of each plot so large directories do not read as painted blocks. */
function jitterColor(
  red: Float32Array,
  green: Float32Array,
  blue: Float32Array,
  plotId: Int32Array,
): void {
  for (let i = 0; i < plotId.length; i++) {
    if (plotId[i] === -1) continue;
    const n = hash2(i % GRID, (i / GRID) | 0);
    const shade = 0.9 + n * 0.2;
    red[i] = Math.min(1, red[i]! * shade);
    green[i] = Math.min(1, green[i]! * shade);
    blue[i] = Math.min(1, blue[i]! * shade);
  }
}

/** Two octaves: a broad meander plus a fine ragged edge, both in grid cells. */
function warp(seed: number, x: number, y: number, salt: number): number {
  const coarse = fbm2D(seed + salt, x / 42, y / 42, 2) - 0.5;
  const fine = fbm2D(seed + salt + 313, x / 11, y / 11, 2) - 0.5;
  return coarse * 2 * WARP_COARSE + fine * 2 * WARP_FINE;
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function boxBlur(data: Float32Array, passes: number): void {
  const temp = new Float32Array(data.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = y * GRID + x;
        const left = x > 0 ? data[i - 1]! : data[i]!;
        const right = x < GRID - 1 ? data[i + 1]! : data[i]!;
        temp[i] = (left + data[i]! + right) / 3;
      }
    }
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = y * GRID + x;
        const up = y > 0 ? temp[i - GRID]! : temp[i]!;
        const down = y < GRID - 1 ? temp[i + GRID]! : temp[i]!;
        data[i] = (up + temp[i]! + down) / 3;
      }
    }
  }
}

/** Bilinear elevation lookup in world metres. */
export function sampleHeight(field: Field, x: number, z: number): number {
  const scale = field.grid / field.world;
  const gx = Math.min(field.grid - 1.001, Math.max(0, x * scale));
  const gz = Math.min(field.grid - 1.001, Math.max(0, z * scale));
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;
  const i = z0 * field.grid + x0;
  const a = field.elevation[i]!;
  const b = field.elevation[i + 1]!;
  const c = field.elevation[i + field.grid]!;
  const d = field.elevation[i + field.grid + 1]!;
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

export function plotIdAt(field: Field, x: number, z: number): number {
  const scale = field.grid / field.world;
  const gx = Math.floor(x * scale);
  const gz = Math.floor(z * scale);
  if (gx < 0 || gz < 0 || gx >= field.grid || gz >= field.grid) return -1;
  return field.plotId[gz * field.grid + gx]!;
}

export function plotAt(field: Field, plots: Plot[], x: number, z: number): Plot | null {
  const scale = field.grid / field.world;
  const gx = Math.floor(x * scale);
  const gz = Math.floor(z * scale);
  if (gx < 0 || gz < 0 || gx >= field.grid || gz >= field.grid) return null;
  const id = field.plotId[gz * field.grid + gx]!;
  return id >= 0 ? (plots[id] ?? null) : null;
}
