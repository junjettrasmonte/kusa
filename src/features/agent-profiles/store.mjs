/**
 * Central agent profiles under `.kusa/agent-profiles/`.
 *
 * Workflow roles reference these by id (`{ profile: "planner" }`). Profile
 * fields are the composer triad (provider / mode / rules / model) plus the
 * prompt template — the same shape formerly inlined under workflow `roles`.
 *
 * CAO Connections on the Dev Tools panel edit these profiles and optionally
 * mirror them to cao-server when a CAO provider mapping exists.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeApprovalMode } from '#features/agent/approval.mjs';

const PROFILES_DIR = 'agent-profiles';

/**
 * Built-in profiles mirrored from the plan-execute workflow roles.
 * Seeded once into `.kusa/agent-profiles/`; workflows reference them by id.
 */
export const SEED_AGENT_PROFILES = Object.freeze({
  orchestrator: {
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'Parent Agent that assigns work to other roles.',
    provider: 'kusa',
    mode: 'agent',
    rules: 'ask-deny',
    model: '',
    allowModeOverride: true,
    allowRuleOverride: true,
    allowModelOverride: true,
    promptTemplate:
      'You are the Orchestrator. Do not implement yourself — assign work to '
      + 'other roles with kusa_assign.\n\n{{prompt}}',
  },
  planner: {
    id: 'planner',
    name: 'Planner',
    description: 'Creates an implementation plan (no code changes yet).',
    provider: 'cursor',
    mode: 'plan',
    rules: 'ask-deny',
    model: '',
    promptTemplate:
      'Create a concrete implementation plan for the following request. '
      + 'Use kusa_plan_create (or kusa_plan_update) so the plan appears in the Plan drawer; '
      + 'if the plan already exists as a file in the workspace, kusa_plan_ingest it instead. '
      + 'Do not implement yet.\n\n{{prompt}}',
  },
  executor: {
    id: 'executor',
    name: 'Executor',
    description: 'Implements an approved plan.',
    provider: 'kusa',
    mode: 'agent',
    rules: 'ask-deny',
    model: '',
    allowModeOverride: true,
    allowRuleOverride: true,
    allowModelOverride: true,
    requiresPlanStatus: 'approved',
    promptTemplate:
      'Implement the approved plan below. Do not rewrite the plan body — execute the steps. '
      + 'When the implementation is finished, call kusa_plan_complete so the Plan drawer marks it done.\n\n'
      + '## Plan: {{planName}}\n\n{{planBody}}\n\n## Original request\n\n{{prompt}}',
  },
  tester: {
    id: 'tester',
    name: 'Tester',
    description: 'Tests the work and fixes only what the tests require.',
    provider: 'kusa',
    mode: 'agent',
    rules: 'ask-deny',
    model: '',
    allowModeOverride: true,
    allowRuleOverride: true,
    allowModelOverride: true,
    promptTemplate:
      'Test the work described below. Report failures clearly and fix only what the tests require.\n\n{{prompt}}',
  },
  prototyper: {
    id: 'prototyper',
    name: 'Prototyper',
    description: 'Small, focused prototype changes.',
    provider: 'kusa',
    mode: 'agent',
    rules: 'ask-deny',
    model: '',
    allowModeOverride: true,
    allowRuleOverride: true,
    allowModelOverride: true,
    promptTemplate:
      'Prototype the idea below with a small, focused change. Prefer speed over polish.\n\n{{prompt}}',
  },
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Read-only review of risks, gaps, and fixes.',
    provider: 'cursor',
    mode: 'ask',
    rules: 'ask-deny',
    model: '',
    promptTemplate:
      'Review the work described below. Be specific about risks, gaps, and suggested fixes. Read-only.\n\n{{prompt}}',
  },
});

/** CAO provider id → chat provider id used by assign / composer. */
export const CAO_TO_CHAT_PROVIDER = Object.freeze({
  kusa_cli: 'kusa',
  cursor_cli: 'cursor',
  cursor: 'cursor',
  copilot_cli: 'copilot',
  copilot: 'copilot',
  'github-copilot': 'copilot',
});

/** Chat provider id → preferred CAO provider id for cao-server sync. */
export const CHAT_TO_CAO_PROVIDER = Object.freeze({
  kusa: 'kusa_cli',
  cursor: 'cursor_cli',
  copilot: 'copilot_cli',
});

function asOverrideFlag(raw) {
  return raw === true || raw === 1 || String(raw).trim().toLowerCase() === 'true';
}

function resolveModelId(raw) {
  const id = String(raw ?? '').trim().slice(0, 200);
  if (!id || id.toLowerCase() === 'auto') return '';
  return id;
}

export function agentProfilesRoot(monitorDir) {
  return join(monitorDir, PROFILES_DIR);
}

function atomicWriteFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Map a CAO provider id (or chat id) to the chat provider assign understands.
 * @param {string} raw
 */
export function chatProviderFromCao(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'kusa';
  return CAO_TO_CHAT_PROVIDER[key] || key;
}

/**
 * Map a chat provider id to a CAO provider id for cao-server profiles.
 * @param {string} raw
 */
