/**
 * Developer Tools › CAO — AWS CLI Agent Orchestrator status, central agent
 * profiles (workflow roles), and workflow editor. Profiles live in
 * `.kusa/agent-profiles/` and are what workflows bind roles to; cao-server
 * mirroring is best-effort when the mapped CLI provider is available.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { stamp } from '#ui/shared/lib/format.js';
import { IconButton, InfoIcon } from '#ui/shared/IconButton.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { SetupGuide } from '#ui/shared/SetupGuide.jsx';
import { Choice, Field } from '#ui/shared/SettingsControls.jsx';

/** CAO toolbar icons — Lucide at 18×18 (InfoIcon stays the custom “i”). */
const ICON_18 = 'h-[18px] w-[18px]';
function LucidePlusIcon({ className = ICON_18 }) {
  return <LucideIcon name="plus" className={className} />;
}
function LucideRefreshIcon({ className = ICON_18 }) {
  return <LucideIcon name="refresh-cw" className={className} />;
}
function LucideSaveIcon({ className = ICON_18 }) {
  return <LucideIcon name="save" className={className} />;
}
function LucideTrashIcon({ className = ICON_18 }) {
  return <LucideIcon name="trash-2" className={className} />;
}
function LucideCloseIcon({ className = ICON_18 }) {
  return <LucideIcon name="x" className={className} />;
}

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

/** CAO provider id → chat provider used by assign / workflows. */
const CAO_TO_CHAT = {
  kusa_cli: 'kusa',
  cursor_cli: 'cursor',
  cursor: 'cursor',
  copilot_cli: 'copilot',
  copilot: 'copilot',
};

const MODE_OPTIONS = [
  { id: 'ask', label: 'Ask' },
  { id: 'plan', label: 'Plan' },
  { id: 'agent', label: 'Agent' },
];

const RULE_CHOICES = [
  { id: 'ask-deny', label: 'Ask · deny' },
  { id: 'ask-allow', label: 'Ask · allow' },
  { id: 'allow', label: 'Allow' },
  { id: 'deny', label: 'Deny' },
];

const EMPTY_DRAFT = {
  name: '',
  provider: 'kusa_cli',
  model: '',
  description: '',
  body: 'You are a specialist worker agent. Complete the assigned task and report back.\n',
  mode: 'agent',
  rules: 'ask-deny',
  requiresPlanStatus: '',
  allowModeOverride: false,
  allowRuleOverride: false,
  allowModelOverride: false,
};

function chatProviderFromCao(caoId) {
  const key = String(caoId || '').trim().toLowerCase();
  return CAO_TO_CHAT[key] || key || 'kusa';
}

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
    mode: draft.mode,
    rules: draft.rules,
    requiresPlanStatus: draft.requiresPlanStatus.trim(),
    allowModeOverride: draft.allowModeOverride === true,
    allowRuleOverride: draft.allowRuleOverride === true,
    allowModelOverride: draft.allowModelOverride === true,
  });
}

