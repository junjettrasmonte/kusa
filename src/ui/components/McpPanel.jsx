import { useCallback, useEffect, useState } from 'react';
import {
  CloseIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  IconButton,
  KeyIcon,
  SaveIcon,
} from './IconButton.jsx';

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Accessible on/off slider switch (used for the MCP endpoint toggle). */
function SliderToggle({ checked, disabled, onChange, label, hint }) {
  return (
    <div className={`flex items-start justify-between gap-4 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <div className="min-w-0">
        <p className="font-medium text-gray-200">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-gray-500">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 disabled:cursor-not-allowed ${
          checked ? 'bg-emerald-500' : 'bg-gray-700'
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

export function McpPanel({ canPersist = true }) {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [showToken, setShowToken] = useState(false);

  const refresh = useCallback(async () => {
    if (!canPersist) return;
    try {
      const next = await api('/mcp');
      setStatus(next);
      setTokenDraft(next.authToken || '');
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [canPersist]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function patchMcp(body) {
    if (!canPersist || busy) return;
    setBusy(true);
    try {
      const next = await api('/mcp', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setStatus(next);
      setTokenDraft(next.authToken || '');
    } catch (err) {
      window.alert(`Could not update MCP: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value, label) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.alert(`Copy failed — select the ${label} manually.`);
    }
  }

  if (!canPersist) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-gray-400">
          Open the dashboard over HTTP (<code className="text-sky-300">kusa serve</code>) to manage the
          Kusă MCP server.
        </p>
      </div>
    );
  }

  const enabled = Boolean(status?.enabled);
  const endpoint = status?.endpoint || '';
  const tokenDirty = tokenDraft !== (status?.authToken || '');
  const workspace = status?.workspace || 'this project';

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="mb-1 text-base font-semibold">Kusă MCP server</h2>
          <p className="text-xs text-gray-500">
            When on, <code className="text-sky-300">kusa serve</code> exposes a Streamable HTTP MCP
            endpoint on localhost only (<code className="text-sky-300">127.0.0.1</code>) for{' '}
            <span className="text-gray-300">{workspace}</span>, and registers it in{' '}
            <code className="text-sky-300">.cursor/mcp.json</code>. The URL includes a project slug so
            each repo has its own endpoint. Manage tools under{' '}
            <span className="text-gray-300">Harness → Tools</span>.
          </p>
        </div>
        {loadError ? (
          <p className="text-sm text-rose-400">Could not load MCP status: {loadError}</p>
        ) : null}
        <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
          <SliderToggle
            checked={enabled}
            disabled={busy || !status}
            onChange={(v) => patchMcp({ enabled: v })}
            label={enabled ? 'MCP endpoint on' : 'MCP endpoint off'}
            hint={enabled ? `Serving ${endpoint}` : 'Endpoint is not served until turned on'}
          />
          {status?.note ? (
            <p className="mt-3 text-xs text-gray-500">{status.note}</p>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="mb-1 text-base font-semibold">Localhost endpoint</h2>
          <p className="text-xs text-gray-500">
            Bound to <code className="text-sky-300">127.0.0.1</code> only. Path is{' '}
            <code className="text-sky-300">/mcp/&lt;project-slug&gt;/rpc</code>
            {status?.slug ? (
              <>
                {' '}— this workspace: <code className="text-sky-300">{status.slug}</code>
              </>
            ) : null}
            .
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2">
          <code className="min-w-0 flex-1 break-all text-sm text-sky-300">
            {endpoint || '—'}
          </code>
          <IconButton
            label="Copy URL"
            icon={CopyIcon}
            disabled={!endpoint}
            onClick={() => copyText(endpoint, 'endpoint')}
          />
        </div>
        {enabled && status?.entry && status?.serverKey ? (
          <pre className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950/80 p-3 text-xs text-gray-400">
            {JSON.stringify({ [status.serverKey]: status.entry }, null, 2)}
          </pre>
        ) : null}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="mb-1 text-base font-semibold">Authentication</h2>
          <p className="text-xs text-gray-500">
            Optional Bearer token. When set, clients must send{' '}
            <code className="text-sky-300">Authorization: Bearer …</code>. Turning the endpoint on with
            an empty token generates one automatically. Clear the token to allow unauthenticated
            localhost access.
          </p>
        </div>
        <div className="space-y-2 rounded-xl border border-gray-800 bg-gray-900/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type={showToken ? 'text' : 'password'}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="Bearer token"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 font-mono text-sm text-gray-100 placeholder:text-gray-600"
            />
            <IconButton
              label={showToken ? 'Hide token' : 'Show token'}
              icon={showToken ? EyeOffIcon : EyeIcon}
              onClick={() => setShowToken((v) => !v)}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <IconButton
              label="Save token"
              icon={SaveIcon}
              variant="primary"
              disabled={busy || !tokenDirty}
              onClick={() => patchMcp({ authToken: tokenDraft })}
            />
            <IconButton
              label="Generate token"
              icon={KeyIcon}
              disabled={busy}
              onClick={() => patchMcp({ generateAuthToken: true })}
            />
            <IconButton
              label="Clear token"
              icon={CloseIcon}
              disabled={busy || !tokenDraft}
              onClick={() => patchMcp({ clearAuthToken: true })}
            />
            <IconButton
              label="Copy token"
              icon={CopyIcon}
              disabled={!tokenDraft}
              onClick={() => copyText(tokenDraft, 'token')}
            />
          </div>
          <p className="text-xs text-gray-500">
            {status?.authRequired
              ? 'Auth required — registered in .cursor/mcp.json headers.'
              : 'No token — localhost clients may connect without Authorization.'}
          </p>
        </div>
      </section>
    </div>
  );
}