export const caoProviderFromChat = (raw) => {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'kusa_cli';
  return CHAT_TO_CAO_PROVIDER[key] || key;
};

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeAgentProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.name || '').trim().toLowerCase().slice(0, 60);
  if (!id || !/^[a-z0-9][a-z0-9_.-]*$/.test(id)) return null;

  const caoProviderRaw = typeof raw.caoProvider === 'string' ? raw.caoProvider.trim() : '';
  const providerRaw = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  // Prefer explicit chat provider; otherwise map from CAO id.
  const provider = providerRaw
    ? chatProviderFromCao(providerRaw)
    : (caoProviderRaw ? chatProviderFromCao(caoProviderRaw) : '');
  if (!provider) return null;

  const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase().slice(0, 40) : 'agent';
  const out = {
    id,
    name: String(raw.name || id).trim().slice(0, 200) || id,
    description: String(raw.description || '').trim().slice(0, 2000),
    provider,
    caoProvider: caoProviderRaw
      ? caoProviderRaw.slice(0, 80)
      : caoProviderFromChat(provider),
    mode: mode || 'agent',
    promptTemplate: typeof raw.promptTemplate === 'string'
      ? raw.promptTemplate
      : (typeof raw.body === 'string' ? raw.body : ''),
  };

  const rulesRaw = typeof raw.rules === 'string' ? raw.rules.trim().toLowerCase() : '';
  if (rulesRaw && normalizeApprovalMode(rulesRaw) === rulesRaw) {
    out.rules = rulesRaw;
  }
  if (Object.hasOwn(raw, 'model')) {
    out.model = resolveModelId(raw.model);
  }
  if (typeof raw.requiresPlanStatus === 'string' && raw.requiresPlanStatus.trim()) {
    out.requiresPlanStatus = raw.requiresPlanStatus.trim().toLowerCase().slice(0, 40);
  }
  if (Object.hasOwn(raw, 'allowModeOverride')) {
    out.allowModeOverride = asOverrideFlag(raw.allowModeOverride);
  }
  if (Object.hasOwn(raw, 'allowRuleOverride')) {
    out.allowRuleOverride = asOverrideFlag(raw.allowRuleOverride);
  }
  if (Object.hasOwn(raw, 'allowModelOverride')) {
    out.allowModelOverride = asOverrideFlag(raw.allowModelOverride);
  }
  return out;
}

/** Role-shaped object for workflow / assign consumers. */
export function profileToRoleConfig(profile) {
  if (!profile) return null;
  const out = {
    provider: profile.provider,
    mode: profile.mode || 'agent',
    promptTemplate: profile.promptTemplate || '',
  };
  if (profile.rules) out.rules = profile.rules;
  if (Object.hasOwn(profile, 'model')) out.model = profile.model;
  if (profile.requiresPlanStatus) out.requiresPlanStatus = profile.requiresPlanStatus;
  if (profile.allowModeOverride === true) out.allowModeOverride = true;
  if (profile.allowRuleOverride === true) out.allowRuleOverride = true;
  if (profile.allowModelOverride === true) out.allowModelOverride = true;
  return out;
}

function profilePath(monitorDir, id) {
  return join(agentProfilesRoot(monitorDir), `${id}.json`);
}

/**
 * Seed built-in profiles when missing. Never overwrites an existing file.
 */
export function ensureAgentProfilesSeeded(monitorDir) {
  const root = agentProfilesRoot(monitorDir);
  mkdirSync(root, { recursive: true });
  for (const seed of Object.values(SEED_AGENT_PROFILES)) {
    const path = profilePath(monitorDir, seed.id);
    if (existsSync(path)) continue;
    const profile = normalizeAgentProfile({
      ...seed,
      caoProvider: caoProviderFromChat(seed.provider),
    });
    if (!profile) continue;
    atomicWriteFile(path, `${JSON.stringify(profile, null, 2)}\n`);
  }
  return root;
}

export function readAgentProfile(monitorDir, profileId) {
  const id = String(profileId || '').trim().toLowerCase();
  if (!id) return null;
  ensureAgentProfilesSeeded(monitorDir);
  const path = profilePath(monitorDir, id);
  if (!existsSync(path)) return null;
  return normalizeAgentProfile(readJsonSafe(path));
}

export function listAgentProfiles(monitorDir) {
  const root = ensureAgentProfilesSeeded(monitorDir);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const profile = normalizeAgentProfile(readJsonSafe(join(root, entry.name)));
    if (profile) out.push(profile);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function writeAgentProfile(monitorDir, raw) {
  const profile = normalizeAgentProfile(raw);
  if (!profile) {
    const err = new Error('invalid agent profile');
    err.code = 'EINVAL';
    throw err;
  }
  ensureAgentProfilesSeeded(monitorDir);
  atomicWriteFile(profilePath(monitorDir, profile.id), `${JSON.stringify(profile, null, 2)}\n`);
  return profile;
}

export function deleteAgentProfile(monitorDir, profileId) {
  const id = String(profileId || '').trim().toLowerCase();
  if (!id) {
    const err = new Error('profile id is required');
    err.code = 'EINVAL';
    throw err;
  }
  const path = profilePath(monitorDir, id);
  if (!existsSync(path)) {
    const err = new Error(`agent profile not found: ${id}`);
    err.code = 'ENOENT';
    throw err;
  }
  unlinkSync(path);
  return { ok: true, id };
}
