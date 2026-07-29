import {
  MANIFEST_VERSION,
  WORLD_SIZE,
  buildTreemap,
  capWeights,
  classify,
  clamp01,
  compressWeight,
  elevationFor,
  seedFor,
  type BiomeManifest,
  type Plot,
  type PlotMetrics,
  type Region,
  type RepoMeta,
  type ScanInfo,
  type TimelineBucket,
} from '@burningbranches/schema';
import type { WindowSpec } from './windows.js';

const YEAR_MS = 365.25 * 86_400_000;
/** Bytes per line, averaged across source. Turns tree sizes into a line budget. */
const BYTES_PER_LINE = 38;

export interface PathStat {
  add: number;
  del: number;
  recentAdd: number;
  recentDel: number;
  igniteAdd: number;
  igniteDel: number;
  touches: number;
  touchedMs: number;
  /** Duration of the window the path was created in, discounted from churn. */
  birthWindowMs: number;
  firstWindow: number;
  lastWindow: number;
  birthMs: number;
  lastTouchMs: number;
  born: boolean;
  removedMs: number;
}

export function emptyStat(): PathStat {
  return {
    add: 0,
    del: 0,
    recentAdd: 0,
    recentDel: 0,
    igniteAdd: 0,
    igniteDel: 0,
    touches: 0,
    touchedMs: 0,
    birthWindowMs: 0,
    firstWindow: Number.POSITIVE_INFINITY,
    lastWindow: -1,
    birthMs: 0,
    lastTouchMs: 0,
    born: false,
    removedMs: 0,
  };
}

export interface BuildInput {
  repo: RepoMeta;
  scan: Omit<ScanInfo, 'filesTracked' | 'ghostsTracked'>;
  windows: WindowSpec[];
  stats: Map<string, PathStat>;
  /** Path to byte size at HEAD. */
  living: Map<string, number>;
  timeline: TimelineBucket[];
  spanStartMs: number;
  spanEndMs: number;
  /**
   * Wall clock at scan time. Forests keep growing after the last commit lands, so maturity
   * and burn recency are both measured against now rather than against HEAD's date.
   */
  nowMs: number;
  /** Repository creation, which caps how mature any stand on the map is allowed to be. */
  projectBirthMs: number;
  ignitionCutoffMs: number;
  maxPlots: number;
}

interface Candidate {
  path: string;
  bytes: number;
  metrics: PlotMetrics;
  aggregate: number;
}

export function buildManifest(input: BuildInput): BiomeManifest {
  const { repo, living, stats, nowMs, projectBirthMs, maxPlots } = input;
  const projectAgeYears = Math.max(0.02, (nowMs - projectBirthMs) / YEAR_MS);

  const candidates: Candidate[] = [];

  for (const [path, bytes] of living) {
    const stat = stats.get(path);
    candidates.push({
      path,
      bytes,
      metrics: metricsFor(path, bytes, stat, input, true),
      aggregate: 1,
    });
  }

  // Files torn out inside the recent band stay on the map as scars. Without them a deleted
  // module would silently vanish rather than leaving burnt ground behind.
  for (const [path, stat] of stats) {
    if (living.has(path)) continue;
    if (!stat.removedMs || stat.removedMs < input.nowMs - RECENT_SCAR_MS(input)) continue;
    const bytes = Math.max(220, stat.del * BYTES_PER_LINE);
    candidates.push({
      path,
      bytes,
      metrics: metricsFor(path, bytes, stat, input, false),
      aggregate: 1,
    });
  }

  const plotsInput = collapse(candidates, maxPlots);

  const capped = capWeights(plotsInput.map((c) => compressWeight(c.bytes)));
  const tree = buildTreemap(
    plotsInput.map((c, i) => ({ path: c.path, weight: capped[i]! })),
    WORLD_SIZE,
  );

  const seed = seedFor(`${repo.owner}/${repo.name}`);
  const plots: Plot[] = [];
  let maxElevation = 0;

  for (let i = 0; i < plotsInput.length; i++) {
    const candidate = plotsInput[i]!;
    const rect = tree.leaves.get(candidate.path);
    if (!rect || rect[2] <= 0 || rect[3] <= 0) continue;
    const depth = candidate.path.split('/').length - 1;
    const biome = classify({
      path: candidate.path,
      metrics: candidate.metrics,
      projectAgeYears,
    });
    const elevation = elevationFor(seed, rect, depth, biome.terrain, WORLD_SIZE);
    maxElevation = Math.max(maxElevation, elevation);
    plots.push({
      id: plots.length,
      path: candidate.path,
      ext: extensionOf(candidate.path),
      bytes: candidate.bytes,
      depth,
      rect,
      elevation,
      metrics: candidate.metrics,
      biome,
    });
  }

  const regions: Region[] = tree.regions
    .filter((r) => r.depth <= 3 && r.rect[2] > 12 && r.rect[3] > 12)
    .map((r) => ({ path: r.path, depth: r.depth, rect: r.rect, bytes: r.weight, files: r.files }));

  const ghosts = plotsInput.filter((c) => !c.metrics.alive).length;

  return {
    version: MANIFEST_VERSION,
    repo,
    scan: { ...input.scan, filesTracked: plots.length, ghostsTracked: ghosts },
    world: { size: WORLD_SIZE, maxElevation },
    timeline: input.timeline,
    plots,
    regions,
  };
}

