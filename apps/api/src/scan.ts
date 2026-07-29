import { isGenerated, type BiomeManifest, type ScanProgress, type TimelineBucket } from '@burningbranches/schema';
import {
  COMPARE_COMMIT_CAP,
  COMPARE_FILE_CAP,
  GitHub,
  GitHubError,
  commitDate,
  type CompareChange,
} from './github.js';
import { buildManifest, emptyStat, type PathStat } from './manifest.js';
import { buildWindows, ignitionCutoff, recentCutoff, windowCount, type WindowSpec } from './windows.js';

const POOL = 6;
const MAX_SPLIT_DEPTH = 2;
const REQUEST_BUDGET = 640;

export interface ScanDeps {
  gh: GitHub;
  signal: AbortSignal;
  onProgress: (progress: ScanProgress) => void;
}

export interface ScanResult {
  manifest: BiomeManifest;
  headCommittedAt: string;
}

export async function scanRepo(
  deps: ScanDeps,
  owner: string,
  name: string,
  maxPlots: number,
): Promise<ScanResult> {
  const { gh, signal, onProgress } = deps;

  onProgress({ phase: 'meta', pct: 0.02, message: 'Locating the repository' });
  const repo = await gh.repo(owner, name, signal);
  const branch = repo.default_branch;

  const { head, count } = await gh.headAndCount(owner, name, branch, signal);
  const headDate = commitDate(head);

  onProgress({ phase: 'timeline', pct: 0.08, message: `Reading ${count.toLocaleString()} commits` });
  const first = count > 1 ? await gh.commitAtPage(owner, name, branch, count, signal) : head;
  const firstDate = first ? commitDate(first) : headDate;

  const spanMs = Math.max(headDate.getTime() - firstDate.getTime(), 3600_000);
  const windows = buildWindows(firstDate, headDate, windowCount(spanMs, count));

  onProgress({
    phase: 'timeline',
    pct: 0.12,
    message: `Sampling ${windows.length} eras of history`,
  });

  const boundaries = await resolveBoundaries(deps, owner, name, branch, windows, head.sha, first?.sha ?? head.sha);

  onProgress({ phase: 'tree', pct: 0.34, message: 'Surveying the current tree' });
  const tree = await gh.tree(owner, name, head.sha, signal);
  const living = new Map<string, number>();
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    if (isGenerated(entry.path)) continue;
    living.set(entry.path, entry.size ?? 512);
  }
  if (living.size === 0) {
    throw new GitHubError({ code: 'empty_repo', message: 'No files found at HEAD.' }, 409);
  }

  onProgress({ phase: 'history', pct: 0.38, message: 'Replaying the history' });
  const changes = await collectChanges(deps, owner, name, windows, boundaries, onProgress);

  onProgress({ phase: 'growing', pct: 0.86, message: 'Growing the biome' });
  const spanEndMs = headDate.getTime();
  const spanStartMs = firstDate.getTime();
  const nowMs = Date.now();

  // A repository whose history was rewritten still existed before its first reachable
  // commit, so the project's own birthday is the older of the two.
  const projectBirthMs = Math.min(spanStartMs, new Date(repo.created_at).getTime());
  const projectAgeMs = Math.max(3600_000, nowMs - projectBirthMs);

  // Recency is wall clock, not commit clock. An abandoned repository must stop burning.
  const recentMs = recentCutoff(projectAgeMs, nowMs);
  const igniteMs = ignitionCutoff(projectAgeMs, nowMs);

  const { stats, timeline } = accumulate(windows, changes, recentMs, igniteMs);

  const manifest = buildManifest({
    repo: {
      owner,
      name: repo.name,
      branch,
      headSha: head.sha,
      description: repo.description,
      license: repo.license?.spdx_id ?? null,
      stars: repo.stargazers_count,
      createdAt: repo.created_at,
      pushedAt: repo.pushed_at,
      firstCommitAt: firstDate.toISOString(),
      htmlUrl: repo.html_url,
    },
    scan: {
      windows: windows.length,
      windowSeconds: Math.round(spanMs / windows.length / 1000),
      spanStart: firstDate.toISOString(),
      spanEnd: headDate.toISOString(),
      generatedAt: new Date().toISOString(),
      requestsSpent: gh.requests,
      truncatedWindows: changes.truncated,
      skippedWindows: changes.skipped,
      treeTruncated: tree.truncated,
    },
    windows,
    stats,
    living,
    timeline,
    spanStartMs,
    spanEndMs,
    nowMs,
    projectBirthMs,
    ignitionCutoffMs: igniteMs,
    maxPlots,
  });

  return { manifest, headCommittedAt: headDate.toISOString() };
}

async function resolveBoundaries(
  deps: ScanDeps,
  owner: string,
  name: string,
  branch: string,
  windows: WindowSpec[],
  headSha: string,
  firstSha: string,
): Promise<(string | null)[]> {
  const { gh, signal, onProgress } = deps;
  const boundaries: (string | null)[] = new Array(windows.length + 1).fill(null);
  boundaries[0] = firstSha;
  boundaries[windows.length] = headSha;

  const targets: number[] = [];
  for (let i = 1; i < windows.length; i++) targets.push(i);

  let done = 0;
  await pool(targets, POOL, async (i) => {
    const commit = await gh.commitBefore(owner, name, branch, windows[i]!.start, signal);
    boundaries[i] = commit?.sha ?? null;
    done++;
    if (done % 8 === 0) {
      onProgress({
        phase: 'timeline',
        pct: 0.12 + 0.22 * (done / Math.max(1, targets.length)),
        message: `Pinning era ${done} of ${targets.length}`,
      });
    }
  });

  // A quiet stretch resolves to the same commit on both sides. Carrying the previous sha
  // forward turns those into zero cost windows instead of pointless compares.
  for (let i = 1; i < boundaries.length; i++) {
    if (!boundaries[i]) boundaries[i] = boundaries[i - 1] ?? null;
  }
  return boundaries;
}

