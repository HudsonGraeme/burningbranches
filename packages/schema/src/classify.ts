import type { Biome, PlotMetrics, Terrain } from './types.js';
import { DEAD_SPECIES, heightAt, speciesAt, speciesIndexForPath } from './growth.js';
import { clamp01, hashUnit, smoothstep } from './hash.js';

/**
 * Repeated disturbance does not just reset the clock, it degrades the site. A path that
 * churns constantly never gets past scrub even during a quiet spell, which is what makes
 * hot spots read as bare ground instead of young forest.
 */
const DISTURBANCE_PENALTY = 0.6;

const FIRE_THRESHOLD = 0.22;
const ASH_THRESHOLD = 0.3;
const DIRT_VOLATILITY = 0.5;

export interface ClassifyInput {
  path: string;
  metrics: PlotMetrics;
  projectAgeYears: number;
}

export function classify({ path, metrics, projectAgeYears }: ClassifyInput): Biome {
  const dead = !metrics.alive;
  const speciesIndex = speciesIndexForPath(path);
  const species = dead ? DEAD_SPECIES : speciesAt(speciesIndex);

  const burn = dead ? 1 : clamp01(metrics.destruction);
  const fire = dead ? clamp01(metrics.ignition * 1.35) : clamp01(metrics.ignition);

  // Growth runs from the last disturbance, never beyond the project's own lifetime.
  const dormant = Math.min(metrics.dormantYears, projectAgeYears);
  const growthYears = Math.max(0, dormant * (1 - DISTURBANCE_PENALTY * clamp01(metrics.volatility)));

  const rawHeight = heightAt(species, growthYears);
  // Burnt ground keeps its snags standing but strips the canopy.
  const treeHeight = rawHeight * (dead ? 0.55 : 1 - 0.7 * burn);

  const establishment = smoothstep(0.15, 2.5, growthYears);
  const density = clamp01(
    (1 - 0.85 * clamp01(metrics.volatility)) * (1 - 0.9 * burn) * establishment,
  );

  const moisture = clamp01(
    0.25 +
      0.5 * (1 - clamp01(metrics.volatility)) +
      0.2 * (hashUnit(path, 7) - 0.5) -
      0.45 * burn,
  );

  return {
    terrain: terrainFor({ metrics, burn, fire, treeHeight, density, moisture }),
    canopyType: species.canopy,
    density,
    treeHeight,
    burn,
    fire,
    moisture,
  };
}

interface TerrainInput {
  metrics: PlotMetrics;
  burn: number;
  fire: number;
  treeHeight: number;
  density: number;
  moisture: number;
}

function terrainFor({ metrics, burn, fire, treeHeight, density, moisture }: TerrainInput): Terrain {
  if (fire > FIRE_THRESHOLD) return 'burning';
  if (burn > ASH_THRESHOLD) return 'ash';
  if (metrics.volatility > DIRT_VOLATILITY) return 'dirt';
  if (treeHeight < 0.4 || density < 0.05) return moisture > 0.5 ? 'grass' : 'dirt';
  if (treeHeight < 1.5) return 'scrub';
  if (treeHeight < 4) return 'sapling';
  if (treeHeight < 12) return 'youngForest';
  if (treeHeight < 26) return 'matureForest';
  return 'oldGrowth';
}

export const TERRAIN_ORDER: readonly Terrain[] = [
  'burning',
  'ash',
  'dirt',
  'grass',
  'scrub',
  'sapling',
  'youngForest',
  'matureForest',
  'oldGrowth',
];

export const TERRAIN_LABEL: Record<Terrain, string> = {
  burning: 'Burning',
  ash: 'Ash and char',
  dirt: 'Bare earth',
  grass: 'Grassland',
  scrub: 'Scrub',
  sapling: 'Saplings',
  youngForest: 'Young forest',
  matureForest: 'Mature forest',
  oldGrowth: 'Old growth',
};

export const TERRAIN_HINT: Record<Terrain, string> = {
  burning: 'Torn out or rewritten right now',
  ash: 'Recently stripped and replaced',
  dirt: 'Churns in almost every window',
  grass: 'Young or lightly worked',
  scrub: 'Settling after recent work',
  sapling: 'Quiet for a year or two',
  youngForest: 'Untouched for a few years',
  matureForest: 'Untouched for most of the project',
  oldGrowth: 'Original code, never disturbed',
};

/** Ground albedo per terrain, shared by the terrain shader and the legend. */
export const TERRAIN_COLOR: Record<Terrain, number> = {
  burning: 0x2a1410,
  ash: 0x3a3532,
  dirt: 0x6b5334,
  grass: 0x6f8f3e,
  scrub: 0x63803c,
  sapling: 0x577a38,
  youngForest: 0x44682f,
  matureForest: 0x33532a,
  oldGrowth: 0x27431f,
};
