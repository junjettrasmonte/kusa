/**
 * Developer Tools › CAO — AWS CLI Agent Orchestrator status and connection
 * (agent-profile) management. Profiles select a provider CLI and are the
 * writable unit CAO exposes for add / edit / delete.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { stamp } from '#ui/shared/lib/format.js';
import {
  CloseIcon,
  IconButton,
  InfoIcon,
  PlusIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
} from '#ui/shared/IconButton.jsx';
import { SetupGuide } from '#ui/shared/SetupGuide.jsx';
import { Choice, Field } from '#ui/shared/SettingsControls.jsx';

const CAO_DOCS = 'https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs';

const PROVIDER_FALLBACK = [
  'kusa_cli',
  'kiro_cli',
  'claude_code',
  'codex',
  'cursor_cli',
  'copilot_cli',
  'opencode_cli',
  'hermes',
  'kimi_cli',
  'mcode',
  'omp',
  'antigravity_cli',
  'grok_cli',
];

const PROVIDER_LABELS = {
  kusa_cli: 'Kusa CLI',
  kiro_cli: 'Kiro CLI',
  claude_code: 'Claude Code',
  codex: 'Codex CLI',
  antigravity_cli: 'Antigravity CLI',
  hermes: 'Hermes',
  kimi_cli: 'Kimi CLI',
  mcode: 'MiniMax Code',
  copilot_cli: 'GitHub Copilot CLI',
  opencode_cli: 'OpenCode CLI',
  omp: 'Oh My Pi (OMP)',
  cursor_cli: 'Cursor CLI',
  grok_cli: 'Grok Build CLI',
};

/** Install / auth steps shown from each provider tile’s info popup. */
const PROVIDER_INSTALL = {
  kusa_cli: {
    docsUrl: null,
    steps: [
      'Ensure `kusa` is on PATH (this package’s bin)',
      'Configure Settings → Kusă agent (OpenAI-compatible endpoint in .kusa/settings.json)',
      'npm run cao:provider:install',
      'Restart cao-server',
      'Verify: curl -s http://127.0.0.1:9889/agents/providers | grep kusa_cli',
    ],
  },
  kiro_cli: {
    docsUrl: `${CAO_DOCS}/kiro-cli.md`,
    steps: [
      'npm install -g @anthropic-ai/kiro-cli',
      'Configure AWS credentials for Kiro CLI',
      'kiro-cli --version',
      'cao launch --agents developer --provider kiro_cli',
    ],
  },
  claude_code: {
    docsUrl: `${CAO_DOCS}/claude-code.md`,
    steps: [
      'npm install -g @anthropic-ai/claude-code',
      'claude setup-token',
      'cao launch --agents developer --provider claude_code',
    ],
  },
  codex: {
    docsUrl: `${CAO_DOCS}/codex-cli.md`,
    steps: [
      'npm install -g @openai/codex',
      'codex login   # or export OPENAI_API_KEY=…',
      'cao launch --agents developer --provider codex',
    ],
  },
  cursor_cli: {
    docsUrl: `${CAO_DOCS}/cursor-cli.md`,
    steps: [
      'curl https://cursor.com/install -fsS | bash',
      'agent login',
      'cao launch --agents developer --provider cursor_cli',
    ],
  },
  copilot_cli: {
    docsUrl: `${CAO_DOCS}/copilot-cli.md`,
    steps: [
      'npm install -g @github/copilot',
      'copilot login',
      'copilot --version',
      'cao launch --agents developer --provider copilot_cli',
    ],
  },
  opencode_cli: {
    docsUrl: `${CAO_DOCS}/opencode-cli.md`,
    steps: [
      'npm install -g opencode-ai   # or: curl -fsSL https://opencode.ai/install | bash',
      'Configure model auth per OpenCode docs',
      'cao install developer --provider opencode_cli',
      'cao launch --agents developer --provider opencode_cli',
    ],
  },
  hermes: {
    docsUrl: `${CAO_DOCS}/hermes.md`,
    steps: [
      'Install Hermes Agent and put `hermes` on PATH',
      'Authenticate Hermes outside CAO (run hermes once)',
      'Optional: hermes profile alias <name> for a worker wrapper',
      'cao launch --agents <profile> --provider hermes',
    ],
  },
  kimi_cli: {
    docsUrl: `${CAO_DOCS}/kimi-cli.md`,
    steps: [
      'brew install kimi-cli   # or: uv tool install kimi-cli',
      'kimi login',
      'kimi --version',
      'cao launch --agents code_supervisor --provider kimi_cli',
    ],
  },
  mcode: {
    docsUrl: `${CAO_DOCS}/minimax-code.md`,
    steps: [
      'npm install -g @minimax-ai/code',
      'mcode login',
      'mcode --version',
      'cao install developer --provider mcode',
      'cao launch --agents developer --provider mcode',
    ],
  },
  omp: {
    docsUrl: `${CAO_DOCS}/omp-cli.md`,
    steps: [
      'Install Oh My Pi so `omp` is on PATH (https://github.com/can1357/oh-my-pi)',
      'omp --version',
      'Run omp once and complete its normal auth flow',
      'cao install developer --provider omp',
      'cao launch --agents developer --provider omp',
    ],
  },
  antigravity_cli: {
    docsUrl: `${CAO_DOCS}/antigravity-cli.md`,
    steps: [
      'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      'agy   # complete Google sign-in + onboarding',
      'agy --version && agy models',
      'cao launch --agents developer --provider antigravity_cli',
    ],
  },
  grok_cli: {
    docsUrl: `${CAO_DOCS}/grok-cli.md`,
    steps: [
      'curl -fsSL https://x.ai/cli/install.sh | bash',
      'grok login   # or export XAI_API_KEY=…',
      'grok --version && grok models',
      'cao install developer --provider grok_cli',
      'cao launch --agents developer --provider grok_cli',
    ],
  },
};