interface WindowChanges {
  perWindow: Map<number, CompareChange[]>;
  truncated: number;
  skipped: number;
}

async function collectChanges(
  deps: ScanDeps,
  owner: string,
  name: string,
  windows: WindowSpec[],
  boundaries: (string | null)[],
  onProgress: (p: ScanProgress) => void,
): Promise<WindowChanges> {
  const perWindow = new Map<number, CompareChange[]>();
  let truncated = 0;
  let skipped = 0;
  let done = 0;

  const jobs = windows
    .map((window, i) => ({ window, base: boundaries[i]!, head: boundaries[i + 1]! }))
    .filter((job) => job.base && job.head && job.base !== job.head);

  await pool(jobs, POOL, async (job) => {
    const files = await compareDeep(deps, owner, name, job.base, job.head, job.window, 0);
    if (files.truncated) truncated++;
    if (files.skipped) skipped++;
    perWindow.set(job.window.index, files.files);
    done++;
    onProgress({
      phase: 'history',
      pct: 0.38 + 0.46 * (done / Math.max(1, jobs.length)),
      message: `Replaying era ${done} of ${jobs.length}`,
    });
  });

  if (skipped > 0) {
    console.warn(`skipped ${skipped} of ${jobs.length} eras with no common ancestor`);
  }
  return { perWindow, truncated, skipped };
}

async function compareDeep(
  deps: ScanDeps,
  owner: string,
  name: string,
  base: string,
  head: string,
  window: WindowSpec,
  depth: number,
): Promise<{ files: CompareChange[]; truncated: boolean; skipped: boolean }> {
  const { gh, signal } = deps;
  if (gh.requests > REQUEST_BUDGET) return { files: [], truncated: true, skipped: false };

  const result = await gh.compare(owner, name, base, head, signal);
  if (!result) return { files: [], truncated: true, skipped: true };

  const files = result.files ?? [];
  const capped = files.length >= COMPARE_FILE_CAP || result.totalCommits >= COMPARE_COMMIT_CAP;

  if (!capped || depth >= MAX_SPLIT_DEPTH) {
    return { files, truncated: capped, skipped: false };
  }

  // The window is denser than one compare can describe. Split it in time and ask again so
  // busy periods do not silently lose the files that changed inside them.
  const midTime = new Date((window.start.getTime() + window.end.getTime()) / 2);
  const mid = await gh.commitBefore(owner, name, head, midTime, signal);
  if (!mid || mid.sha === base || mid.sha === head) {
    return { files, truncated: true, skipped: false };
  }

  const left = await compareDeep(deps, owner, name, base, mid.sha, { ...window, end: midTime }, depth + 1);
  const right = await compareDeep(deps, owner, name, mid.sha, head, { ...window, start: midTime }, depth + 1);

  // Half a split failing on a grafted boundary still leaves the other half usable.
  return {
    files: [...left.files, ...right.files],
    truncated: left.truncated || right.truncated,
    skipped: left.skipped && right.skipped,
  };
}

function accumulate(
  windows: WindowSpec[],
  changes: WindowChanges,
  recentMs: number,
  igniteMs: number,
): { stats: Map<string, PathStat>; timeline: TimelineBucket[] } {
  const stats = new Map<string, PathStat>();
  const alias = new Map<string, string>();
  const timeline: TimelineBucket[] = new Array(windows.length);

  // Newest first, so a rename learned in a recent window can be projected onto every older
  // window where the path still had its previous name.
  for (let i = windows.length - 1; i >= 0; i--) {
    const window = windows[i]!;
    const files = changes.perWindow.get(window.index) ?? [];
    const durationMs = Math.max(1, window.end.getTime() - window.start.getTime());
    const endMs = window.end.getTime();
    const isRecent = endMs >= recentMs;
    const isIgnition = endMs >= igniteMs;

    let added = 0;
    let deleted = 0;

    for (const file of files) {
      const canonical = alias.get(file.filename) ?? file.filename;
      if (file.previous_filename) alias.set(file.previous_filename, canonical);
      if (isGenerated(canonical)) continue;

      let stat = stats.get(canonical);
      if (!stat) {
        stat = emptyStat();
        stats.set(canonical, stat);
      }

      stat.add += file.additions;
      stat.del += file.deletions;
      added += file.additions;
      deleted += file.deletions;

      if (isRecent) {
        stat.recentAdd += file.additions;
        stat.recentDel += file.deletions;
      }
      if (isIgnition) {
        stat.igniteAdd += file.additions;
        stat.igniteDel += file.deletions;
      }

      stat.touches += 1;
      stat.touchedMs += durationMs;
      stat.firstWindow = Math.min(stat.firstWindow, window.index);
      if (stat.lastWindow < 0) {
        stat.lastWindow = window.index;
        stat.lastTouchMs = endMs;
      }
      if (file.status === 'added' && !stat.born) {
        stat.born = true;
        stat.birthMs = window.start.getTime();
        stat.birthWindowMs = durationMs;
      }
      if (file.status === 'removed' && !stat.removedMs) {
        stat.removedMs = endMs;
      }
    }

    timeline[i] = {
      at: window.end.toISOString(),
      added,
      deleted,
      files: files.length,
    };
  }

  return { stats, timeline };
}

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const width = Math.min(size, items.length);
  for (let i = 0; i < width; i++) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor++;
          await worker(items[index]!);
        }
      })(),
    );
  }
  await Promise.all(runners);
}
