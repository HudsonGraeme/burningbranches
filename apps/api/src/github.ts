import type { ScanFailure } from '@burningbranches/schema';

export class GitHubError extends Error {
  constructor(
    readonly failure: ScanFailure,
    readonly status: number,
  ) {
    super(failure.message);
    this.name = 'GitHubError';
  }
}

export interface RepoResponse {
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  size: number;
  description: string | null;
  html_url: string;
  default_branch: string;
  created_at: string;
  pushed_at: string;
  stargazers_count: number;
  license: { spdx_id: string | null } | null;
}

export interface CommitSummary {
  sha: string;
  commit: { author: { date: string } | null; committer: { date: string } | null };
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
  sha: string;
}

export interface TreeResponse {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

export interface CompareFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
}

export interface CompareResponse {
  total_commits: number;
  files?: CompareFile[];
}

const API = 'https://api.github.com';
const UA = 'burningbranches.dev (+https://github.com/hudsongraeme/burningbranches)';

/** Compare stops enumerating files at this count, which is our signal to split a window. */
export const COMPARE_FILE_CAP = 300;
export const COMPARE_COMMIT_CAP = 250;

export class GitHub {
  requests = 0;
  rateRemaining = Number.POSITIVE_INFINITY;
  rateReset = 0;

  constructor(private readonly token: string) {}

  private async call<T>(path: string, signal?: AbortSignal): Promise<{ body: T; res: Response }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.requests++;
      const res = await fetch(`${API}${path}`, {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': UA,
        },
        signal,
      });

      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining !== null) this.rateRemaining = Number(remaining);
      const reset = res.headers.get('x-ratelimit-reset');
      if (reset !== null) this.rateReset = Number(reset) * 1000;

      if (res.ok) return { body: (await res.json()) as T, res };

      if (res.status === 404) {
        throw new GitHubError(
          { code: 'not_found', message: 'That repository is not visible from here.' },
          404,
        );
      }
      if (res.status === 409) {
        throw new GitHubError(
          { code: 'empty_repo', message: 'That repository has no commits yet.' },
          409,
        );
      }
      if (res.status === 451) {
        throw new GitHubError({ code: 'not_found', message: 'That repository is blocked.' }, 451);
      }

      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      const secondary = res.status === 403 && this.rateRemaining > 0;
      if ((res.status === 429 || secondary) && attempt < 2) {
        await sleep(Math.max(retryAfter * 1000, 1200 * (attempt + 1)), signal);
        continue;
      }

      if (res.status === 403 || res.status === 429) {
        throw new GitHubError(
          {
            code: 'rate_limited',
            message: 'GitHub rate limit reached. The forest will be ready shortly.',
          },
          429,
        );
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(600 * (attempt + 1), signal);
        continue;
      }

      throw new GitHubError(
        { code: 'upstream', message: `GitHub returned ${res.status}.` },
        res.status,
      );
    }
    throw new GitHubError({ code: 'upstream', message: 'GitHub did not respond.' }, 502);
  }

  async repo(owner: string, name: string, signal?: AbortSignal): Promise<RepoResponse> {
    const { body } = await this.call<RepoResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, signal);
    return body;
  }

  /**
   * Head commit plus the total commit count, read from the Link header's last page. One
   * request answers both instead of walking the whole history.
   */
  async headAndCount(
    owner: string,
    name: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<{ head: CommitSummary; count: number }> {
    const { body, res } = await this.call<CommitSummary[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
      signal,
    );
    const head = body[0];
    if (!head) {
      throw new GitHubError(
        { code: 'empty_repo', message: 'That branch has no commits.' },
        409,
      );
    }
    return { head, count: lastPage(res.headers.get('link')) ?? 1 };
  }

  async commitAtPage(
    owner: string,
    name: string,
    branch: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<CommitSummary | null> {
    const { body } = await this.call<CommitSummary[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?sha=${encodeURIComponent(branch)}&per_page=1&page=${page}`,
      signal,
    );
    return body[0] ?? null;
  }

  /** Newest commit at or before `until`. This is how window boundaries become shas. */
  async commitBefore(
    owner: string,
    name: string,
    branch: string,
    until: Date,
    signal?: AbortSignal,
  ): Promise<CommitSummary | null> {
    const { body } = await this.call<CommitSummary[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?sha=${encodeURIComponent(branch)}&per_page=1&until=${until.toISOString()}`,
      signal,
    );
    return body[0] ?? null;
  }

  async tree(
    owner: string,
    name: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<TreeResponse> {
    const { body } = await this.call<TreeResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${sha}?recursive=1`,
      signal,
    );
    return body;
  }

  async compare(
    owner: string,
    name: string,
    base: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<CompareResponse> {
    const { body } = await this.call<CompareResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${base}...${head}?per_page=${COMPARE_FILE_CAP}`,
      signal,
    );
    return body;
  }
}

export function commitDate(commit: CommitSummary): Date {
  const raw = commit.commit.committer?.date ?? commit.commit.author?.date;
  return raw ? new Date(raw) : new Date();
}

function lastPage(link: string | null): number | null {
  if (!link) return null;
  const match = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
  return match ? Number(match[1]) : null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
