import { hashString } from './hash.js';

function valueAt(seed: number, xi: number, yi: number): number {
  let h = seed ^ Math.imul(xi | 0, 0x27d4eb2d) ^ Math.imul(yi | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise2D(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const a = valueAt(seed, xi, yi);
  const b = valueAt(seed, xi + 1, yi);
  const c = valueAt(seed, xi, yi + 1);
  const d = valueAt(seed, xi + 1, yi + 1);
  const top = a + (b - a) * xf;
  const bottom = c + (d - c) * xf;
  return top + (bottom - top) * yf;
}

export function fbm2D(seed: number, x: number, y: number, octaves = 4): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise2D(seed + i * 1013, x * frequency, y * frequency);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return norm > 0 ? sum / norm : 0;
}

export function seedFor(text: string): number {
  return hashString(text) | 0;
}
