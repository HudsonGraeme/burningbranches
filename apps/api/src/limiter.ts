import { DurableObject } from 'cloudflare:workers';
import type { Env } from './storage.js';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket keyed by caller. The shared GitHub budget is the scarce resource here, so
 * survey requests are metered before they ever reach the scanner.
 */
export class Limiter extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const capacity = Number(url.searchParams.get('capacity') ?? '12');
    const refillPerSecond = Number(url.searchParams.get('refill') ?? '0.05');
    const cost = Number(url.searchParams.get('cost') ?? '1');

    const now = Date.now();
    const bucket = (await this.ctx.storage.get<Bucket>('bucket')) ?? {
      tokens: capacity,
      updatedAt: now,
    };

    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    const tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);

    if (tokens < cost) {
      const retryAfter = Math.ceil((cost - tokens) / refillPerSecond);
      await this.ctx.storage.put('bucket', { tokens, updatedAt: now });
      return Response.json({ allowed: false, retryAfter }, { status: 429 });
    }

    await this.ctx.storage.put('bucket', { tokens: tokens - cost, updatedAt: now });
    return Response.json({ allowed: true, remaining: Math.floor(tokens - cost) });
  }
}

export async function consume(
  env: Env,
  key: string,
  options: { capacity: number; refill: number; cost: number },
): Promise<{ allowed: boolean; retryAfter: number }> {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const url = new URL('https://limiter/consume');
  url.searchParams.set('capacity', String(options.capacity));
  url.searchParams.set('refill', String(options.refill));
  url.searchParams.set('cost', String(options.cost));
  const res = await stub.fetch(url.toString());
  const body = (await res.json()) as { allowed: boolean; retryAfter?: number };
  return { allowed: body.allowed, retryAfter: body.retryAfter ?? 0 };
}
