import { useCallback, useEffect, useState } from 'react';
import { num, stamp } from '../lib/format.js';
import { IconButton, RefreshIcon } from './IconButton.jsx';
import { SetupGuide } from './SetupGuide.jsx';

function emptyStatus() {
  return {
    ok: false,
    checkedAt: null,
    installed: false,
    cli: null,
    needsUpgrade: false,
    initialized: false,
    version: null,
    root: null,
    graphDir: null,
    vizUrl: 'http://127.0.0.1:4400/',
    error: null,
    steps: [],
  };
}

function setupTitle(status) {
  if (status.needsUpgrade || status.cli === 'graft') {
    return 'Graft is installed — upgrade to Trail';
  }
  if (!status.installed) return 'Trail is not installed';
  return 'Trail is not initialized in this workspace';
}

function setupSummary(status) {
  if (status.error) return status.error;
  if (status.needsUpgrade || status.cli === 'graft') {
    return 'Graft has been renamed to Trail. Upgrade the CLI so this tab can show savings and the visualizer.';
  }
  if (!status.installed) {
    return 'Install and build Trail so this tab can show savings and the visualizer.';
  }
  return 'Build the Trail graph so this tab can show savings and the visualizer.';
}

export function TrailPanel({
  trail,
  status: statusProp,
  detect = true,
  enforce = true,
  canLiveRefresh = false,
}) {
  const [live, setLive] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!canLiveRefresh || !detect) return;
    setBusy(true);
    try {
      const res = await fetch('/trail');
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail || `HTTP ${res.status}`);
      }
      setLive(await res.json());
      setLoadError(null);
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [canLiveRefresh, detect]);

  useEffect(() => {
    if (!canLiveRefresh || !detect) {
      setLive(null);
      return undefined;
    }
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [canLiveRefresh, detect, refresh]);

  const status = live || statusProp || emptyStatus();
  const g = trail || { savedTokens: 0, trailReads: 0, sourceReads: 0, mixPct: null, vizUrl: status.vizUrl };
  const vizUrl = status.vizUrl || g.vizUrl || 'http://127.0.0.1:4400/';

  if (!detect) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-gray-400">
          Trail detection is off in <span className="text-gray-200">Settings → Workspace tools</span>.
          Turn it on to check the CLI and <code className="text-sky-300">.trail/cache/</code> graph.
        </p>
        <SavingsBlock g={g} status={{ version: null, checkedAt: null }} vizUrl={vizUrl} showViz={false} />
      </div>
    );
  }

  if (!status.ok) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs text-gray-500">
            {status.checkedAt ? `Checked ${stamp(status.checkedAt)}` : 'Checking Trail…'}
            {canLiveRefresh ? ' · live' : ' · last hook snapshot'}
            {enforce ? ' · enforced' : ' · detection only'}
          </p>
          {canLiveRefresh ? (
            <IconButton label="Recheck" icon={RefreshIcon} disabled={busy} onClick={refresh} />
          ) : null}
        </div>
        {loadError ? <p className="text-xs text-amber-400">Live check failed: {loadError}</p> : null}
        {enforce ? (
          <SetupGuide
            title={setupTitle(status)}
            summary={setupSummary(status)}
            steps={status.steps}
            footnote={
              canLiveRefresh
                ? 'After installing or upgrading, click Recheck — this tab polls /trail while open.'
                : 'Serve with npm run kusa:serve for a live recheck, or trigger any hooked agent event to refresh the snapshot.'
            }
          />
        ) : (
          <p className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">
            {status.error || 'Trail is not ready.'} Enforcement is off, so the tab badge stays clear.
            Enable <span className="text-gray-200">Enforce Trail</span> in Settings to require setup.
          </p>
        )}
        <ReadinessBits status={status} />
      </div>
    );
  }

  return <SavingsBlock g={g} status={status} vizUrl={vizUrl} showViz />;
}

function SavingsBlock({ g, status, vizUrl, showViz }) {
  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Trail savings</h2>
          <p className="text-xs text-gray-500">
            {status.version ? `Ready · CLI ${status.version}` : 'Session counters'}
            {status.checkedAt ? ` · checked ${stamp(status.checkedAt)}` : ''}
          </p>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          From <code className="text-sky-300">[trail] tokens saved ≈</code> footers, the reply tally line, and{' '}
          <code className="text-sky-300">.trail/cache/.cache/session/&lt;id&gt;.json</code> when present.
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Tokens saved" value={`~${num(g.savedTokens)}`} />
          <Stat label="Trail reads" value={num(g.trailReads)} />
          <Stat label="Source reads" value={num(g.sourceReads)} />
          <Stat label="Mix (trail)" value={g.mixPct == null ? '—' : `${g.mixPct}%`} />
        </div>
      </section>
      {showViz ? (
        <section>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Visualizer</h2>
            <p className="text-xs text-gray-500">
              Run <code className="text-sky-300">trail viz --no-open</code> then{' '}
              <a href={vizUrl} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">
                open {vizUrl.replace(/\/$/, '')}
              </a>
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
            <iframe
              title="Trail visualizer"
              src={vizUrl}
              className="h-[32rem] w-full bg-gray-950"
              loading="lazy"
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ReadinessBits({ status }) {
  const cliLabel = status.cli === 'trail' && status.installed
    ? (status.version || 'trail')
    : status.cli === 'graft' || status.needsUpgrade
      ? `graft${status.version ? ` ${status.version}` : ''} → upgrade`
      : 'missing';
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <Stat label="CLI" value={cliLabel} />
      <Stat label=".trail/cache" value={status.initialized ? 'built' : 'missing'} />
      <Stat label="Workspace" value={status.root ? status.root.split(/[/\\]/).pop() || status.root : '—'} />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-1 truncate text-2xl font-bold tabular-nums" title={String(value)}>{value}</div>
    </div>
  );
}
