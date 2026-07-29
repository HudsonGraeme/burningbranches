import type { BiomeManifest, ScanFailure, ScanProgress } from '@burningbranches/schema';

export const API_BASE =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '' : 'https://api.burningbranches.dev');

export interface ReadyEvent {
  owner: string;
  name: string;
  headSha: string;
  headCommittedAt: string;
  scannedAt: string;
  nextRefreshAt: string;
  manifestUrl: string;
  cardUrl: string;
}

export interface ThrottledEvent {
  retryAfter: number;
  message: string;
}

export interface ScanHandlers {
  onProgress?: (progress: ScanProgress) => void;
  onCached?: (at: string) => void;
  onUnchanged?: () => void;
  onThrottled?: (event: ThrottledEvent) => void;
  onReady: (event: ReadyEvent) => void;
  onError: (failure: ScanFailure) => void;
}

/** Opens the survey stream. The returned function detaches without cancelling the scan. */
export function subscribeScan(
  owner: string,
  name: string,
  options: { force?: boolean },
  handlers: ScanHandlers,
): () => void {
  const url = new URL(`${API_BASE}/v1/scan/${owner}/${name}`, window.location.origin);
  if (options.force) url.searchParams.set('force', '1');

  const source = new EventSource(url.toString());
  let settled = false;

  const finish = () => {
    settled = true;
    source.close();
  };

  source.addEventListener('progress', (event) => {
    handlers.onProgress?.(JSON.parse((event as MessageEvent).data) as ScanProgress);
  });
  source.addEventListener('cached', (event) => {
    handlers.onCached?.((JSON.parse((event as MessageEvent).data) as { at: string }).at);
  });
  source.addEventListener('unchanged', () => handlers.onUnchanged?.());
  source.addEventListener('throttled', (event) => {
    handlers.onThrottled?.(JSON.parse((event as MessageEvent).data) as ThrottledEvent);
  });
  source.addEventListener('ready', (event) => {
    handlers.onReady(JSON.parse((event as MessageEvent).data) as ReadyEvent);
    finish();
  });
  source.addEventListener('error', (event) => {
    const data = (event as MessageEvent).data;
    if (typeof data === 'string' && data.length > 0) {
      handlers.onError(JSON.parse(data) as ScanFailure);
      finish();
      return;
    }
    // A transport level error with no payload after completion is just the stream closing.
    if (settled) return;
    if (source.readyState === EventSource.CLOSED) {
      handlers.onError({ code: 'upstream', message: 'The connection to the survey dropped.' });
      finish();
    }
  });

  return finish;
}

export async function fetchManifest(path: string): Promise<BiomeManifest> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: ScanFailure } | null;
    throw new Error(body?.error?.message ?? `Could not load the survey (${response.status}).`);
  }
  return (await response.json()) as BiomeManifest;
}

export interface RecentRepo {
  owner: string;
  name: string;
  headSha: string;
  headCommittedAt: string;
  scannedAt: string;
  plots: number;
  burning: number;
  canopyShare: number;
  oldestYears: number;
  stars: number;
}

export async function fetchRecent(limit = 8): Promise<RecentRepo[]> {
  const response = await fetch(`${API_BASE}/v1/recent?limit=${limit}`);
  if (!response.ok) return [];
  const body = (await response.json()) as { repos: RecentRepo[] };
  return body.repos ?? [];
}

export function parseRepoInput(value: string): { owner: string; name: string } | null {
  const trimmed = value.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(\.git)?\/?$/.exec(
    trimmed,
  );
  if (!match) return null;
  return { owner: match[1]!, name: match[2]! };
}
