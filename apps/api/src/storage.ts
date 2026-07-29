import type { BiomeManifest } from '@burningbranches/schema';
import { summarize } from './card.js';

export interface Env {
  BIOMES: R2Bucket;
  DB: D1Database;
  SCAN_JOB: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  GITHUB_TOKEN: string;
  ALLOWED_ORIGINS: string;
  MAX_PLOTS: string;
}

export interface RepoRow {
  id: string;
  owner: string;
  name: string;
  branch: string;
  head_sha: string;
  head_committed_at: string;
  first_commit_at: string;
  last_scan_at: string;
  scan_count: number;
  plots: number;
  ghosts: number;
  stars: number;
  burning: number;
  canopy_share: number;
  oldest_years: number;
  views: number;
  manifest_key: string;
}

export function repoId(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function manifestKey(owner: string, name: string, sha: string): string {
  return `m/${owner.toLowerCase()}/${name.toLowerCase()}/${sha}.json`;
}

/**
 * Bumped whenever the card renderer changes. Without it a design change would never reach
 * repositories that were already surveyed, because their PNG is keyed only by commit.
 */
export const CARD_VERSION = 3;

export function cardKey(owner: string, name: string, sha: string): string {
  return `c/v${CARD_VERSION}/${owner.toLowerCase()}/${name.toLowerCase()}/${sha}.png`;
}

/**
 * Manifests are stored uncompressed. The edge negotiates transfer encoding with the client
 * on its own, and serving pre-gzipped bytes only earns a second, redundant compression pass.
 */
export async function putManifest(env: Env, manifest: BiomeManifest): Promise<string> {
  const key = manifestKey(manifest.repo.owner, manifest.repo.name, manifest.repo.headSha);
  await env.BIOMES.put(key, JSON.stringify(manifest), {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
  return key;
}

export async function readManifest(env: Env, key: string): Promise<BiomeManifest | null> {
  const object = await env.BIOMES.get(key);
  if (!object) return null;
  return (await object.json()) as BiomeManifest;
}

export async function recordScan(
  env: Env,
  manifest: BiomeManifest,
  key: string,
  headCommittedAt: string,
): Promise<void> {
  const summary = summarize(manifest);
  const id = repoId(manifest.repo.owner, manifest.repo.name);
  await env.DB.prepare(
    `INSERT INTO repos (
       id, owner, name, branch, head_sha, head_committed_at, first_commit_at,
       last_scan_at, scan_count, plots, ghosts, stars, burning, canopy_share,
       oldest_years, views, manifest_key
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?10,?11,?12,?13,?14,0,?15)
     ON CONFLICT(id) DO UPDATE SET
       branch=excluded.branch,
       head_sha=excluded.head_sha,
       head_committed_at=excluded.head_committed_at,
       first_commit_at=excluded.first_commit_at,
       last_scan_at=excluded.last_scan_at,
       scan_count=repos.scan_count + 1,
       plots=excluded.plots,
       ghosts=excluded.ghosts,
       stars=excluded.stars,
       burning=excluded.burning,
       canopy_share=excluded.canopy_share,
       oldest_years=excluded.oldest_years,
       manifest_key=excluded.manifest_key`,
  )
    .bind(
      id,
      manifest.repo.owner,
      manifest.repo.name,
      manifest.repo.branch,
      manifest.repo.headSha,
      headCommittedAt,
      manifest.repo.firstCommitAt,
      new Date().toISOString(),
      manifest.scan.filesTracked,
      manifest.scan.ghostsTracked,
      manifest.repo.stars,
      summary.burning,
      summary.canopyShare,
      summary.oldestYears,
      key,
    )
    .run();
}

export async function getRepoRow(env: Env, owner: string, name: string): Promise<RepoRow | null> {
  return env.DB.prepare('SELECT * FROM repos WHERE id = ?1')
    .bind(repoId(owner, name))
    .first<RepoRow>();
}

export async function bumpViews(env: Env, owner: string, name: string): Promise<void> {
  await env.DB.prepare('UPDATE repos SET views = views + 1 WHERE id = ?1')
    .bind(repoId(owner, name))
    .run();
}

export async function recentRepos(env: Env, limit: number): Promise<RepoRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM repos ORDER BY last_scan_at DESC LIMIT ?1`,
  )
    .bind(Math.min(50, Math.max(1, limit)))
    .all<RepoRow>();
  return result.results ?? [];
}
