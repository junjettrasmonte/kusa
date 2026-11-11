/**
 * Orchestration workflow configs under `.kusa/workflows/`.
 * Each file is `{id}.json` describing roles the parent Agent may assign.
 *
 * Roles preferably reference a central agent profile by id:
 * `{ "planner": { "profile": "planner" } }`. Full inline role objects remain
 * supported for backward compatibility. Resolved role configs carry the
 * composer triad: `mode` (ask/plan/agent), `rules` (approval gate), and
 * optional `model`. Blank / `"auto"` model → Settings → Kusă agent default.
 *
 * `allowModeOverride` / `allowRuleOverride` / `allowModelOverride` (default
 * false): when true on the orchestrator role, the human may change that picker
 * in the orchestrator message box; when true on a Subagent role (or on the
 * orchestrator), assign inherits the parent's current pick over the role default.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeApprovalMode } from '#features/agent/approval.mjs';
import {
  ensureAgentProfilesSeeded,
  profileToRoleConfig,
  readAgentProfile,
} from '#features/agent-profiles/store.mjs';

const WORKFLOWS_DIR = 'workflows';

/**
 * Legacy verb role ids → actor nouns. Accepted on assign / plan continue so
 * older sessions and prompts keep working after the rename.
 */
export const WORKFLOW_ROLE_ALIASES = Object.freeze({
  planning: 'planner',
  execution: 'executor',
  testing: 'tester',
  prototyping: 'prototyper',
  review: 'reviewer',
});

/** Role owned by the orchestrated parent session — not assignable as a Subagent. */
export const ORCHESTRATOR_ROLE = 'orchestrator';

export function canonicalWorkflowRole(roleName) {
  const key = String(roleName || '').trim().toLowerCase();
  if (!key) return '';
  return WORKFLOW_ROLE_ALIASES[key] || key;
}

/** Built-in first workflow: plan → approve → execute (+ extra actor roles). */
export const PLAN_EXECUTE_WORKFLOW = {
  id: 'plan-execute',
  name: 'Plan then Execute',
  /** Lifecycle framed by LangGraph; Orchestrator LLM still assigns via kusa_assign. */
  runtime: 'langgraph',
  description:
    'LangGraph-backed lifecycle (orchestrate → await plan approval → ensure executor). '
    + 'The Orchestrator LLM still assigns roles with kusa_assign; Plan drawer Approve '
    + 'resumes the graph. Role configs live in Agent Profiles (`.kusa/agent-profiles/`); '
    + 'this workflow maps each role name to a profile id.',
  roles: {
    orchestrator: { profile: 'orchestrator' },
    planner: { profile: 'planner' },
    executor: { profile: 'executor' },
    tester: { profile: 'tester' },
    prototyper: { profile: 'prototyper' },
    reviewer: { profile: 'reviewer' },
  },
};

/**
 * Workflow / assign model id. Blank or `"auto"` → use the agent's configured
 * default (Settings → Kusă agent / provider endpoints) at turn time.
 * @param {unknown} raw
 * @returns {string} concrete model id, or '' for agent default
 */
export function resolveWorkflowModelId(raw) {
  const id = String(raw ?? '').trim().slice(0, 200);
  if (!id || id.toLowerCase() === 'auto') return '';
  return id;
}

function asOverrideFlag(raw) {
  return raw === true || raw === 1 || String(raw).trim().toLowerCase() === 'true';
}

