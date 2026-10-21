import { useCallback, useEffect, useState } from 'react';
import { GIT_CODE_LABEL, stamp } from '../lib/format.js';
import { IconButton, RefreshIcon } from './IconButton.jsx';
import { SetupGuide } from './SetupGuide.jsx';

function emptyGit() {
  return {
    ok: false,
    checkedAt: null,
    installed: false,
    initialized: false,
    root: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    head: null,
    subject: null,
    clean: true,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    truncated: false,
    error: null,
    steps: [],
  };
}

export function GitPanel({
  git,
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
      const res = await fetch('/git');
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
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [canLiveRefresh, detect, refresh]);

  if (!detect) {
    return (
      <div className="space-y-6">
        <h2 className="text-base font-semibold">Working copy</h2>
        <p className="text-sm text-gray-400">
          Git detection is off in <span className="text-gray-200">Settings → Workspace tools</span>.
          Turn it on to check that Git is installed and this folder is a repository.
        </p>
      </div>
    );
  }

  const g = live || git || emptyGit();
  const dirtyCount = g.staged.length + g.unstaged.length + g.untracked.length + g.conflicted.length;

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Working copy</h2>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>
              {g.checkedAt ? `Checked ${stamp(g.checkedAt)}` : 'Not checked yet'}
              {canLiveRefresh ? ' · live' : ' · last hook snapshot'}
              {enforce ? ' · enforced' : ' · detection only'}
            </span>
            {canLiveRefresh ? (
              <IconButton label="Refresh" icon={RefreshIcon} disabled={busy} onClick={refresh} />
            ) : null}
          </div>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Branch, ahead/behind, and every changed path from{' '}
          <code className="text-sky-300">git status -uall</code> (untracked directories are expanded to files).
          With <code className="text-sky-300">npm run kusa:serve</code> this tab polls{' '}
          <code className="text-sky-300">/git</code>; otherwise it uses the snapshot rewritten on each hook.
        </p>
        {loadError ? (
          <p className="mb-3 text-xs text-amber-400">Live refresh failed: {loadError}</p>
        ) : null}
        {!g.ok ? (
          enforce ? (
            <SetupGuide
              title={!g.installed ? 'Git is not installed' : 'This workspace is not a git repository'}
              summary={g.error || 'Install Git and initialize a repository to see working-copy status here.'}
              steps={g.steps}
              footnote={
                canLiveRefresh
                  ? 'After fixing this, click Refresh — this tab polls /git while open.'
                  : 'Serve with npm run kusa:serve for a live recheck, or trigger any hooked agent event to refresh the snapshot.'
              }
            />
          ) : (
            <p className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">
              {g.error || 'Git is not ready.'} Enforcement is off, so the tab badge stays clear.
              Enable <span className="text-gray-200">Enforce Git</span> in Settings to require setup.
            </p>
          )
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="Branch"
                value={g.detached ? `detached @ ${g.head || '—'}` : (g.branch || '—')}
              />
              <Stat
                label="State"
                value={g.clean ? 'Clean' : `Dirty · ${dirtyCount}`}
                tone={g.clean ? 'ok' : g.conflicted.length ? 'bad' : 'warn'}
              />
              <Stat
                label="Upstream"
                value={
                  g.upstream
                    ? `${g.upstream}${g.ahead || g.behind ? ` · ↑${g.ahead} ↓${g.behind}` : ''}`
                    : '—'
                }
              />
              <Stat label="HEAD" value={g.head || '—'} />
            </div>
            {g.subject ? (
              <p className="mt-3 truncate text-sm text-gray-400" title={g.subject}>
                <span className="text-gray-500">Last commit · </span>{g.subject}
              </p>
            ) : null}
            {g.root ? (
              <p className="mt-1 truncate font-mono text-[11px] text-gray-600" title={g.root}>
                {g.root}
              </p>
            ) : null}
          </>
        )}
      </section>

      {g.ok ? (
        <>
          <PathSection title="Conflicted" rows={g.conflicted} empty="No conflicts." tone="bad" />
          <PathSection title="Staged" rows={g.staged} empty="Nothing staged." />
          <PathSection title="Unstaged" rows={g.unstaged} empty="No unstaged changes." />
          <PathSection title="Untracked" rows={g.untracked} empty="No untracked files." />
          {g.truncated ? (
            <p className="text-xs text-amber-400">
              Path lists were truncated at the console cap. Run <code className="text-sky-300">git status</code> in the terminal for the full set.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }) {
  const valueClass = tone === 'ok'
    ? 'text-emerald-400'
    : tone === 'warn'
      ? 'text-amber-300'
      : tone === 'bad'
        ? 'text-rose-300'
        : 'text-gray-100';
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold tabular-nums ${valueClass}`} title={String(value)}>
        {value}
      </div>
    </div>
  );
}

function PathSection({ title, rows, empty, tone }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">
        {title}
        <span className="ml-2 text-xs font-normal text-gray-500">{rows.length}</span>
      </h2>
      {!rows.length ? (
        <p className="text-sm text-gray-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Change</th>
                <th className="px-3 py-2 font-medium">Path</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map((row) => {
                const code = row.code || '?';
                const label = GIT_CODE_LABEL[code[0]] || GIT_CODE_LABEL[code] || code;
                return (
                  <tr key={`${code}:${row.path}`} className="text-gray-300">
                    <td className={`px-3 py-1.5 font-mono text-xs ${tone === 'bad' ? 'text-rose-300' : 'text-sky-300'}`}>
                      {code}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-500">{label}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{row.path}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
