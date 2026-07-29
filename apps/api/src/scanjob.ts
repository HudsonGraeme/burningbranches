import { DurableObject } from 'cloudflare:workers';
import type { ScanFailure, ScanProgress } from '@burningbranches/schema';
import { GitHub, GitHubError, commitDate } from './github.js';
import { scanRepo } from './scan.js';
import {
  getRepoRow,
  putManifest,
  readManifest,
  recordScan,
  type Env,
} from './storage.js';

/** A repository may be re-read from GitHub at most once a day, however often it is asked for. */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface JobState {
  lastScanAt: number;
  headSha: string;
  headCommittedAt: string;
  manifestKey: string;
}

interface Subscriber {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  closed: boolean;
}

const encoder = new TextEncoder();

export class ScanJob extends DurableObject<Env> {
  private subscribers = new Set<Subscriber>();
  private running: Promise<void> | null = null;
  private lastProgress: ScanProgress = { phase: 'queued', pct: 0, message: 'Queued' };

  /**
   * Views are counted in memory and only flushed when a survey is recorded. Writing per
   * request would let anyone reloading a cached forest drive unbounded database writes, and
   * losing a few counts when the object is evicted costs nothing.
   */
  private pendingViews = 0;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const owner = url.searchParams.get('owner') ?? '';
    const name = url.searchParams.get('name') ?? '';
    const force = url.searchParams.get('force') === '1';

    if (url.pathname === '/status') {
      const state = await this.readState();
      return Response.json({
        state,
        running: this.running !== null,
        nextRefreshAt: state ? state.lastScanAt + REFRESH_INTERVAL_MS : Date.now(),
      });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const subscriber: Subscriber = { writer: writable.getWriter(), closed: false };
    this.subscribers.add(subscriber);

    this.ctx.waitUntil(this.drive(owner, name, force, subscriber));

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  private async drive(
    owner: string,
    name: string,
    force: boolean,
    subscriber: Subscriber,
  ): Promise<void> {
    try {
      this.pendingViews++;

      // Reading the state, deciding, and claiming the scan must be one indivisible step.
      // Every await is a yield point, so without this two requests arriving together could
      // both observe no scan running and both start one, doubling the GitHub cost and
      // racing each other's writes.
      const claim = await this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.readState();
        const now = Date.now();
        const fresh = state !== null && now - state.lastScanAt < REFRESH_INTERVAL_MS;

        if (state && fresh) return { kind: 'cached' as const, state, now };
        if (this.running) return { kind: 'attach' as const };

        this.running = this.run(owner, name, state).finally(() => {
          this.running = null;
        });
        return { kind: 'started' as const };
      });

      if (claim.kind === 'cached') {
        if (force) {
          const retryAfter = Math.ceil(
            (claim.state.lastScanAt + REFRESH_INTERVAL_MS - claim.now) / 1000,
          );
          this.send(subscriber, 'throttled', {
            retryAfter,
            message: 'This forest was grown recently. It can be regrown once a day.',
          });
        }
        this.send(subscriber, 'cached', { at: new Date(claim.state.lastScanAt).toISOString() });
        this.send(subscriber, 'ready', this.readyPayload(owner, name, claim.state));
        return this.close(subscriber);
      }

      if (claim.kind === 'attach') this.send(subscriber, 'progress', this.lastProgress);
      await this.running;
    } catch (error) {
      this.broadcast('error', toFailure(error));
      this.closeAll();
    }
  }

  private async run(owner: string, name: string, state: JobState | null): Promise<void> {
    const controller = new AbortController();
    const gh = new GitHub(this.env.GITHUB_TOKEN);

    try {
      this.progress({ phase: 'meta', pct: 0.01, message: 'Waking the surveyors' });

      // A repository whose HEAD has not moved needs no second scan, only a new timestamp.
      if (state) {
        const repo = await gh.repo(owner, name, controller.signal);
        const head = await gh.headAndCount(owner, name, repo.default_branch, controller.signal);
        if (head.head.sha === state.headSha) {
          const next: JobState = {
            ...state,
            lastScanAt: Date.now(),
            headCommittedAt: commitDate(head.head).toISOString(),
          };
          await this.writeState(next);
          this.broadcast('unchanged', { headSha: state.headSha });
          this.broadcast('ready', this.readyPayload(owner, name, next));
          this.closeAll();
          return;
        }
      }

      const maxPlots = Number(this.env.MAX_PLOTS || '5200');
      const { manifest, headCommittedAt } = await scanRepo(
        {
          gh,
          signal: controller.signal,
          onProgress: (p) => this.progress(p),
        },
        owner,
        name,
        maxPlots,
      );

      this.progress({ phase: 'growing', pct: 0.94, message: 'Storing the survey' });
      const key = await putManifest(this.env, manifest);
      await recordScan(this.env, manifest, key, headCommittedAt, this.pendingViews);
      this.pendingViews = 0;

      const next: JobState = {
        lastScanAt: Date.now(),
        headSha: manifest.repo.headSha,
        headCommittedAt,
        manifestKey: key,
      };
      await this.writeState(next);

      this.progress({ phase: 'done', pct: 1, message: 'The forest is standing' });
      this.broadcast('ready', this.readyPayload(owner, name, next));
      this.closeAll();
    } catch (error) {
      this.broadcast('error', toFailure(error));
      this.closeAll();
    }
  }

  private readyPayload(owner: string, name: string, state: JobState) {
    return {
      owner,
      name,
      headSha: state.headSha,
      headCommittedAt: state.headCommittedAt,
      scannedAt: new Date(state.lastScanAt).toISOString(),
      nextRefreshAt: new Date(state.lastScanAt + REFRESH_INTERVAL_MS).toISOString(),
      manifestUrl: `/v1/biome/${owner}/${name}/${state.headSha}`,
      cardUrl: `/v1/card/${owner}/${name}.png`,
    };
  }

  private async readState(): Promise<JobState | null> {
    const stored = await this.ctx.storage.get<JobState>('state');
    if (stored) return stored;
    return null;
  }

  private async writeState(state: JobState): Promise<void> {
    await this.ctx.storage.put('state', state);
  }

  private progress(progress: ScanProgress): void {
    this.lastProgress = progress;
    this.broadcast('progress', progress);
  }

  private send(subscriber: Subscriber, event: string, data: unknown): void {
    if (subscriber.closed) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    subscriber.writer.write(encoder.encode(frame)).catch(() => {
      subscriber.closed = true;
    });
  }

  private broadcast(event: string, data: unknown): void {
    for (const subscriber of this.subscribers) this.send(subscriber, event, data);
  }

  private close(subscriber: Subscriber): void {
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    subscriber.writer.close().catch(() => undefined);
  }

  private closeAll(): void {
    for (const subscriber of [...this.subscribers]) this.close(subscriber);
  }
}

function toFailure(error: unknown): ScanFailure {
  if (error instanceof GitHubError) return error.failure;
  // Only messages this code authored are safe to hand back. Raw exception text can carry
  // internal detail, so it goes to the log and the caller gets a fixed string.
  console.error('scan failed', error);
  return { code: 'internal', message: 'The survey failed unexpectedly.' };
}

export async function loadCachedManifest(env: Env, owner: string, name: string) {
  const row = await getRepoRow(env, owner, name);
  if (!row) return null;
  const manifest = await readManifest(env, row.manifest_key);
  return manifest ? { row, manifest } : null;
}
