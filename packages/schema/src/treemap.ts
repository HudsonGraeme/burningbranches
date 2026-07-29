import type { Rect } from './types.js';

export interface TreemapLeaf {
  path: string;
  weight: number;
}

export interface TreemapResult {
  leaves: Map<string, Rect>;
  regions: { path: string; depth: number; rect: Rect; weight: number; files: number }[];
}

interface Node {
  name: string;
  path: string;
  weight: number;
  files: number;
  children: Map<string, Node> | null;
}

/**
 * Raw byte counts make one vendored bundle swallow the whole map, so area is compressed.
 * The ordering of significance survives, the extremes stop dominating.
 */
const WEIGHT_EXPONENT = 0.65;
const MIN_BYTES = 220;

export function compressWeight(bytes: number): number {
  return Math.pow(Math.max(bytes, MIN_BYTES), WEIGHT_EXPONENT);
}

/**
 * Firebreaks between directories. Shallow boundaries get wider gaps so the top level
 * territories stay legible from altitude.
 */
function paddingFor(depth: number, rect: Rect): number {
  const budget = Math.min(rect[2], rect[3]);
  const wanted = Math.max(0.4, 5 / (depth + 1));
  return Math.min(wanted, budget * 0.06);
}

export function buildTreemap(leaves: TreemapLeaf[], size: number): TreemapResult {
  const root: Node = { name: '', path: '', weight: 0, files: 0, children: new Map() };

  for (const leaf of leaves) {
    const parts = leaf.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i]!;
      const childPath = node.path ? `${node.path}/${name}` : name;
      let children = node.children;
      if (!children) {
        children = new Map();
        node.children = children;
      }
      let next = children.get(name);
      if (!next) {
        next = {
          name,
          path: childPath,
          weight: 0,
          files: 0,
          children: isLeaf ? null : new Map(),
        };
        children.set(name, next);
      }
      node = next;
    }
    node.children = null;
    node.weight += leaf.weight;
    node.files += 1;
  }

  rollup(root);

  const result: TreemapResult = { leaves: new Map(), regions: [] };
  layout(root, [0, 0, size, size], 0, result);
  return result;
}

function rollup(node: Node): { weight: number; files: number } {
  if (!node.children) return { weight: node.weight, files: node.files };
  let weight = 0;
  let files = 0;
  for (const child of node.children.values()) {
    const sub = rollup(child);
    weight += sub.weight;
    files += sub.files;
  }
  node.weight = weight;
  node.files = files;
  return { weight, files };
}

function layout(node: Node, rect: Rect, depth: number, out: TreemapResult): void {
  if (!node.children) {
    out.leaves.set(node.path, rect);
    return;
  }

  if (node.path) {
    out.regions.push({
      path: node.path,
      depth,
      rect,
      weight: node.weight,
      files: node.files,
    });
  }

  const pad = depth === 0 ? 0 : paddingFor(depth, rect);
  const inner: Rect = [
    rect[0] + pad,
    rect[1] + pad,
    Math.max(0.01, rect[2] - pad * 2),
    Math.max(0.01, rect[3] - pad * 2),
  ];

  const children = [...node.children.values()].sort((a, b) => b.weight - a.weight);
  const rects = squarify(
    children.map((c) => c.weight),
    inner,
  );

  for (let i = 0; i < children.length; i++) {
    const childRect = rects[i];
    if (!childRect) continue;
    layout(children[i]!, childRect, depth + 1, out);
  }
}

/**
 * Bruls, Huizing and van Wijk squarified treemap. Rows are grown while the worst aspect
 * ratio keeps improving, which keeps plots close to square and therefore plantable.
 */
function squarify(weights: number[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(weights.length);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    for (let i = 0; i < weights.length; i++) out[i] = [rect[0], rect[1], 0, 0];
    return out;
  }

  const area = rect[2] * rect[3];
  const scaled = weights.map((w) => (w / total) * area);

  let x = rect[0];
  let y = rect[1];
  let w = rect[2];
  let h = rect[3];
  let index = 0;

  while (index < scaled.length) {
    const row: number[] = [];
    let rowSum = 0;
    let best = Number.POSITIVE_INFINITY;
    let cursor = index;

    while (cursor < scaled.length) {
      const candidate = scaled[cursor]!;
      const nextSum = rowSum + candidate;
      const short = Math.min(w, h);
      const ratio = worstRatio(
        row.length === 0 ? [candidate] : [...row, candidate],
        nextSum,
        short,
      );
      if (row.length > 0 && ratio > best) break;
      row.push(candidate);
      rowSum = nextSum;
      best = ratio;
      cursor++;
    }

    const short = Math.min(w, h);
    const thickness = short > 0 ? rowSum / short : 0;

    if (w >= h) {
      let cy = y;
      for (let i = 0; i < row.length; i++) {
        const cellH = rowSum > 0 ? (row[i]! / rowSum) * h : 0;
        out[index + i] = [x, cy, thickness, cellH];
        cy += cellH;
      }
      x += thickness;
      w = Math.max(0, w - thickness);
    } else {
      let cx = x;
      for (let i = 0; i < row.length; i++) {
        const cellW = rowSum > 0 ? (row[i]! / rowSum) * w : 0;
        out[index + i] = [cx, y, cellW, thickness];
        cx += cellW;
      }
      y += thickness;
      h = Math.max(0, h - thickness);
    }

    index += row.length;
  }

  for (let i = 0; i < out.length; i++) {
    if (!out[i]) out[i] = [rect[0], rect[1], 0, 0];
  }
  return out;
}

function worstRatio(row: number[], sum: number, short: number): number {
  if (sum <= 0 || short <= 0) return Number.POSITIVE_INFINITY;
  const side = sum / short;
  let worst = 0;
  for (const value of row) {
    if (value <= 0) continue;
    const other = value / side;
    worst = Math.max(worst, Math.max(side / other, other / side));
  }
  return worst || Number.POSITIVE_INFINITY;
}