export function workflowsRoot(monitorDir) {
  return join(monitorDir, WORKFLOWS_DIR);
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
 * Normalize a stored role entry (profile ref and/or inline fields).
 * Does not resolve the profile — call `resolveRoleConfig` for that.
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeRole(raw) {
  // Bare profile id string: `"planner"` → `{ profile: "planner" }`
  if (typeof raw === 'string') {
    const profile = raw.trim().toLowerCase().slice(0, 60);
    return profile ? { profile } : null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const profile = typeof raw.profile === 'string'
    ? raw.profile.trim().toLowerCase().slice(0, 60)
    : '';
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().slice(0, 80) : '';
  // Profile-only refs are valid even without provider (resolved later).
  if (!provider && !profile) return null;

  const out = {};
  if (profile) out.profile = profile;
  if (provider) {
    const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase().slice(0, 40) : 'agent';
    out.provider = provider;
    out.mode = mode || 'agent';
    out.promptTemplate = typeof raw.promptTemplate === 'string' ? raw.promptTemplate : '';
  } else if (typeof raw.promptTemplate === 'string') {
    out.promptTemplate = raw.promptTemplate;
  }
  if (typeof raw.requiresPlanStatus === 'string' && raw.requiresPlanStatus.trim()) {
    out.requiresPlanStatus = raw.requiresPlanStatus.trim().toLowerCase().slice(0, 40);
  }
  const rulesRaw = typeof raw.rules === 'string' ? raw.rules.trim().toLowerCase() : '';
  if (rulesRaw && normalizeApprovalMode(rulesRaw) === rulesRaw) {
    out.rules = rulesRaw;
  }
  if (Object.hasOwn(raw, 'model')) {
    out.model = resolveWorkflowModelId(raw.model);
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
  // Profile-only: ensure we still return something usable before resolve.
  if (!out.provider && out.profile) return out;
  if (!out.provider) return null;
  return out;
}

/**
 * Merge a profile (if referenced) with any inline role overrides.
 * @param {string} monitorDir
 * @param {object | null} role
 * @returns {object | null}
 */
export function resolveRoleConfig(monitorDir, role) {
  if (!role || typeof role !== 'object') return null;
  const profileId = typeof role.profile === 'string' ? role.profile.trim().toLowerCase() : '';
  let fromProfile = null;
  if (profileId) {
    ensureAgentProfilesSeeded(monitorDir);
    fromProfile = profileToRoleConfig(readAgentProfile(monitorDir, profileId));
  }

  /** @type {Record<string, unknown>} */
  const patch = {};
  if (typeof role.provider === 'string' && role.provider.trim()) {
    patch.provider = role.provider.trim().slice(0, 80);
  }
  if (typeof role.mode === 'string' && role.mode.trim()) {
    patch.mode = role.mode.trim().toLowerCase().slice(0, 40);
  }
  if (typeof role.promptTemplate === 'string') {
    patch.promptTemplate = role.promptTemplate;
  }
  if (typeof role.requiresPlanStatus === 'string' && role.requiresPlanStatus.trim()) {
    patch.requiresPlanStatus = role.requiresPlanStatus.trim().toLowerCase().slice(0, 40);
  }
  const rulesRaw = typeof role.rules === 'string' ? role.rules.trim().toLowerCase() : '';
  if (rulesRaw && normalizeApprovalMode(rulesRaw) === rulesRaw) {
    patch.rules = rulesRaw;
  }
  if (Object.hasOwn(role, 'model')) {
    patch.model = resolveWorkflowModelId(role.model);
  }
  if (Object.hasOwn(role, 'allowModeOverride')) {
    patch.allowModeOverride = asOverrideFlag(role.allowModeOverride);
  }
  if (Object.hasOwn(role, 'allowRuleOverride')) {
    patch.allowRuleOverride = asOverrideFlag(role.allowRuleOverride);
  }
  if (Object.hasOwn(role, 'allowModelOverride')) {
    patch.allowModelOverride = asOverrideFlag(role.allowModelOverride);
  }

  if (fromProfile) {
    return { ...fromProfile, ...patch, profile: profileId };
  }
  if (!patch.provider) return null;
  return {
    provider: patch.provider,
    mode: patch.mode || 'agent',
    promptTemplate: typeof patch.promptTemplate === 'string' ? patch.promptTemplate : '',
    ...patch,
  };
}

function resolveWorkflowRoles(monitorDir, roles) {
  /** @type {Record<string, object>} */
  const out = {};
  for (const [name, value] of Object.entries(roles || {})) {
    const resolved = resolveRoleConfig(monitorDir, value);
    if (resolved) out[name] = resolved;
  }
  return out;
}

/**
 * Human label for a workflow role in orchestrator gate copy.
 * e.g. "executor" → "Executor agent"
 */
export function workflowRoleAgentLabel(roleName) {
  const raw = String(roleName || '').trim();
  if (!raw) return 'Subagent';
  const titled = canonicalWorkflowRole(raw)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return titled ? `${titled} agent` : 'Subagent';
}

/**
 * Orchestrator-chat sentence when a Subagent needs human input.
 * Only for pending ask / ask-* rules — workflow `allow` / `deny` settle in the
 * gate with no human wait and must not use this copy.
 * @param {string} roleName
 * @param {'approval' | 'ask'} kind
 */
export function workflowRoleGatePrompt(roleName, kind = 'approval') {
  const who = workflowRoleAgentLabel(roleName);
  return kind === 'ask'
    ? `${who} is asking a question`
    : `${who} is asking for an approval`;
}

/**
 * Normalize stored workflow JSON (roles may be profile refs; not yet resolved).
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorkflow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 120);
  if (!id) return null;
  const rolesIn = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  /** @type {Record<string, object>} */
  const roles = {};
  for (const [name, value] of Object.entries(rolesIn)) {
    const key = String(name || '').trim().toLowerCase().slice(0, 60);
    const role = normalizeRole(value);
    if (key && role) roles[key] = role;
  }
  const runtimeRaw = String(raw.runtime || '').trim().toLowerCase().slice(0, 40);
  // Seeded LangGraph workflows stay tagged even when older JSON omitted runtime.
  const runtime = runtimeRaw
    || (id === PLAN_EXECUTE_WORKFLOW.id || id === 'ticket-first' ? 'langgraph' : '');
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 200) || id,
    description: String(raw.description || '').trim().slice(0, 2000),
    ...(runtime ? { runtime } : {}),
    roles,
  };
}