function draftFromAgentProfile(profile) {
  const caoProvider = profile?.caoProvider
    || (profile?.provider === 'kusa' ? 'kusa_cli'
      : profile?.provider === 'cursor' ? 'cursor_cli'
        : profile?.provider === 'copilot' ? 'copilot_cli'
          : profile?.provider)
    || 'kusa_cli';
  return {
    name: profile?.id || profile?.name || '',
    provider: caoProvider,
    model: profile?.model || '',
    description: profile?.description || '',
    body: profile?.promptTemplate || '',
    mode: profile?.mode || 'agent',
    rules: profile?.rules || 'ask-deny',
    requiresPlanStatus: profile?.requiresPlanStatus || '',
    allowModeOverride: profile?.allowModeOverride === true,
    allowRuleOverride: profile?.allowRuleOverride === true,
    allowModelOverride: profile?.allowModelOverride === true,
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
  const [workflows, setWorkflows] = useState([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);
  const [workflowDraft, setWorkflowDraft] = useState(null);
  const [workflowBaseline, setWorkflowBaseline] = useState('');

  const dirty = useMemo(() => serializeDraft(draft) !== baseline, [draft, baseline]);
  const creating = selectedName == null;
  const workflowDirty = useMemo(
    () => (workflowDraft ? JSON.stringify(workflowDraft) !== workflowBaseline : false),
    [workflowDraft, workflowBaseline],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) =>
      [p.id, p.name, p.provider, p.caoProvider, p.description].filter(Boolean).join(' ').toLowerCase().includes(q),
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

  // Profile editor mirrors the Providers section toggle: active-only by default.
  // If nothing is active yet (cao-server down / no CLIs), fall back to the full
  // list so profiles remain editable. Always keep the current draft provider.
  const providerOptions = useMemo(() => {
    const base = visibleProviders.length ? visibleProviders : allProviders;
    const byId = new Map(base.map((p) => [p.id, p]));
    if (draft.provider && !byId.has(draft.provider)) {
      const fromAll = allProviders.find((p) => p.id === draft.provider);
      byId.set(draft.provider, fromAll || {
        id: draft.provider,
        label: PROVIDER_LABELS[draft.provider] || draft.provider,
        available: false,
      });
    }
    return [...byId.values()].map((p) => ({
      id: p.id,
      label: p.label || PROVIDER_LABELS[p.id] || p.id,
      available: Boolean(p.available),
    }));
  }, [visibleProviders, allProviders, draft.provider]);

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
      const res = await api('/kusa/agent-profiles');
      setProfiles(res.profiles || []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err?.message || String(err));
    }
  }, [canPersist]);

  const refreshWorkflows = useCallback(async () => {
    if (!canPersist) return;
    try {
      const res = await api('/kusa/workflows');
      setWorkflows(res.workflows || []);
    } catch {
      setWorkflows([]);
    }
  }, [canPersist]);

  const refreshAll = useCallback(async () => {
    if (!canPersist) return;
    setBusy(true);
    try {
      await refreshStatus();
      await Promise.all([refreshProfiles(), refreshWorkflows()]);
    } finally {
      setBusy(false);
    }
  }, [canPersist, refreshStatus, refreshProfiles, refreshWorkflows]);

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
    return window.confirm('Discard unsaved changes to this agent profile?');
  }

  function confirmWorkflowDiscard() {
    if (!workflowDirty) return true;
    return window.confirm('Discard unsaved changes to this workflow?');
  }

  async function selectProfile(name) {
    if (name === selectedName) return;
    if (!confirmDiscard()) return;
    setBusy(true);
    try {
      const res = await api(`/kusa/agent-profiles/${encodeURIComponent(name)}`);
      const next = draftFromAgentProfile(res.profile);
      setSelectedName(name);
      setDraft(next);
      setBaseline(serializeDraft(next));
      setEditable(true);
    } catch (err) {
      window.alert(`Could not load profile: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function startCreate() {
    if (!confirmDiscard()) return;
    setSelectedName(null);
    setEditable(true);
    const preferred = activeProviders[0]?.id || 'kusa_cli';
    const next = { ...EMPTY_DRAFT, provider: preferred };
    setDraft(next);
    setBaseline(serializeDraft(next));
  }

  async function saveDraft() {
    if (!canPersist || busy || !editable) return;
    const name = draft.name.trim().toLowerCase();
    if (!name) {
      window.alert('Name is required.');
      return;
    }
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) {
      window.alert('Name must be lowercase and start with a letter or digit (letters, digits, _, ., -).');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        id: name,
        name: name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description: draft.description.trim(),
        provider: chatProviderFromCao(draft.provider),
        caoProvider: draft.provider,
        model: draft.model.trim(),
        mode: draft.mode || 'agent',
        rules: draft.rules || 'ask-deny',
        promptTemplate: draft.body,
        requiresPlanStatus: draft.requiresPlanStatus.trim() || undefined,
        allowModeOverride: draft.allowModeOverride === true,
        allowRuleOverride: draft.allowRuleOverride === true,
        allowModelOverride: draft.allowModelOverride === true,
      };
      const saved = creating
        ? await api('/kusa/agent-profiles', { method: 'POST', body: JSON.stringify(payload) })
        : await api(`/kusa/agent-profiles/${encodeURIComponent(selectedName)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      const profile = saved.profile || payload;
      // Best-effort mirror to cao-server when it is up (launch --agents <name>).
      if (status.serverUp) {
        try {
          const caoPayload = {
            name: profile.id || name,
            provider: profile.caoProvider || draft.provider,
            model: draft.model.trim(),
            description: draft.description.trim(),
            body: draft.body,
          };
          if (creating) {
            await api('/cao/profiles', { method: 'POST', body: JSON.stringify(caoPayload) });
          } else {
            await api(`/cao/profiles/${encodeURIComponent(selectedName)}`, {
              method: 'PUT',
              body: JSON.stringify(caoPayload),
            }).catch(async () => {
              await api('/cao/profiles', { method: 'POST', body: JSON.stringify(caoPayload) });
            });
          }
        } catch {
          /* cao mirror is optional */
        }
      }
      const nextName = profile.id || name;
      setSelectedName(nextName);
      const next = draftFromAgentProfile(profile);
      setDraft(next);
      setBaseline(serializeDraft(next));
      await refreshProfiles();
    } catch (err) {
      window.alert(`Could not save profile: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile() {
    if (!selectedName || !canPersist || !editable) return;
    if (!window.confirm(`Delete agent profile "${selectedName}"? Workflows that bind this profile will need a new binding.`)) return;
    setBusy(true);
    try {
      await api(`/kusa/agent-profiles/${encodeURIComponent(selectedName)}`, { method: 'DELETE' });
      if (status.serverUp) {
        try {
          await api(`/cao/profiles/${encodeURIComponent(selectedName)}`, { method: 'DELETE' });
        } catch {
          /* optional */
        }
      }
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

  function selectWorkflow(id) {
    if (id === selectedWorkflowId) return;
    if (!confirmWorkflowDiscard()) return;
    const wf = workflows.find((w) => w.id === id);
    if (!wf) return;
    const bindings = wf.roleBindings && typeof wf.roleBindings === 'object' ? wf.roleBindings : {};
    const roles = {};
    for (const [roleName, raw] of Object.entries(bindings)) {
      const profile = typeof raw === 'string'
        ? raw
        : (raw?.profile || (raw?.provider ? '' : roleName));
      roles[roleName] = profile || roleName;
    }
    // Ensure every resolved role name appears even if binding lacked profile.
    for (const roleName of wf.roles || []) {
      if (!roles[roleName]) roles[roleName] = roleName;
    }
    const next = {
      id: wf.id,
      name: wf.name || wf.label || wf.id,
      description: wf.description || '',
      runtime: wf.runtime || '',
      roles,
    };
    setSelectedWorkflowId(id);
    setWorkflowDraft(next);
    setWorkflowBaseline(JSON.stringify(next));
  }

  async function saveWorkflow() {
    if (!canPersist || busy || !workflowDraft?.id) return;
    setBusy(true);
    try {
      const roleBindings = {};
      for (const [roleName, profileId] of Object.entries(workflowDraft.roles || {})) {
        const key = String(roleName || '').trim().toLowerCase();
        const profile = String(profileId || '').trim().toLowerCase();
        if (!key) continue;
        roleBindings[key] = profile ? { profile } : { profile: key };
      }
      const saved = await api(`/kusa/workflows/${encodeURIComponent(workflowDraft.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: workflowDraft.name,
          description: workflowDraft.description,
          runtime: workflowDraft.runtime || undefined,
          roles: roleBindings,
        }),
      });
      await refreshWorkflows();
      const wf = saved.workflow;
      if (wf) {
        const roles = {};
        for (const [roleName, raw] of Object.entries(wf.roleBindings || {})) {
          roles[roleName] = typeof raw === 'string' ? raw : (raw?.profile || roleName);
        }
        const next = {
          id: wf.id,
          name: wf.name || wf.id,
          description: wf.description || '',
          runtime: wf.runtime || '',
          roles,
        };
        setWorkflowDraft(next);
        setWorkflowBaseline(JSON.stringify(next));
      }
    } catch (err) {
      window.alert(`Could not save workflow: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function setWorkflowRoleProfile(roleName, profileId) {
    if (!workflowDraft) return;
    setWorkflowDraft({
      ...workflowDraft,
      roles: { ...workflowDraft.roles, [roleName]: profileId },
    });
  }

  function addWorkflowRole() {
    if (!workflowDraft) return;
    const name = window.prompt('New role name (lowercase id):', '');
    const key = String(name || '').trim().toLowerCase();
    if (!key) return;
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(key)) {
      window.alert('Role name must be lowercase (letters, digits, _, ., -).');
      return;
    }
    if (workflowDraft.roles[key]) {
      window.alert(`Role "${key}" already exists.`);
      return;
    }
    const defaultProfile = profiles[0]?.id || key;
    setWorkflowDraft({
      ...workflowDraft,
      roles: { ...workflowDraft.roles, [key]: defaultProfile },
    });
  }

  function removeWorkflowRole(roleName) {
    if (!workflowDraft || roleName === 'orchestrator') return;
    const nextRoles = { ...workflowDraft.roles };
    delete nextRoles[roleName];
    setWorkflowDraft({ ...workflowDraft, roles: nextRoles });
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
            <IconButton label="Refresh" icon={LucideRefreshIcon} disabled={busy} onClick={refreshAll} />
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
                  each CLI separately. Agent profiles below pick from this same active list.
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

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Agent Profiles</h2>
          <p className="mt-1 text-xs text-gray-500">
            Central role configs under <code className="text-sky-300">.kusa/agent-profiles/</code>
            {' '}— provider, mode, rules, model, and prompt. Workflows bind role names to these
            profiles. Provider chips follow the active-only toggle above
            {s.serverUp ? '; saving also mirrors to cao-server when possible' : ''}.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
          <section className="min-h-[28rem] rounded-xl border border-gray-800 bg-gray-900/40">
            <div className="flex items-center gap-1.5 border-b border-gray-800 p-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search profiles…"
                aria-label="Search agent profiles"
                className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
              />
              <IconButton label="New profile" icon={LucidePlusIcon} disabled={busy} onClick={startCreate} />
              <IconButton label="Refresh" icon={LucideRefreshIcon} disabled={busy} onClick={refreshProfiles} />
            </div>
            <ul className="max-h-[36rem] overflow-y-auto p-1" role="listbox" aria-label="Agent profiles">
              {filtered.length ? filtered.map((p) => {
                const id = p.id || p.name;
                const on = id === selectedName;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={`panel-list-item w-full rounded-md px-2 py-2 text-left transition-colors ${
                        on ? 'panel-list-item-active' : 'hover:bg-gray-800/80'
                      }`}
                      onClick={() => selectProfile(id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-gray-100">{p.name || id}</span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-emerald-400">
                          {p.mode || 'agent'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-gray-500">
                        {PROVIDER_LABELS[p.caoProvider] || p.caoProvider || p.provider || 'provider unset'}
                        {p.model ? ` · ${p.model}` : ''}
                      </p>
                    </button>
                  </li>
                );
              }) : (
                <li className="px-3 py-4 text-xs text-gray-500">No agent profiles yet.</li>
              )}
            </ul>
          </section>

          <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-gray-200">
                {creating ? 'New profile' : `Edit · ${selectedName}`}
              </h3>
              <div className="flex items-center gap-1">
                <IconButton
                  label="Save"
                  icon={LucideSaveIcon}
                  disabled={busy || !editable || !dirty}
                  onClick={saveDraft}
                />
                {!creating && editable ? (
                  <IconButton
                    label="Delete"
                    icon={LucideTrashIcon}
                    disabled={busy}
                    onClick={removeProfile}
                  />
                ) : null}
              </div>
            </div>

            <Field
              label="Name"
              hint="Profile id (lowercase). Workflows bind roles to this id."
              value={draft.name}
              disabled={busy || !editable || !creating}
              placeholder="planner"
              resetKey={`${selectedName || 'new'}:${draft.name}`}
              onCommit={(v) => setDraft({ ...draft, name: v })}
            />

            <div>
              <p className="mb-1 text-sm text-gray-300">Provider</p>
              <div className="flex flex-wrap gap-2">
                {providerOptions.length ? providerOptions.map((p) => (
                  <Choice
                    key={p.id}
                    active={draft.provider === p.id}
                    disabled={busy || !editable}
                    onClick={() => setDraft({ ...draft, provider: p.id })}
                    label={p.available === false ? `${p.label} · off` : p.label}
                  />
                )) : (
                  <p className="text-xs text-gray-500">
                    No active providers. Use “Show all supported providers” above, or start cao-server.
                  </p>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Same active-only list as Providers above. Maps to the chat provider workflows assign with.
              </p>
            </div>

            <div>
              <p className="mb-1 text-sm text-gray-300">Mode</p>
              <div className="flex flex-wrap gap-2">
                {MODE_OPTIONS.map((m) => (
                  <Choice
                    key={m.id}
                    active={draft.mode === m.id}
                    disabled={busy || !editable}
                    onClick={() => setDraft({ ...draft, mode: m.id })}
                    label={m.label}
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 text-sm text-gray-300">Rules</p>
              <div className="flex flex-wrap gap-2">
                {RULE_CHOICES.map((r) => (
                  <Choice
                    key={r.id}
                    active={draft.rules === r.id}
                    disabled={busy || !editable}
                    onClick={() => setDraft({ ...draft, rules: r.id })}
                    label={r.label}
                  />
                ))}
              </div>
            </div>

            <Field
              label="Model"
              hint="Optional. Blank / auto → Settings → Kusă agent default."
              value={draft.model}
              disabled={busy || !editable}
              placeholder="optional"
              resetKey={`${selectedName || 'new'}:model:${draft.model}`}
              onCommit={(v) => setDraft({ ...draft, model: v })}
            />

            <Field
              label="Description"
              hint="Short summary for profile lists."
              value={draft.description}
              disabled={busy || !editable}
              placeholder="Creates implementation plans"
              resetKey={`${selectedName || 'new'}:desc:${draft.description}`}
              onCommit={(v) => setDraft({ ...draft, description: v })}
            />

            <Field
              label="Requires plan status"
              hint="Optional gate for assign (e.g. approved for executor)."
              value={draft.requiresPlanStatus}
              disabled={busy || !editable}
              placeholder="approved"
              resetKey={`${selectedName || 'new'}:plan:${draft.requiresPlanStatus}`}
              onCommit={(v) => setDraft({ ...draft, requiresPlanStatus: v })}
            />

            <div className="flex flex-wrap gap-3 text-xs text-gray-400">
              {[
                ['allowModeOverride', 'Allow mode override'],
                ['allowRuleOverride', 'Allow rule override'],
                ['allowModelOverride', 'Allow model override'],
              ].map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draft[key] === true}
                    disabled={busy || !editable}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>

            <label className="block">
              <span className="mb-1 block text-sm text-gray-300">Prompt template</span>
              <textarea
                value={draft.body}
                disabled={busy || !editable}
                rows={10}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 placeholder:text-gray-600 disabled:opacity-50"
              />
              <span className="mt-1 block text-xs text-gray-500">
                Role instructions. Placeholders: {'{{prompt}}'}, {'{{planName}}'}, {'{{planBody}}'}.
              </span>
            </label>
          </section>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Workflows</h2>
          <p className="mt-1 text-xs text-gray-500">
            Bind each workflow role to an agent profile. Orchestrated Agents use these bindings
            when assigning Subagents.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
          <section className="min-h-[16rem] rounded-xl border border-gray-800 bg-gray-900/40">
            <div className="flex items-center justify-between gap-1.5 border-b border-gray-800 p-2">
              <span className="px-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                Workflows
              </span>
              <IconButton label="Refresh" icon={LucideRefreshIcon} disabled={busy} onClick={refreshWorkflows} />
            </div>
            <ul className="max-h-[24rem] overflow-y-auto p-1" role="listbox" aria-label="Workflows">
              {workflows.length ? workflows.map((wf) => {
                const on = wf.id === selectedWorkflowId;
                return (
                  <li key={wf.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={`panel-list-item w-full rounded-md px-2 py-2 text-left transition-colors ${
                        on ? 'panel-list-item-active' : 'hover:bg-gray-800/80'
                      }`}
                      onClick={() => selectWorkflow(wf.id)}
                    >
                      <span className="block truncate text-sm font-medium text-gray-100">
                        {wf.name || wf.label || wf.id}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-gray-500">
                        {(wf.roles || []).length} roles
                        {wf.runtime ? ` · ${wf.runtime}` : ''}
                      </span>
                    </button>
                  </li>
                );
              }) : (
                <li className="px-3 py-4 text-xs text-gray-500">
                  No workflows yet. Seeded plan-execute appears after serve starts.
                </li>
              )}
            </ul>
          </section>

          <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/40 p-3">
            {workflowDraft ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-gray-200">
                    Edit · {workflowDraft.id}
                  </h3>
                  <IconButton
                    label="Save workflow"
                    icon={LucideSaveIcon}
                    disabled={busy || !workflowDirty}
                    onClick={saveWorkflow}
                  />
                </div>

                <Field
                  label="Name"
                  value={workflowDraft.name}
                  disabled={busy}
                  placeholder="Plan then Execute"
                  resetKey={`${workflowDraft.id}:name:${workflowDraft.name}`}
                  onCommit={(v) => setWorkflowDraft({ ...workflowDraft, name: v })}
                />
                <Field
                  label="Description"
                  value={workflowDraft.description}
                  disabled={busy}
                  placeholder="What this workflow does"
                  resetKey={`${workflowDraft.id}:desc:${workflowDraft.description}`}
                  onCommit={(v) => setWorkflowDraft({ ...workflowDraft, description: v })}
                />

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-gray-300">Role → profile</p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={addWorkflowRole}
                      className="text-xs text-sky-400 hover:text-sky-300"
                    >
                      Add role
                    </button>
                  </div>
                  {Object.keys(workflowDraft.roles || {}).length ? (
                    <ul className="space-y-2">
                      {Object.entries(workflowDraft.roles).map(([roleName, profileId]) => (
                        <li
                          key={roleName}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-gray-800 bg-gray-950/60 px-2 py-1.5"
                        >
                          <span className="min-w-[6rem] text-xs font-medium text-gray-200">{roleName}</span>
                          <select
                            value={profileId || ''}
                            disabled={busy}
                            onChange={(e) => setWorkflowRoleProfile(roleName, e.target.value)}
                            className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
                          >
                            {!profiles.some((p) => p.id === profileId) && profileId ? (
                              <option value={profileId}>{profileId} (missing)</option>
                            ) : null}
                            {profiles.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name || p.id}
                              </option>
                            ))}
                          </select>
                          {roleName !== 'orchestrator' ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => removeWorkflowRole(roleName)}
                              className="text-[10px] text-rose-400 hover:text-rose-300"
                            >
                              Remove
                            </button>
                          ) : (
                            <span className="text-[10px] uppercase tracking-wide text-gray-600">parent</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-gray-500">No roles bound yet.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-xs text-gray-500">
                Select a workflow to edit role → profile bindings.
              </p>
            )}
          </section>
        </div>
      </section>
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
            icon={LucideCloseIcon}
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
