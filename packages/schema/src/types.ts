export const MANIFEST_VERSION = 3;

export const WORLD_SIZE = 1000;

export type Terrain =
  | 'burning'
  | 'ash'
  | 'dirt'
  | 'grass'
  | 'scrub'
  | 'sapling'
  | 'youngForest'
  | 'matureForest'
  | 'oldGrowth';

export type Canopy = 'conifer' | 'broadleaf' | 'birch' | 'palm' | 'dead';

export interface RepoRef {
  owner: string;
  name: string;
  branch: string;
}

export interface RepoMeta extends RepoRef {
  headSha: string;
  description: string | null;
  license: string | null;
  stars: number;
  createdAt: string;
  pushedAt: string;
  firstCommitAt: string;
  htmlUrl: string;
}

export interface ScanInfo {
  windows: number;
  windowSeconds: number;
  spanStart: string;
  spanEnd: string;
  generatedAt: string;
  filesTracked: number;
  ghostsTracked: number;
  requestsSpent: number;
  truncatedWindows: number;
  treeTruncated: boolean;
}

export interface PlotMetrics {
  /** Window index in which the path first appeared. 0 means it predates the scan. */
  bornWindow: number;
  /** Window index of the most recent observed edit, or -1 if never edited after birth. */
  lastWindow: number;
  ageYears: number;
  dormantYears: number;
  /** Distinct scan windows in which the path changed. */
  touches: number;
  /** touches divided by windows lived. 0 = untouched since birth, 1 = changed in every window. */
  volatility: number;
  addedLines: number;
  deletedLines: number;
  recentAdded: number;
  recentDeleted: number;
  /** 0..1 share of the path that was torn out during the recent window band. */
  destruction: number;
  /** 0..1 destruction concentrated in the final windows. */
  ignition: number;
  /** True when the path exists at HEAD; false for recently deleted scars. */
  alive: boolean;
}

export interface Biome {
  terrain: Terrain;
  canopyType: Canopy;
  /** 0..1 vegetation density used to seed instances. */
  density: number;
  /** Metres. Capped by a growth curve against dormant time and project age. */
  treeHeight: number;
  /** 0..1 char and ash coverage. */
  burn: number;
  /** 0..1 live flame intensity. */
  fire: number;
  /** 0..1 ground moisture, drives grass and ground colour. */
  moisture: number;
}

/** Axis aligned rectangle in world metres: x, z, width, depth. */
export type Rect = [number, number, number, number];

export interface Plot {
  id: number;
  path: string;
  ext: string;
  bytes: number;
  depth: number;
  rect: Rect;
  elevation: number;
  metrics: PlotMetrics;
  biome: Biome;
}

export interface Region {
  path: string;
  depth: number;
  rect: Rect;
  bytes: number;
  files: number;
}

export interface BiomeManifest {
  version: number;
  repo: RepoMeta;
  scan: ScanInfo;
  world: { size: number; maxElevation: number };
  timeline: TimelineBucket[];
  plots: Plot[];
  regions: Region[];
}

export interface TimelineBucket {
  at: string;
  added: number;
  deleted: number;
  files: number;
}

export type ScanPhase =
  | 'queued'
  | 'meta'
  | 'timeline'
  | 'tree'
  | 'history'
  | 'growing'
  | 'done'
  | 'error';

export interface ScanProgress {
  phase: ScanPhase;
  pct: number;
  message: string;
}

export interface ScanFailure {
  code:
    | 'not_found'
    | 'empty_repo'
    | 'too_large'
    | 'rate_limited'
    | 'upstream'
    | 'bad_request'
    | 'internal';
  message: string;
}
