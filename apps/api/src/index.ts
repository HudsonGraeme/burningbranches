import { renderCard } from './card.js';
import { consume } from './limiter.js';
import { REFRESH_INTERVAL_MS, loadCachedManifest } from './scanjob.js';
import {
  bumpViews,
  cardKey,
  getRepoRow,
  manifestKey,
  recentRepos,
  repoId,
  type Env,
} from './storage.js';

export { ScanJob } from './scanjob.js';
export { Limiter } from './limiter.js';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(env, origin, 405, 'bad_request', 'Only GET is supported.');
    }

    try {
      return await route(request, env, ctx, url, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected failure.';
      return fail(env, origin, 500, 'internal', message);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  origin: string | null,
): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] !== 'v1') {
    return fail(env, origin, 404, 'bad_request', 'Unknown endpoint.');
  }

  switch (segments[1]) {
    case 'health':
      return json(env, origin, { ok: true, now: new Date().toISOString() });

    case 'recent': {
      const rows = await recentRepos(env, Number(url.searchParams.get('limit') ?? '12'));
      return json(
        env,
        origin,
        {
          repos: rows.map((row) => ({
            owner: row.owner,
            name: row.name,
            headSha: row.head_sha,
            headCommittedAt: row.head_committed_at,
            scannedAt: row.last_scan_at,
            plots: row.plots,
            burning: row.burning,
            canopyShare: row.canopy_share,
            oldestYears: row.oldest_years,
            stars: row.stars,
          })),
        },
        60,
      );
    }

    case 'repo': {
      const ref = parseRef(segments[2], segments[3]);
      if (!ref) return fail(env, origin, 400, 'bad_request', 'Expected /v1/repo/{owner}/{repo}.');
      const row = await getRepoRow(env, ref.owner, ref.name);
      if (!row) return json(env, origin, { known: false }, 30);
      return json(
        env,
        origin,
        {
          known: true,
          owner: row.owner,
          name: row.name,
          branch: row.branch,
          headSha: row.head_sha,
          headCommittedAt: row.head_committed_at,
          firstCommitAt: row.first_commit_at,
          scannedAt: row.last_scan_at,
          scanCount: row.scan_count,
          nextRefreshAt: new Date(
            new Date(row.last_scan_at).getTime() + REFRESH_INTERVAL_MS,
          ).toISOString(),
          plots: row.plots,
          ghosts: row.ghosts,
          burning: row.burning,
          views: row.views,
          manifestUrl: `/v1/biome/${row.owner}/${row.name}/${row.head_sha}`,
        },
        30,
      );
    }

    case 'scan': {
      const ref = parseRef(segments[2], segments[3]);
      if (!ref) return fail(env, origin, 400, 'bad_request', 'Expected /v1/scan/{owner}/{repo}.');

      const force = url.searchParams.get('force') === '1';

      // Only a survey that will actually reach GitHub is metered. Replaying a cached forest
      // costs nothing upstream, so charging for it would throttle plain viewing.
      const row = await getRepoRow(env, ref.owner, ref.name);
      const cachedFresh =
        row !== null && Date.now() - new Date(row.last_scan_at).getTime() < REFRESH_INTERVAL_MS;

      if (!cachedFresh || force) {
        const ip = request.headers.get('cf-connecting-ip') ?? 'anonymous';
        const gate = await consume(env, `ip:${ip}`, { capacity: 12, refill: 0.05, cost: 1 });
        if (!gate.allowed) {
          // EventSource cannot read a non-2xx body, so the reason has to arrive as a frame.
          return eventStream(env, origin, 'error', {
            code: 'rate_limited',
            message: `Too many surveys from this address. Try again in ${gate.retryAfter}s.`,
          });
        }
      }

      const stub = env.SCAN_JOB.get(env.SCAN_JOB.idFromName(repoId(ref.owner, ref.name)));
      const target = new URL('https://scan/run');
      target.searchParams.set('owner', ref.owner);
      target.searchParams.set('name', ref.name);
      if (force) target.searchParams.set('force', '1');

      const response = await stub.fetch(target.toString());
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(env, origin))) {
        headers.set(key, value);
      }
      ctx.waitUntil(bumpViews(env, ref.owner, ref.name).catch(() => undefined));
      return new Response(response.body, { status: response.status, headers });
    }

    case 'biome': {
      const ref = parseRef(segments[2], segments[3]);
      if (!ref) return fail(env, origin, 400, 'bad_request', 'Expected /v1/biome/{owner}/{repo}.');
      const sha = segments[4];

      const row = await getRepoRow(env, ref.owner, ref.name);
      if (!row) return fail(env, origin, 404, 'not_found', 'That forest has not been grown yet.');

      const key =
        sha && sha !== row.head_sha ? manifestKey(ref.owner, ref.name, sha) : row.manifest_key;

      const object = await env.BIOMES.get(key);
      if (!object) return fail(env, origin, 404, 'not_found', 'That survey is no longer stored.');

      const headers = new Headers(corsHeaders(env, origin));
      headers.set('content-type', 'application/json; charset=utf-8');
      headers.set('etag', `"${sha ?? row.head_sha}"`);
      headers.set(
        'cache-control',
        sha ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      );
      return new Response(object.body, { headers });
    }

    case 'card': {
      const owner = segments[2];
      const file = segments[3] ?? '';
      const name = file.replace(/\.png$/i, '');
      const ref = parseRef(owner, name);
      if (!ref || !/\.png$/i.test(file)) {
        return fail(env, origin, 400, 'bad_request', 'Expected /v1/card/{owner}/{repo}.png.');
      }
      return card(env, ctx, origin, ref.owner, ref.name);
    }

    default:
      return fail(env, origin, 404, 'bad_request', 'Unknown endpoint.');
  }
}

