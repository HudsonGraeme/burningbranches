const DAY = 86_400_000;

/**
 * History is sampled on a geometric schedule rather than a uniform one. Recent months get
 * narrow windows so a rewrite last week reads as an active fire, while the deep past gets
 * wide windows because all we need from it is "nothing has happened here in years".
 */
const GAMMA = 1.6;
const MIN_WINDOW_MS = 6 * 3600_000;

export interface WindowSpec {
  index: number;
  start: Date;
  end: Date;
}

export function windowCount(spanMs: number, commits: number): number {
  const years = spanMs / (365.25 * DAY);
  const byAge = Math.round(28 + years * 7);
  const byCommits = Math.round(Math.sqrt(Math.max(commits, 1)) * 4);
  return Math.max(20, Math.min(112, Math.min(byAge, byCommits) || 20));
}

export function buildWindows(start: Date, end: Date, count: number): WindowSpec[] {
  const spanMs = Math.max(end.getTime() - start.getTime(), MIN_WINDOW_MS);
  const endMs = end.getTime();

  const boundaries: number[] = [];
  for (let i = 0; i <= count; i++) {
    const back = spanMs * Math.pow((count - i) / count, GAMMA);
    boundaries.push(endMs - back);
  }

  const windows: WindowSpec[] = [];
  for (let i = 0; i < count; i++) {
    const a = boundaries[i]!;
    const b = boundaries[i + 1]!;
    if (b - a < MIN_WINDOW_MS && i !== count - 1) continue;
    windows.push({ index: windows.length, start: new Date(a), end: new Date(b) });
  }
  return windows;
}

/**
 * Windows whose end falls inside this band feed the burn signal. The band is anchored to
 * wall clock, so a repository that stopped moving a year ago has nothing left in it.
 */
export function recentCutoff(projectAgeMs: number, nowMs: number): number {
  const band = Math.min(180 * DAY, Math.max(14 * DAY, projectAgeMs * 0.15));
  return nowMs - band;
}

/** Windows inside this tighter band are still alight. */
export function ignitionCutoff(projectAgeMs: number, nowMs: number): number {
  const band = Math.min(45 * DAY, Math.max(3 * DAY, projectAgeMs * 0.04));
  return nowMs - band;
}
