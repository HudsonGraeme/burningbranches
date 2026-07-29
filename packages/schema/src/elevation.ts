import { fbm2D } from './noise.js';
import type { Rect, Terrain } from './types.js';

/** Metres of rise per directory level. Nesting reads as altitude, so deep code sits uphill. */
const DEPTH_STEP = 6.5;
const RELIEF = 26;
const NOISE_SCALE = 3.1;

/** Worked ground sits lower than the surrounding forest, which cuts real valleys into hot spots. */
const TERRAIN_OFFSET: Record<Terrain, number> = {
  burning: -2.2,
  ash: -1.8,
  dirt: -2.6,
  grass: -0.4,
  scrub: 0,
  sapling: 0.2,
  youngForest: 0.6,
  matureForest: 1.1,
  oldGrowth: 1.6,
};

export function elevationFor(
  seed: number,
  rect: Rect,
  depth: number,
  terrain: Terrain,
  worldSize: number,
): number {
  const cx = (rect[0] + rect[2] / 2) / worldSize;
  const cy = (rect[1] + rect[3] / 2) / worldSize;
  const base = depth * DEPTH_STEP;
  const relief = fbm2D(seed, cx * NOISE_SCALE, cy * NOISE_SCALE, 4) * RELIEF;
  return base + relief + (TERRAIN_OFFSET[terrain] ?? 0);
}
