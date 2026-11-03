/**
 * Sidebar › Extensions — built-in (and later workspace) extension catalog.
 *
 * Selecting a row loads that extension’s info & config page in the main pane
 * (`ExtensionPage` via App `activeExtensionId`). Extensions that declare
 * `nav.placement: 'devtools'` also stay reachable from Dev Tools (e.g. CAO).
 * The Kusă agent CLI is a standalone feature (not listed here); CAO can
 * optionally use it as provider kusa_cli.
 */
import { useCallback, useEffect, useState } from 'react';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { BUILTIN_EXTENSIONS } from './registry.js';

async function fetchJson(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Catalog row glyph — lucide `blocks` at 18×18. */
function ExtensionIcon() {
  return <LucideIcon name="blocks" className="h-[18px] w-[18px]" />;
}

function statusLabel(ext, statuses) {
  if (!statuses) return null;
  if (ext.id === 'cao') {
    const caoStatus = statuses.cao;
    if (!caoStatus) return null;
    if (!caoStatus.installed) return { text: 'cao CLI missing', ok: false };
    if (!caoStatus.serverUp) return { text: 'cao-server down', ok: false };
    const kusa = (caoStatus.providers || []).find(
      (p) => p.id === 'kusa_cli' || p.name === 'kusa_cli',
    );
    if (kusa?.available || kusa?.installed) {
      return { text: 'server up · Kusa CLI ready', ok: true };
    }
    return { text: 'server up', ok: true };
  }
  if (ext.id === 'live-chat') {
    const live = statuses.liveChat;
    if (!live) return null;
    if (!live.installed) return { text: 'bot not installed', ok: false };
    if (!live.serverUp) return { text: 'bot down', ok: false };
    return { text: `server up · ${live.transport || 'ws'}`, ok: true };
  }
  return null;
}

export function ExtensionsPanel({
  canPersist = false,
  selectedId = null,
  onSelect = null,
  collapsed = false,
}) {
  const [statuses, setStatuses] = useState(null);

  const refresh = useCallback(async () => {
    if (!canPersist) {
      setStatuses(null);
      return;
    }
    const next = { cao: null, liveChat: null };
    try {
      next.cao = await fetchJson('/cao');
    } catch {
      next.cao = null;
    }
    try {
      next.liveChat = await fetchJson('/live-chat');
    } catch {
      next.liveChat = null;
    }
    setStatuses(next);
  }, [canPersist]);

  useEffect(() => {
    refresh();
    if (!canPersist) return undefined;
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [canPersist, refresh]);

  if (collapsed) {
    return (
      <div
        id="sidebar-panel-extensions"
        role="tabpanel"
        aria-labelledby="sidebar-view-extensions"
        className="flex flex-1 flex-col items-center gap-2 overflow-y-auto py-2"
      >
        {BUILTIN_EXTENSIONS.map((ext) => {
          const on = selectedId === ext.id;
          return (
            <button
              key={ext.id}
              type="button"
              title={ext.name}
              aria-label={ext.name}
              aria-pressed={on || undefined}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                on
                  ? 'bg-gray-800 text-emerald-400'
                  : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'
              }`}
              onClick={() => onSelect?.(ext.id)}
            >
              <ExtensionIcon />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      id="sidebar-panel-extensions"
      role="tabpanel"
      aria-labelledby="sidebar-view-extensions"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <p className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Built-in
        </p>
        <ul className="space-y-1" aria-label="Built-in extensions">
          {BUILTIN_EXTENSIONS.map((ext) => {
            const on = selectedId === ext.id;
            const badge = statusLabel(ext, statuses);
            return (
              <li key={ext.id}>
                <button
                  type="button"
                  aria-pressed={on || undefined}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    on
                      ? 'bg-gray-800 text-gray-100'
                      : 'text-gray-300 hover:bg-gray-800/70 hover:text-gray-100'
                  }`}
                  onClick={() => onSelect?.(ext.id)}
                >
                  <ExtensionIcon />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{ext.name}</span>
                      {ext.builtin ? (
                        <span className="shrink-0 rounded bg-gray-900 px-1 text-[9px] uppercase tracking-wide text-gray-500">
                          built-in
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-gray-500">
                      {ext.description}
                    </span>
                    {badge ? (
                      <span
                        className={`mt-1 inline-block text-[10px] ${
                          badge.ok ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {badge.text}
                      </span>
                    ) : canPersist ? null : (
                      <span className="mt-1 inline-block text-[10px] text-gray-600">
                        Open over HTTP to check status
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
