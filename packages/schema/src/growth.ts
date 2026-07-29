import type { Canopy } from './types.js';
import { hashString } from './hash.js';

export interface Species {
  canopy: Canopy;
  /** Asymptotic height in metres. */
  hMax: number;
  /** Growth rate constant, per year. */
  k: number;
  /** Shape exponent. Above 1 produces the slow juvenile phase real stands show. */
  p: number;
  /** Crown radius as a fraction of height at maturity. */
  crown: number;
  /** Stems per hectare at full canopy closure. Drives instance counts. */
  stemsPerHa: number;
  trunk: number;
  foliage: number;
}

/**
 * Chapman-Richards growth. These constants are fitted to real closed-canopy stands so a
 * repo's forest reads at the right scale: a one year old project shows knee-high saplings,
 * a fifteen year old untouched module shows a twenty five metre canopy.
 */
export const SPECIES: readonly Species[] = [
  {
    canopy: 'conifer',
    hMax: 46,
    k: 0.062,
    p: 1.35,
    crown: 0.18,
    stemsPerHa: 620,
    trunk: 0x4a3b2c,
    foliage: 0x2f5d3a,
  },
  {
    canopy: 'broadleaf',
    hMax: 34,
    k: 0.085,
    p: 1.5,
    crown: 0.42,
    stemsPerHa: 380,
    trunk: 0x5a4433,
    foliage: 0x4c7a32,
  },
  {
    canopy: 'birch',
    hMax: 24,
    k: 0.14,
    p: 1.6,
    crown: 0.3,
    stemsPerHa: 900,
    trunk: 0xc8c4b6,
    foliage: 0x7fa63f,
  },
  {
    canopy: 'palm',
    hMax: 20,
    k: 0.11,
    p: 1.2,
    crown: 0.5,
    stemsPerHa: 240,
    trunk: 0x7a6a4a,
    foliage: 0x3f8a4a,
  },
];

export const DEAD_SPECIES: Species = {
  canopy: 'dead',
  hMax: 30,
  k: 0.08,
  p: 1.4,
  crown: 0.12,
  stemsPerHa: 300,
  trunk: 0x241c18,
  foliage: 0x1a1512,
};

export function speciesAt(index: number): Species {
  return SPECIES[index % SPECIES.length] ?? SPECIES[0]!;
}

/**
 * Each top level directory gets its own forest character so the map reads as distinct
 * territories rather than one uniform woodland.
 */
export function speciesIndexForPath(path: string): number {
  const top = path.split('/')[0] ?? '';
  return hashString(top) % SPECIES.length;
}

export function heightAt(species: Species, years: number): number {
  if (years <= 0) return 0;
  const base = 1 - Math.exp(-species.k * years);
  return species.hMax * Math.pow(base, species.p);
}

/** Inverse of heightAt, used to render the legend's age axis. */
export function yearsForHeight(species: Species, height: number): number {
  const ratio = Math.min(0.9999, Math.max(0, height / species.hMax));
  const base = Math.pow(ratio, 1 / species.p);
  return -Math.log(1 - base) / species.k;
}