function providerInstallGuide(id) {
  return PROVIDER_INSTALL[id] || {
    docsUrl: 'https://github.com/awslabs/cli-agent-orchestrator#prerequisites',
    steps: [
      `Install and authenticate the “${PROVIDER_LABELS[id] || id}” CLI so its binary is on PATH`,
      'Restart cao-server so GET /agents/providers re-detects it',
      `cao launch --agents developer --provider ${id}`,
    ],
  };
}

const EMPTY_DRAFT = {
  name: '',
  provider: 'kusa_cli',
  model: '',
  description: '',
  body: 'You are a specialist worker agent. Complete the assigned task and report back.\n',
};

function emptyStatus() {
  return {
    ok: false,
    checkedAt: null,
    installed: false,
    version: null,
    serverUp: false,
    baseUrl: 'http://127.0.0.1:9889',
    webUiUrl: 'http://localhost:9889',
    providers: [],
    sessions: [],
    error: null,
    steps: [],
  };
}

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
    const err = new Error(data?.error || data?.detail?.message || data?.detail || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function serializeDraft(draft) {
  return JSON.stringify({
    name: draft.name.trim(),
    provider: draft.provider,
    model: draft.model.trim(),
    description: draft.description.trim(),
    body: draft.body,
  });
}

function draftFromProfile(profile, parsed) {
  return {
    name: parsed?.name || profile?.name || '',
    provider: parsed?.provider || profile?.provider || 'kusa_cli',
    model: parsed?.model || profile?.model || '',
    description: parsed?.description || profile?.description || '',
    body: parsed?.body || '',
  };
}

export function CaoPanel({ canPersist = false }) {
  const [status, setStatus] = useState(emptyStatus);
  const [profiles, setProfiles] = useState([]);
  const [selectedName, setSelectedName] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState(() => serializeDraft(EMPTY_DRAFT));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [editable, setEditable] = useState(true);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [installInfoId, setInstallInfoId] = useState(null);
  const [starting, setStarting] = useState(false);
  const [startNote, setStartNote] = useState('');

  const dirty = useMemo(() => serializeDraft(draft) !== baseline, [draft, baseline]);
  const creating = selectedName == null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) =>
      [p.name, p.provider, p.description, p.source].filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }, [profiles, query]);

  const allProviders = useMemo(() => {
    const byId = new Map();
    for (const id of PROVIDER_FALLBACK) {
      byId.set(id, {
        id,
        label: PROVIDER_LABELS[id] || id,
        available: false,
      });
    }
    for (const p of status.providers || []) {
      if (!p?.id) continue;
      const prev = byId.get(p.id) || {};
      byId.set(p.id, {
        ...prev,
        ...p,
        id: p.id,
        label: p.label || PROVIDER_LABELS[p.id] || p.id,
        available: Boolean(p.available),
      });
    }
    return [...byId.values()];
  }, [status.providers]);

  const activeProviders = useMemo(
    () => allProviders.filter((p) => p.available),
    [allProviders],
  );

  const visibleProviders = showAllProviders ? allProviders : activeProviders;

  const providerOptions = useMemo(() => {
    const fromStatus = (status.providers || []).map((p) => p.id).filter(Boolean);
    const ids = [...new Set([...fromStatus, ...PROVIDER_FALLBACK])];
    return ids.map((id) => ({
      id,
      label: PROVIDER_LABELS[id] || id,
      available: (status.providers || []).find((p) => p.id === id)?.available,
    }));
  }, [status.providers]);

  const refreshStatus = useCallback(async () => {
    if (!canPersist) return;
    try {
      const next = await api('/cao');
      setStatus(next);
      setLoadError(null);
      return next;
    } catch (err) {
      setLoadError(err?.message || String(err));
      return null;
    }
  }, [canPersist]);

  const refreshProfiles = useCallback(async () => {
    if (!canPersist) return;
    try {
      const res = await api('/cao/profiles');
      setProfiles(res.profiles || []);
      setLoadError(null);
    } catch (err) {
      // Server down — status panel owns the setup guide; keep list empty.
      if (err?.status === 503 || /cao-server|not reachable|ECONN/i.test(err?.message || '')) {
        setProfiles([]);
        return;
      }
      setLoadError(err?.message || String(err));
    }
  }, [canPersist]);

  const refreshAll = useCallback(async () => {
    if (!canPersist) return;
    setBusy(true);
    try {
      await refreshStatus();
      await refreshProfiles();
    } finally {
      setBusy(false);
    }
  }, [canPersist, refreshStatus, refreshProfiles]);

  const startServer = useCallback(async () => {
    if (!canPersist || starting) return;
    setStarting(true);
    setStartNote('');
    try {
      const result = await api('/cao/server/start', { method: 'POST' });
      if (result?.status) setStatus(result.status);
      else await refreshStatus();
      setStartNote(result?.alreadyUp
        ? 'cao-server was already up.'
        : 'cao-server started.');
      await refreshProfiles();
    } catch (err) {
      const data = err?.data;
      if (data?.status) setStatus(data.status);
      else await refreshStatus();
      setStartNote(data?.error || err?.message || 'Could not start cao-server');
    } finally {
      setStarting(false);
    }
  }, [canPersist, starting, refreshStatus, refreshProfiles]);

  useEffect(() => {
    if (!canPersist) return undefined;
    refreshAll();
    const id = setInterval(refreshStatus, 5000);
    return () => clearInterval(id);
  }, [canPersist, refreshAll, refreshStatus]);

  function confirmDiscard() {
    if (!dirty) return true;
    return window.confirm('Discard unsaved changes to this connection?');
  }

  async function selectProfile(name) {
    if (name === selectedName) return;
    if (!confirmDiscard()) return;
    setBusy(true);
    try {
      const res = await api(`/cao/profiles/${encodeURIComponent(name)}`);
      const next = draftFromProfile(res.profile, res.parsed);
      setSelectedName(name);
      setDraft(next);
      setBaseline(serializeDraft(next));
      setEditable(res.editable !== false);
    } catch (err) {
      window.alert(`Could not load connection: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function startCreate() {
    if (!confirmDiscard()) return;
    setSelectedName(null);
    setEditable(true);
    const next = { ...EMPTY_DRAFT };
    setDraft(next);
    setBaseline(serializeDraft(next));
  }

  async function saveDraft() {
    if (!canPersist || busy || !editable) return;
    const name = draft.name.trim();
    if (!name) {
      window.alert('Name is required.');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      window.alert('Name must start with a letter or digit and use only letters, digits, _, ., -');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name,
        provider: draft.provider,
        model: draft.model.trim(),
        description: draft.description.trim(),
        body: draft.body,
      };
      let saved;
      if (creating) {
        saved = await api('/cao/profiles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } else {
        saved = await api(`/cao/profiles/${encodeURIComponent(selectedName)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      }
      const nextName = saved.name || name;
      setSelectedName(nextName);
      const next = { ...payload, name: nextName };
      setDraft(next);
      setBaseline(serializeDraft(next));
      await refreshProfiles();
    } catch (err) {
      window.alert(`Could not save connection: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile() {
    if (!selectedName || !canPersist || !editable) return;
    if (!window.confirm(`Delete CAO connection "${selectedName}"?`)) return;
    setBusy(true);
    try {
      await api(`/cao/profiles/${encodeURIComponent(selectedName)}`, { method: 'DELETE' });
      setSelectedName(null);
      setEditable(true);
      const next = { ...EMPTY_DRAFT };
      setDraft(next);
      setBaseline(serializeDraft(next));
      await refreshProfiles();
    } catch (err) {
      window.alert(`Could not delete: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!canPersist) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          The CAO panel needs the local server (<code className="text-sky-300">kusa serve</code>).
          Open the dashboard over HTTP to check cao-server and manage provider connections.
        </p>
      </div>
    );
  }

  const s = status || emptyStatus();

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">CLI Agent Orchestrator</h2>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>
              {s.checkedAt ? `Checked ${stamp(s.checkedAt)}` : 'Not checked yet'}
              {' · live'}
            </span>
            <IconButton label="Refresh" icon={RefreshIcon} disabled={busy} onClick={refreshAll} />
          </div>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Local multi-agent orchestration from{' '}
          <a
            className="text-sky-300 hover:underline"
            href="https://github.com/awslabs/cli-agent-orchestrator"
            target="_blank"
            rel="noreferrer"
          >
            awslabs/cli-agent-orchestrator
          </a>
          . Supervisor + worker CLIs talk over MCP; this panel proxies{' '}
          <code className="text-sky-300">cao-server</code> at{' '}
          <code className="text-sky-300">{s.baseUrl}</code>.
        </p>
        {loadError ? (
          <p className="mb-3 text-xs text-amber-400">Live check failed: {loadError}</p>
        ) : null}

        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <StatusChip
            label="CLI"
            value={s.installed ? (s.version ? `cao ${s.version}` : 'installed') : 'missing'}
            ok={s.installed}
          />
          <StatusChip
            label="Server"
            value={s.serverUp ? 'up' : 'down'}
            ok={s.serverUp}
          />
          <StatusChip
            label="Sessions"
            value={String((s.sessions || []).length)}
            ok={s.serverUp}
          />
          <StatusChip
            label="Web UI"
            value={s.webUiUrl}
            ok={s.serverUp}
            href={s.serverUp ? s.webUiUrl : null}
          />
        </div>

        {!s.ok ? (
          <SetupGuide
            title={s.installed ? 'Start cao-server' : 'Install CAO'}
            summary={s.error}
            steps={s.steps}
            action={s.installed ? {
              label: 'Start cao-server',
              busyLabel: 'Starting cao-server…',
              busy: starting,
              disabled: busy,
              onClick: startServer,
            } : null}
            footnote={
              startNote
                ? startNote
                : 'After installing or starting the server, click Refresh — this panel polls /cao while open.'
            }
          />
        ) : null}
      </section>

      {s.ok ? (
        <section>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Providers</h2>
            <button
              type="button"
              className="text-xs text-sky-400 hover:text-sky-300"
              onClick={() => setShowAllProviders((on) => !on)}
            >
              {showAllProviders
                ? 'Show active only'
                : `Show all supported providers (${allProviders.length})`}
            </button>
          </div>
          <p className="mb-3 text-xs text-gray-500">
            {showAllProviders
              ? 'Every provider CAO knows about. Active ones are detected on PATH; others need install + auth. Use the info icon for steps.'
              : (
                <>
                  Active provider CLIs from <code className="text-sky-300">GET /agents/providers</code>
                  {' '}({activeProviders.length}). Availability is read-only — install and authenticate
                  each CLI separately. Connections below pick one of these providers.
                </>
              )}
          </p>
          <ul className="flex flex-wrap gap-2">
            {visibleProviders.length
              ? visibleProviders.map((p) => (
                <li
                  key={p.id}
                  className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium ${
                    p.available
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-gray-700 bg-gray-950 text-gray-500'
                  }`}
                  title={p.error || p.path || p.id}
                >
                  <span>
                    {p.label || PROVIDER_LABELS[p.id] || p.id}
                    {p.available ? '' : ' · unavailable'}
                  </span>
                  <button
                    type="button"
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors ${
                      p.available
                        ? 'text-emerald-400/80 hover:bg-emerald-500/20 hover:text-emerald-200'
                        : 'text-gray-500 hover:bg-gray-800 hover:text-gray-300'
                    }`}
                    title={`Install ${p.label || p.id}`}
                    aria-label={`Install instructions for ${p.label || p.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setInstallInfoId(p.id);
                    }}
                  >
                    <InfoIcon className="h-3 w-3" />
                  </button>
                </li>
              ))
              : (
                <li className="text-xs text-gray-500">
                  {showAllProviders
                    ? 'No known providers to list.'
                    : 'No active providers detected. Show all supported providers for install steps.'}
                </li>
              )}
          </ul>
          {installInfoId ? (
            <ProviderInstallModal
              providerId={installInfoId}
              label={PROVIDER_LABELS[installInfoId] || installInfoId}
              available={Boolean(allProviders.find((p) => p.id === installInfoId)?.available)}
              onClose={() => setInstallInfoId(null)}
            />
          ) : null}
        </section>
      ) : null}

      {s.ok ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">Connections</h2>
            <p className="mt-1 text-xs text-gray-500">
              Agent profiles in CAO&apos;s local store — add, edit, or delete a connection that
              binds a name to a provider CLI. Built-in / provider-managed profiles are read-only.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
            <section className="min-h-[28rem] rounded-xl border border-gray-800 bg-gray-900/40">
              <div className="flex items-center gap-1.5 border-b border-gray-800 p-2">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search connections…"
                  aria-label="Search connections"
                  className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
                />
                <IconButton label="New connection" icon={PlusIcon} disabled={busy} onClick={startCreate} />
                <IconButton label="Refresh" icon={RefreshIcon} disabled={busy} onClick={refreshProfiles} />
              </div>
              <ul className="max-h-[36rem] overflow-y-auto p-1" role="listbox" aria-label="CAO connections">
                {filtered.length ? filtered.map((p) => {
                  const on = p.name === selectedName;
                  return (
                    <li key={p.name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={`panel-list-item w-full rounded-md px-2 py-2 text-left transition-colors ${
                          on ? 'panel-list-item-active' : 'hover:bg-gray-800/80'
                        }`}
                        onClick={() => selectProfile(p.name)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-gray-100">{p.name}</span>
                          <span className={`shrink-0 text-[10px] uppercase tracking-wide ${
                            p.editable === false || p.builtin ? 'text-sky-300' : 'text-emerald-400'
                          }`}
                          >
                            {p.editable === false || p.builtin ? 'Built-in' : 'Local'}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-gray-500">
                          {PROVIDER_LABELS[p.provider] || p.provider || 'provider unset'}
                          {p.model ? ` · ${p.model}` : ''}
                        </p>
                      </button>
                    </li>
                  );
                }) : (
                  <li className="px-3 py-4 text-xs text-gray-500">No connections yet.</li>
                )}
              </ul>
            </section>

            <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-gray-200">
                  {creating ? 'New connection' : `Edit · ${selectedName}`}
                </h3>
                <div className="flex items-center gap-1">
                  <IconButton
                    label="Save"
                    icon={SaveIcon}
                    disabled={busy || !editable || !dirty}
                    onClick={saveDraft}
                  />
                  {!creating && editable ? (
                    <IconButton
                      label="Delete"
                      icon={TrashIcon}
                      disabled={busy}
                      onClick={removeProfile}
                    />
                  ) : null}
                </div>
              </div>

              {!editable ? (
                <p className="text-xs text-amber-400">
                  This profile is built-in or provider-managed and cannot be edited here.
                </p>
              ) : null}

              <Field
                label="Name"
                hint="Profile id in CAO’s local store (letters, digits, _, ., -)."
                value={draft.name}
                disabled={busy || !editable || !creating}
                placeholder="code_reviewer"
                resetKey={`${selectedName || 'new'}:${draft.name}`}
                onCommit={(v) => setDraft({ ...draft, name: v })}
              />

              <div>
                <p className="mb-1 text-sm text-gray-300">Provider</p>
                <div className="flex flex-wrap gap-2">
                  {providerOptions.map((p) => (
                    <Choice
                      key={p.id}
                      active={draft.provider === p.id}
                      disabled={busy || !editable}
                      onClick={() => setDraft({ ...draft, provider: p.id })}
                      label={p.label}
                    />
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  The CLI backend this connection launches. Must be installed and authenticated on this machine.
                </p>
              </div>

              <Field
                label="Model"
                hint="Optional provider model id (passed through as profile frontmatter)."
                value={draft.model}
                disabled={busy || !editable}
                placeholder="optional"
                resetKey={`${selectedName || 'new'}:model:${draft.model}`}
                onCommit={(v) => setDraft({ ...draft, model: v })}
              />

              <Field
                label="Description"
                hint="Short summary shown in CAO profile lists."
                value={draft.description}
                disabled={busy || !editable}
                placeholder="Reviews PRs for security issues"
                resetKey={`${selectedName || 'new'}:desc:${draft.description}`}
                onCommit={(v) => setDraft({ ...draft, description: v })}
              />

              <label className="block">
                <span className="mb-1 block text-sm text-gray-300">Instructions</span>
                <textarea
                  value={draft.body}
                  disabled={busy || !editable}
                  rows={10}
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 placeholder:text-gray-600 disabled:opacity-50"
                />
                <span className="mt-1 block text-xs text-gray-500">
                  Markdown body after the YAML frontmatter — the agent&apos;s system instructions.
                </span>
              </label>
            </section>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StatusChip({ label, value, ok, href }) {
  const body = (
    <div className={`rounded-xl border px-3 py-2 ${
      ok ? 'border-gray-800 bg-gray-900/60' : 'border-amber-900/50 bg-amber-950/20'
    }`}
    >
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-0.5 truncate text-sm ${ok ? 'text-gray-100' : 'text-amber-200'} ${href ? 'text-sky-300 hover:underline' : ''}`}>
        {value}
      </p>
    </div>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="block">
        {body}
      </a>
    );
  }
  return body;
}

function ProviderInstallModal({ providerId, label, available, onClose }) {
  const titleId = useId();
  const closeRef = useRef(null);
  const guide = providerInstallGuide(providerId);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(80vh,36rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-gray-100">
              Install · {label}
            </h2>
            <p className="mt-0.5 text-[11px] text-gray-500">
              <code className="text-sky-300">{providerId}</code>
              {available ? ' · currently active' : ' · not detected on PATH'}
            </p>
          </div>
          <IconButton
            ref={closeRef}
            label="Close"
            icon={CloseIcon}
            onClick={onClose}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-300">
            {guide.steps.map((step) => (
              <li key={step}>
                <code className="whitespace-pre-wrap break-words font-mono text-[12px] text-sky-300">
                  {step}
                </code>
              </li>
            ))}
          </ol>
          {guide.docsUrl ? (
            <p className="text-xs text-gray-500">
              Full guide:{' '}
              <a
                href={guide.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:underline"
              >
                CAO provider docs
              </a>
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              Kusa CLI is a standalone feature (`kusa agent`); optional CAO
              provider patch at{' '}
              <code className="text-sky-300">src/features/kusa-cli/cao-provider/</code>.
            </p>
          )}
          <p className="text-xs text-gray-500">
            After install, restart <code className="text-sky-300">cao-server</code> and refresh this tab.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