function RECENT_SCAR_MS(input: BuildInput): number {
  const age = input.nowMs - input.projectBirthMs;
  return Math.min(180 * 86_400_000, Math.max(14 * 86_400_000, age * 0.15));
}

function metricsFor(
  path: string,
  bytes: number,
  stat: PathStat | undefined,
  input: BuildInput,
  alive: boolean,
): PlotMetrics {
  const { nowMs, spanStartMs } = input;
  const lines = Math.max(1, bytes / BYTES_PER_LINE);

  if (!stat) {
    // Present at HEAD but never seen changing: it has been there since the first commit.
    const ageYears = (nowMs - spanStartMs) / YEAR_MS;
    return {
      bornWindow: 0,
      lastWindow: -1,
      ageYears,
      dormantYears: ageYears,
      touches: 0,
      volatility: 0,
      addedLines: 0,
      deletedLines: 0,
      recentAdded: 0,
      recentDeleted: 0,
      destruction: 0,
      ignition: 0,
      alive,
    };
  }

  const birthMs = stat.born ? stat.birthMs : spanStartMs;
  const lastTouchMs = stat.lastTouchMs || birthMs;
  const ageYears = Math.max(0, (nowMs - birthMs) / YEAR_MS);
  const dormantYears = Math.max(0, (nowMs - lastTouchMs) / YEAR_MS);

  // The window a file was created in is not churn, it is the file appearing. Counting it
  // would brand every newborn path as constantly rewritten ground.
  const churnedMs = Math.max(0, stat.touchedMs - stat.birthWindowMs);
  const livedMs = Math.max(1, nowMs - birthMs);
  const volatility = clamp01(churnedMs / livedMs);

  const destruction = alive ? clamp01(stat.recentDel / lines) : 1;
  const ignition = alive
    ? clamp01(stat.igniteDel / lines)
    : clamp01(1 - (nowMs - stat.removedMs) / Math.max(1, nowMs - input.ignitionCutoffMs));

  return {
    bornWindow: Number.isFinite(stat.firstWindow) ? stat.firstWindow : 0,
    lastWindow: stat.lastWindow,
    ageYears,
    dormantYears,
    touches: stat.touches,
    volatility,
    addedLines: stat.add,
    deletedLines: stat.del,
    recentAdded: stat.recentAdd,
    recentDeleted: stat.recentDel,
    destruction,
    ignition,
    alive,
  };
}

/**
 * Very large repos would ship a manifest no browser can plant. Anything burning or
 * recently disturbed is kept individually, then the biggest remaining files, then whatever
 * is left is merged per directory so the layout keeps its shape and its area.
 */
function collapse(candidates: Candidate[], maxPlots: number): Candidate[] {
  if (candidates.length <= maxPlots) return candidates;

  const interesting: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const c of candidates) {
    const hot = !c.metrics.alive || c.metrics.destruction > 0.12 || c.metrics.ignition > 0.05;
    (hot ? interesting : rest).push(c);
  }

  rest.sort((a, b) => b.bytes - a.bytes);
  const budget = Math.max(0, maxPlots - interesting.length);
  const kept = rest.slice(0, budget);
  const merged = rest.slice(budget);

  const groups = new Map<string, Candidate[]>();
  for (const c of merged) {
    const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '';
    const key = dir || '.';
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const aggregates: Candidate[] = [];
  for (const [dir, members] of groups) {
    const bytes = members.reduce((sum, m) => sum + m.bytes, 0);
    aggregates.push({
      path: `${dir === '.' ? '' : `${dir}/`}${members.length} more files`,
      bytes,
      metrics: mergeMetrics(members, bytes),
      aggregate: members.length,
    });
  }

  return [...interesting, ...kept, ...aggregates];
}

function mergeMetrics(members: Candidate[], totalBytes: number): PlotMetrics {
  const weight = (c: Candidate) => (totalBytes > 0 ? c.bytes / totalBytes : 1 / members.length);
  const acc: PlotMetrics = {
    bornWindow: 0,
    lastWindow: -1,
    ageYears: 0,
    dormantYears: 0,
    touches: 0,
    volatility: 0,
    addedLines: 0,
    deletedLines: 0,
    recentAdded: 0,
    recentDeleted: 0,
    destruction: 0,
    ignition: 0,
    alive: true,
  };
  for (const m of members) {
    const w = weight(m);
    acc.ageYears += m.metrics.ageYears * w;
    acc.dormantYears += m.metrics.dormantYears * w;
    acc.volatility += m.metrics.volatility * w;
    acc.destruction += m.metrics.destruction * w;
    acc.ignition += m.metrics.ignition * w;
    acc.touches += m.metrics.touches;
    acc.addedLines += m.metrics.addedLines;
    acc.deletedLines += m.metrics.deletedLines;
    acc.recentAdded += m.metrics.recentAdded;
    acc.recentDeleted += m.metrics.recentDeleted;
    acc.lastWindow = Math.max(acc.lastWindow, m.metrics.lastWindow);
  }
  return acc;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