/**
 * Normalize then resolve profile refs so callers always see full role configs.
 * @param {string} monitorDir
 * @param {unknown} raw
 */
function hydrateWorkflow(monitorDir, raw) {
  const wf = normalizeWorkflow(raw);
  if (!wf) return null;
  return {
    ...wf,
    roles: resolveWorkflowRoles(monitorDir, wf.roles),
  };
}

export function ensureWorkflowsSeeded(monitorDir) {
  ensureAgentProfilesSeeded(monitorDir);
  const root = workflowsRoot(monitorDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, `${PLAN_EXECUTE_WORKFLOW.id}.json`);
  if (!existsSync(path)) {
    atomicWriteFile(path, `${JSON.stringify(PLAN_EXECUTE_WORKFLOW, null, 2)}\n`);
    return root;
  }
  // Existing install: stamp runtime only — never clobber user-edited roles.
  try {
    const raw = readJsonSafe(path);
    if (raw && typeof raw === 'object' && !String(raw.runtime || '').trim()) {
      atomicWriteFile(path, `${JSON.stringify({ ...raw, runtime: 'langgraph' }, null, 2)}\n`);
    }
  } catch {
    /* leave file as-is */
  }
  return root;
}

/** Unresolved workflow (profile refs intact) — for editors that re-save bindings. */
export function readWorkflowSource(monitorDir, workflowId) {
  const id = String(workflowId || '').trim();
  if (!id) return null;
  ensureWorkflowsSeeded(monitorDir);
  const path = join(workflowsRoot(monitorDir), `${id}.json`);
  if (!existsSync(path)) return null;
  return normalizeWorkflow(readJsonSafe(path));
}

export function readWorkflow(monitorDir, workflowId) {
  const id = String(workflowId || '').trim();
  if (!id) return null;
  const source = readWorkflowSource(monitorDir, id);
  if (!source) return null;
  return {
    ...source,
    roles: resolveWorkflowRoles(monitorDir, source.roles),
  };
}

export function listWorkflows(monitorDir) {
  const root = ensureWorkflowsSeeded(monitorDir);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const wf = hydrateWorkflow(monitorDir, readJsonSafe(join(root, entry.name)));
    if (wf) out.push(wf);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Persist a workflow. Roles may be profile refs or full inline configs.
 * @param {string} monitorDir
 * @param {object} raw
 */
export function writeWorkflow(monitorDir, raw) {
  const wf = normalizeWorkflow(raw);
  if (!wf) {
    const err = new Error('invalid workflow');
    err.code = 'EINVAL';
    throw err;
  }
  ensureWorkflowsSeeded(monitorDir);
  // Persist the unresolved shape (profile refs intact) so the store stays the
  // source of truth for which profile each role uses.
  const toWrite = {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    ...(wf.runtime ? { runtime: wf.runtime } : {}),
    roles: wf.roles,
  };
  atomicWriteFile(
    join(workflowsRoot(monitorDir), `${wf.id}.json`),
    `${JSON.stringify(toWrite, null, 2)}\n`,
  );
  return hydrateWorkflow(monitorDir, toWrite);
}

export function workflowRole(monitorDir, workflowId, roleName) {
  const wf = readWorkflow(monitorDir, workflowId);
  if (!wf) return null;
  const role = canonicalWorkflowRole(roleName);
  if (!role) return null;
  return wf.roles[role] || null;
}

/** Roles the orchestrator may pass to kusa_assign (excludes the Orchestrator itself). */
export function assignableWorkflowRoles(workflow) {
  const roles = workflow?.roles && typeof workflow.roles === 'object' ? workflow.roles : {};
  return Object.keys(roles).filter((name) => canonicalWorkflowRole(name) !== ORCHESTRATOR_ROLE);
}

/** True when a Subagent role is the Planner (incl. legacy `planning`). */
export function isPlannerRole(roleName) {
  return canonicalWorkflowRole(roleName) === 'planner';
}

/** True when a Subagent role is the Executor (incl. legacy `execution`). */
export function isExecutorRole(roleName) {
  return canonicalWorkflowRole(roleName) === 'executor';
}

/** Fill `{{prompt}}`, `{{planName}}`, `{{planBody}}` in a role template. */
export function renderRolePrompt(template, vars = {}) {
  const src = typeof template === 'string' && template.trim()
    ? template
    : String(vars.prompt || '');
  return src
    .replaceAll('{{prompt}}', String(vars.prompt || ''))
    .replaceAll('{{planName}}', String(vars.planName || ''))
    .replaceAll('{{planBody}}', String(vars.planBody || ''))
    .trim();
}
