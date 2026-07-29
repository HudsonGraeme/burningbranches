import { useCallback, useEffect, useRef, useState } from 'react';
import type { BiomeManifest, Plot, ScanProgress } from '@burningbranches/schema';
import {
  API_BASE,
  fetchManifest,
  fetchRecent,
  parseRepoInput,
  subscribeScan,
  type ReadyEvent,
  type RecentRepo,
} from './api.js';
import { World, type HoverEvent } from './scene/world.js';
import {
  EmbedPanel,
  Legend,
  PlotDetail,
  PlotTooltip,
  RecentList,
  StatsBar,
} from './ui/panels.js';

type Status = 'idle' | 'working' | 'ready' | 'error';

const SUGGESTIONS = ['torvalds/linux', 'facebook/react', 'cloudflare/workerd', 'rust-lang/rust'];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [manifest, setManifest] = useState<BiomeManifest | null>(null);
  const [ready, setReady] = useState<ReadyEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverEvent | null>(null);
  const [selected, setSelected] = useState<Plot | null>(null);
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [panelsOpen, setPanelsOpen] = useState(true);

  useEffect(() => {
    if (!canvasRef.current) return;
    const world = new World(canvasRef.current);
    world.onHover = (event) => setHover(event.plot ? event : null);
    world.onSelect = (plot) => {
      setSelected(plot);
      world.highlight(plot);
    };
    worldRef.current = world;
    return () => {
      world.dispose();
      worldRef.current = null;
    };
  }, []);

  useEffect(() => {
    fetchRecent(8).then(setRecent).catch(() => undefined);
  }, []);

  const grow = useCallback((owner: string, name: string, force = false) => {
    cancelRef.current?.();
    setStatus('working');
    setError(null);
    setNote(null);
    setSelected(null);
    setManifest(null);
    setReady(null);
    setProgress({ phase: 'queued', pct: 0, message: 'Waiting for a surveyor' });
    setInput(`${owner}/${name}`);

    const path = `/${owner}/${name}`;
    if (window.location.pathname !== path) window.history.pushState({}, '', path);

    cancelRef.current = subscribeScan(
      owner,
      name,
      { force },
      {
        onProgress: setProgress,
        onCached: (at) =>
          setNote(`Showing the survey taken ${new Date(at).toLocaleString()}. Regrow once a day.`),
        onUnchanged: () => setNote('No new commits since the last survey.'),
        onThrottled: (event) => setNote(event.message),
        onReady: (event) => {
          setReady(event);
          setProgress({ phase: 'growing', pct: 0.97, message: 'Planting the biome' });
          fetchManifest(event.manifestUrl)
            .then((loaded) => {
              worldRef.current?.load(loaded);
              setManifest(loaded);
              setStatus('ready');
              setProgress(null);
              fetchRecent(8).then(setRecent).catch(() => undefined);
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : 'Could not load the survey.');
              setStatus('error');
            });
        },
        onError: (failure) => {
          setError(failure.message);
          setStatus('error');
          setProgress(null);
        },
      },
    );
  }, []);

  useEffect(() => {
    const fromPath = () => {
      const parsed = parseRepoInput(window.location.pathname.replace(/^\//, ''));
      if (parsed) grow(parsed.owner, parsed.name);
    };
    fromPath();
    window.addEventListener('popstate', fromPath);
    return () => window.removeEventListener('popstate', fromPath);
  }, [grow]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseRepoInput(input);
    if (!parsed) {
      setError('Enter a repository as owner/name.');
      setStatus('error');
      return;
    }
    grow(parsed.owner, parsed.name);
  };

  return (
    <div className="app">
      <canvas ref={canvasRef} className="viewport" />

      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <span className="wordmark">burning branches</span>
        </div>
        <form className="search" onSubmit={submit}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="owner/repo"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Repository"
          />
          <button className="button" type="submit" disabled={status === 'working'}>
            {status === 'working' ? 'Growing' : 'Grow'}
          </button>
        </form>
        {ready && (
          <button
            className="button ghost"
            onClick={() => grow(ready.owner, ready.name, true)}
            title="Re-read the repository from GitHub"
          >
            Regrow
          </button>
        )}
        <button className="button ghost" onClick={() => setPanelsOpen((open) => !open)}>
          {panelsOpen ? 'Hide panels' : 'Show panels'}
        </button>
      </header>

      {status === 'idle' && (
        <div className="intro">
          <h1>Grow a forest out of a repository.</h1>
          <p>
            Every file becomes a plot of land. Code nobody has touched in years grows into old
            growth. Code rewritten last week is still burning. Code that churns constantly never
            gets past bare earth.
          </p>
          <div className="suggestions">
            {SUGGESTIONS.map((slug) => (
              <button key={slug} className="chip" onClick={() => setInput(slug)}>
                {slug}
              </button>
            ))}
          </div>
          <RecentList repos={recent} onPick={(owner, name) => grow(owner, name)} />
        </div>
      )}

      {status === 'working' && progress && (
        <div className="progress-overlay">
          <div className="progress-card">
            <span className="progress-phase">{progress.phase}</span>
            <span className="progress-message">{progress.message}</span>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress.pct * 100}%` }} />
            </div>
            <span className="fine">
              Reading a whole history takes a few hundred requests. It is cached afterwards.
            </span>
          </div>
        </div>
      )}

      {status === 'error' && error && (
        <div className="progress-overlay">
          <div className="progress-card error">
            <span className="progress-phase">Nothing grew</span>
            <span className="progress-message">{error}</span>
            <button className="button" onClick={() => setStatus('idle')}>
              Try another repository
            </button>
          </div>
        </div>
      )}

      {note && status === 'ready' && <div className="note">{note}</div>}

      {manifest && panelsOpen && (
        <>
          <aside className="rail left">
            <div className="panel repo">
              <h2>
                {manifest.repo.owner}/{manifest.repo.name}
              </h2>
              {manifest.repo.description && <p className="fine">{manifest.repo.description}</p>}
              <a
                className="link"
                href={manifest.repo.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {manifest.repo.branch} at {manifest.repo.headSha.slice(0, 7)}
              </a>
            </div>
            <StatsBar manifest={manifest} />
            <Legend />
          </aside>

          <aside className="rail right">
            {selected ? (
              <PlotDetail
                plot={selected}
                manifest={manifest}
                onClose={() => {
                  setSelected(null);
                  worldRef.current?.highlight(null);
                }}
              />
            ) : (
              ready && <EmbedPanel ready={ready} apiBase={API_BASE} />
            )}
          </aside>
        </>
      )}

      {hover?.plot && !selected && <PlotTooltip plot={hover.plot} x={hover.x} y={hover.y} />}
    </div>
  );
}