async function card(
  env: Env,
  ctx: ExecutionContext,
  origin: string | null,
  owner: string,
  name: string,
): Promise<Response> {
  const cached = await loadCachedManifest(env, owner, name);
  if (!cached) {
    return fail(env, origin, 404, 'not_found', 'That forest has not been grown yet.');
  }

  const { row, manifest } = cached;
  const key = cardKey(owner, name, row.head_sha);

  // A README embed must never pay for a scan, but it is a good moment to notice that the
  // day has rolled over and start the next one in the background.
  const stale = Date.now() - new Date(row.last_scan_at).getTime() >= REFRESH_INTERVAL_MS;
  if (stale) ctx.waitUntil(kickRefresh(env, owner, name));

  const existing = await env.BIOMES.get(key);
  if (existing) {
    return imageResponse(env, origin, existing.body, row.head_sha, stale);
  }

  const png = await renderCard(manifest);
  ctx.waitUntil(
    env.BIOMES.put(key, png, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=86400' },
    }).then(() => undefined),
  );
  return imageResponse(env, origin, png, row.head_sha, stale);
}

async function kickRefresh(env: Env, owner: string, name: string): Promise<void> {
  const stub = env.SCAN_JOB.get(env.SCAN_JOB.idFromName(repoId(owner, name)));
  const target = new URL('https://scan/run');
  target.searchParams.set('owner', owner);
  target.searchParams.set('name', name);
  const response = await stub.fetch(target.toString());
  // Draining the stream keeps the durable object running until the survey finishes.
  await response.body?.pipeTo(new WritableStream());
}

function imageResponse(
  env: Env,
  origin: string | null,
  body: BodyInit,
  etag: string,
  stale: boolean,
): Response {
  const headers = new Headers(corsHeaders(env, origin));
  headers.set('content-type', 'image/png');
  headers.set('etag', `"${etag}"`);
  headers.set(
    'cache-control',
    stale
      ? 'public, max-age=60, s-maxage=60, stale-while-revalidate=86400'
      : 'public, max-age=900, s-maxage=900, stale-while-revalidate=86400',
  );
  return new Response(body, { headers });
}

function parseRef(owner?: string, name?: string): { owner: string; name: string } | null {
  if (!owner || !name) return null;
  const cleaned = name.replace(/\.git$/i, '');
  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(cleaned)) return null;
  return { owner, name: cleaned };
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const match = origin && allowed.includes(origin) ? origin : allowed[0] ?? '*';
  return {
    'access-control-allow-origin': match,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/** A single server sent event, delivered with a 2xx so the browser hands it to the client. */
function eventStream(
  env: Env,
  origin: string | null,
  event: string,
  data: unknown,
): Response {
  const headers = new Headers(corsHeaders(env, origin));
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-cache, no-transform');
  return new Response(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, { headers });
}

function json(env: Env, origin: string | null, body: unknown, maxAge = 0): Response {
  const headers = new Headers(corsHeaders(env, origin));
  headers.set('content-type', 'application/json; charset=utf-8');
  if (maxAge > 0) headers.set('cache-control', `public, max-age=${maxAge}`);
  return new Response(JSON.stringify(body), { headers });
}

function fail(
  env: Env,
  origin: string | null,
  status: number,
  code: string,
  message: string,
  retryAfter = 0,
): Response {
  const headers = new Headers(corsHeaders(env, origin));
  headers.set('content-type', 'application/json; charset=utf-8');
  if (retryAfter > 0) headers.set('retry-after', String(retryAfter));
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}
