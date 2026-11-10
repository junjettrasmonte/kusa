/**
 * Connection settings popup — Atlassian Cloud host / email / API token / project key.
 * Token is write-only in the UI; ciphertext lives in .kusa/settings.json.
 */
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Field } from '#ui/shared/SettingsControls.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function emptySettings() {
  return {
    host: '',
    email: '',
    projectKey: '',
    apiTokenSet: false,
    configured: false,
  };
}

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   canPersist?: boolean,
 *   onSaved?: (settings: object) => void,
 * }} props
 */
export function AtlassianSettingsPanel({
  open,
  onClose,
  canPersist = false,
  onSaved,
}) {
  const titleId = useId();
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [settings, setSettings] = useState(emptySettings);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveNote, setSaveNote] = useState('');
  const [probeNote, setProbeNote] = useState('');

  const refresh = useCallback(async () => {
    if (!canPersist) return;
    setBusy(true);
    try {
      const next = await api('/adapters/atlassian/settings');
      const merged = { ...emptySettings(), ...next };
      setSettings(merged);
      setLoadError(null);
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [canPersist]);

  // Run once per open — unstable onClose from the parent used to re-focus the X
  // (and re-fetch) on every parent render, dropping caret / select focus.
  useEffect(() => {
    if (!open) return undefined;
    setSaveNote('');
    setProbeNote('');
    void refresh();
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open, refresh]);

  const savePatch = useCallback(async (patch) => {
    if (!canPersist) return;
    setSaveNote('');
    setProbeNote('');
    try {
      const saved = await api('/adapters/atlassian/settings', {
        method: 'PUT',
        body: patch,
      });
      const merged = { ...emptySettings(), ...saved };
      setSettings(merged);
      setSaveNote('Saved.');
      onSaved?.(merged);
    } catch (err) {
      setSaveNote(err?.message || 'Save failed');
    }
  }, [canPersist, onSaved]);

  const probe = useCallback(async () => {
    if (!canPersist) return;
    setProbeNote('Checking…');
    try {
      const result = await api('/adapters/atlassian');
      if (result.ok) {
        const who = result.me?.displayName || result.me?.emailAddress || 'you';
        const proj = result.project?.name
          ? ` · project ${result.project.key} (${result.project.name})`
          : (settings.projectKey ? '' : ' · set a project key to list tickets');
        setProbeNote(`Connected as ${who}${proj}`);
      } else {
        setProbeNote(result.error || 'Connection failed');
      }
    } catch (err) {
      setProbeNote(err?.message || 'Connection failed');
    }
  }, [canPersist, settings.projectKey]);

  if (!open || typeof document === 'undefined') return null;

  const disabled = !canPersist || busy;
  const summaryHost = settings.host
    ? settings.host.replace(/^https?:\/\//, '')
    : 'not configured';
  const summaryBits = [
    summaryHost,
    settings.email || null,
    settings.projectKey ? `project ${settings.projectKey}` : null,
    settings.apiTokenSet ? 'token set' : 'no token',
  ].filter(Boolean);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(40rem,92vh)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-950 shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-gray-800 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-sm font-semibold text-gray-100">
                Connection
              </h2>
              {settings.configured ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                  ready
                </span>
              ) : (
                <span className="text-[10px] font-medium uppercase tracking-wide text-amber-400">
                  setup
                </span>
              )}
            </div>
            <p className="truncate text-[11px] text-gray-500">
              {summaryBits.join(' · ')}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-900 hover:text-gray-100"
            aria-label="Close connection settings"
            title="Close"
          >
            <LucideIcon name="x" className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          <p className="text-xs text-gray-500">
            Jira Cloud credentials. The API token is encrypted at rest in{' '}
            <code className="text-sky-300">.kusa/settings.json</code> with the same master key as agent
            API keys (<code className="text-sky-300">~/.config/kusa/master.key</code>).
          </p>

          {loadError ? (
            <p className="text-xs text-rose-400">{loadError}</p>
          ) : null}

          <div className="space-y-3">
            <Field
              label="Host"
              hint="Your Atlassian site, e.g. https://your-domain.atlassian.net"
              value={settings.host}
              disabled={disabled}
              placeholder="https://your-domain.atlassian.net"
              resetKey={settings.host}
              onCommit={(v) => {
                setSettings((s) => ({ ...s, host: v }));
                void savePatch({ host: v });
              }}
            />
            <Field
              label="Email"
              hint="Atlassian account email used to mint the API token"
              value={settings.email}
              disabled={disabled}
              placeholder="you@example.com"
              resetKey={settings.email}
              onCommit={(v) => {
                setSettings((s) => ({ ...s, email: v }));
                void savePatch({ email: v });
              }}
            />
            <Field
              label="API token"
              hint="Encrypted at rest. Leave blank to keep the current token. Create one at id.atlassian.com → Security → API tokens."
              value=""
              disabled={disabled}
              placeholder={settings.apiTokenSet ? '••••••••' : 'ATATT3…'}
              type="password"
              resetKey={settings.apiTokenSet ? 'set' : 'empty'}
              onCommit={(v) => {
                const next = String(v || '').trim();
                if (!next) return;
                void savePatch({ apiToken: next });
              }}
            />
            <Field
              label="Default project key"
              hint="Jira space / project key used by the ticket list (e.g. ENG)"
              value={settings.projectKey}
              disabled={disabled}
              placeholder="ENG"
              resetKey={settings.projectKey}
              onCommit={(v) => {
                setSettings((s) => ({ ...s, projectKey: v }));
                void savePatch({ projectKey: v });
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 pb-1">
            <button
              type="button"
              disabled={disabled || !settings.apiTokenSet}
              onClick={() => void probe()}
              className="rounded-md border border-gray-700 bg-gray-950 px-2.5 py-1 text-xs font-medium text-gray-200 hover:border-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Test connection
            </button>
            {saveNote ? <span className="text-xs text-gray-500">{saveNote}</span> : null}
            {probeNote ? <span className="text-xs text-gray-400">{probeNote}</span> : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
