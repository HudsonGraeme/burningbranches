import { useMemo, useState } from 'react';
import {
  TERRAIN_COLOR,
  TERRAIN_HINT,
  TERRAIN_LABEL,
  TERRAIN_ORDER,
  displayText,
  type BiomeManifest,
  type Plot,
} from '@burningbranches/schema';
import type { ReadyEvent, RecentRepo } from '../api.js';
import { ago, bytes, count, metres, percent, until, years } from './format.js';

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`;

export function Legend() {
  return (
    <div className="panel legend">
      <h2>Reading the ground</h2>
      <ul>
        {TERRAIN_ORDER.map((terrain) => (
          <li key={terrain}>
            <span className="swatch" style={{ background: hex(TERRAIN_COLOR[terrain]) }} />
            <span className="legend-label">{TERRAIN_LABEL[terrain]}</span>
            <span className="legend-hint">{TERRAIN_HINT[terrain]}</span>
          </li>
        ))}
      </ul>
      <p className="fine">
        Tree height follows a real growth curve, so a stand can never be older than the project
        it grew in.
      </p>
    </div>
  );
}

export function StatsBar({ manifest }: { manifest: BiomeManifest }) {
  const summary = useMemo(() => {
    let burning = 0;
    let scorched = 0;
    let canopy = 0;
    let tallest = 0;
    let oldest = 0;
    for (const plot of manifest.plots) {
      const terrain = plot.biome.terrain;
      if (terrain === 'burning') burning++;
      if (terrain === 'burning' || terrain === 'ash') scorched++;
      if (terrain === 'youngForest' || terrain === 'matureForest' || terrain === 'oldGrowth') {
        canopy++;
      }
      tallest = Math.max(tallest, plot.biome.treeHeight);
      oldest = Math.max(oldest, plot.metrics.dormantYears);
    }
    const total = Math.max(1, manifest.plots.length);
    const span =
      new Date(manifest.scan.spanEnd).getTime() - new Date(manifest.scan.spanStart).getTime();
    return {
      burning,
      scorched: scorched / total,
      canopy: canopy / total,
      tallest,
      oldest,
      spanYears: span / (365.25 * 86_400_000),
    };
  }, [manifest]);

  return (
    <div className="panel stats">
      <Stat label="Files mapped" value={count(manifest.scan.filesTracked)} />
      <Stat label="History" value={years(summary.spanYears)} />
      <Stat label="Eras sampled" value={count(manifest.scan.windows)} />
      <Stat label="Canopy" value={percent(summary.canopy)} />
      <Stat label="Scorched" value={percent(summary.scorched)} />
      <Stat
        label="Burning now"
        value={count(summary.burning)}
        tone={summary.burning > 0 ? 'ember' : undefined}
      />
      <Stat label="Tallest stand" value={metres(summary.tallest)} />
      <Stat label="Oldest stand" value={years(summary.oldest)} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ember' }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={tone === 'ember' ? 'stat-value ember' : 'stat-value'}>{value}</span>
    </div>
  );
}

export function PlotTooltip({ plot, x, y }: { plot: Plot; x: number; y: number }) {
  return (
    <div
      className="tooltip"
      style={{
        transform: `translate(${Math.min(x + 18, window.innerWidth - 320)}px, ${Math.min(
          y + 18,
          window.innerHeight - 190,
        )}px)`,
      }}
    >
      <span className="tooltip-path">{displayText(plot.path)}</span>
      <span className="tooltip-terrain" style={{ color: hex(TERRAIN_COLOR[plot.biome.terrain]) }}>
        {TERRAIN_LABEL[plot.biome.terrain]}
      </span>
      <span className="tooltip-hint">{TERRAIN_HINT[plot.biome.terrain]}</span>
      <dl>
        <Row label="Untouched" value={years(plot.metrics.dormantYears)} />
        <Row label="Canopy height" value={metres(plot.biome.treeHeight)} />
        <Row label="Churn" value={percent(plot.metrics.volatility)} />
        <Row label="Size" value={bytes(plot.bytes)} />
      </dl>
    </div>
  );
}

export function PlotDetail({
  plot,
  manifest,
  onClose,
}: {
  plot: Plot;
  manifest: BiomeManifest;
  onClose: () => void;
}) {
  // Paths and branch names come from the repository owner and can hold characters with
  // meaning in a URL, so each segment is encoded rather than pasted in.
  const branch = encodeURIComponent(manifest.repo.branch);
  const aggregate = / \d+ more files$/.test(plot.path);
  const href =
    plot.metrics.alive && !aggregate
      ? `${manifest.repo.htmlUrl}/blob/${branch}/${plot.path.split('/').map(encodeURIComponent).join('/')}`
      : `${manifest.repo.htmlUrl}/commits/${branch}`;

  return (
    <div className="panel detail">
      <button className="close" onClick={onClose} aria-label="Close">
        x
      </button>
      <span className="detail-terrain" style={{ color: hex(TERRAIN_COLOR[plot.biome.terrain]) }}>
        {TERRAIN_LABEL[plot.biome.terrain]}
      </span>
      <h2>{displayText(plot.path)}</h2>
      <p className="fine">{TERRAIN_HINT[plot.biome.terrain]}</p>
      <dl>
        <Row label="First seen" value={years(plot.metrics.ageYears) + ' ago'} />
        <Row label="Last touched" value={years(plot.metrics.dormantYears) + ' ago'} />
        <Row label="Changed in" value={percent(plot.metrics.volatility) + ' of its life'} />
        <Row label="Lines added" value={count(plot.metrics.addedLines)} />
        <Row label="Lines removed" value={count(plot.metrics.deletedLines)} />
        <Row label="Recently removed" value={count(plot.metrics.recentDeleted)} />
        <Row label="Burn" value={percent(plot.biome.burn)} />
        <Row label="Canopy height" value={metres(plot.biome.treeHeight)} />
        <Row label="Plot size" value={`${Math.round(plot.rect[2])} x ${Math.round(plot.rect[3])} m`} />
      </dl>
      {!plot.metrics.alive && <p className="fine ember">This file no longer exists at HEAD.</p>}
      <a className="link" href={href} target="_blank" rel="noreferrer noopener">
        Open on GitHub
      </a>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export function EmbedPanel({ ready, apiBase }: { ready: ReadyEvent; apiBase: string }) {
  const [copied, setCopied] = useState(false);
  const cardUrl = `${apiBase || window.location.origin}${ready.cardUrl}`;
  const pageUrl = `${window.location.origin}/${ready.owner}/${ready.name}`;
  const snippet = `[![burning branches](${cardUrl})](${pageUrl})`;

  const copy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="panel embed">
      <h2>Put it in your README</h2>
      <p className="fine">
        The image is rendered on request and follows the repository. It regrows once a day as new
        commits land.
      </p>
      <img className="card-preview" src={cardUrl} alt={`${ready.owner}/${ready.name} biome`} />
      <code className="snippet">{snippet}</code>
      <button className="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy markdown'}
      </button>
      <p className="fine">
        Surveyed {ago(ready.scannedAt)}. Next regrowth available in {until(ready.nextRefreshAt)}.
      </p>
    </div>
  );
}

export function RecentList({
  repos,
  onPick,
}: {
  repos: RecentRepo[];
  onPick: (owner: string, name: string) => void;
}) {
  if (repos.length === 0) return null;
  return (
    <div className="panel recent">
      <h2>Recently grown</h2>
      <ul>
        {repos.map((repo) => (
          <li key={`${repo.owner}/${repo.name}`}>
            <button onClick={() => onPick(repo.owner, repo.name)}>
              <span className="recent-name">
                {repo.owner}/{repo.name}
              </span>
              <span className="recent-meta">
                {count(repo.plots)} plots
                {repo.burning > 0 ? ` · ${count(repo.burning)} burning` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
