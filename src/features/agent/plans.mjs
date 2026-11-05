/**
 * Workspace plan tools — create / ingest / read / update plans shared across Agents.
 * Plans live in `.kusa/plans/` (not per-session), so the Plan drawer and any
 * Subagent can see the same records. Approval is a status flip (usually from UI);
 * approving continues the orchestrated workflow (assign execution).
 */
import {
  createPlan,
  listPlans,
  planSummary,
  plansLockingAgentIds,
  readPlan,
  updatePlan,
  upsertPlanFromSource,
  PLAN_STATUSES,
} from '#features/chat/data/plan-store.mjs';
import { parsePlanMarkdown } from '#features/monitor/lib.mjs';
import { resolveWorkspacePath } from './files.mjs';
import { basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  listChatSessions,
  readChatSession,
  readSessionConfig,
  writeChatSession,
  writeSessionConfig,
} from '#features/chat/data/chat-store.mjs';
import { isExecutorRole, isPlannerRole } from '#features/workflows/store.mjs';
import { createAssignTools } from './assign.mjs';

export const PLAN_TOOL_DEFS = [
  {
    name: 'kusa_plan_list',
    description:
      'List workspace plans (id, name, status, overview). Plans are shared across all Agents — '
      + 'not tied to this chat alone. Use before assigning an Executor so you know which planId to pass.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: PLAN_STATUSES,
          description: 'Optional filter by status',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_create',
    description:
      'Create a workspace plan visible in the Plan drawer. Pass name, overview, body (markdown), '
      + 'and optional todos. Status defaults to draft; the human Approves in the Plan drawer before execution.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short plan title' },
        overview: { type: 'string', description: 'One-paragraph summary' },
        body: { type: 'string', description: 'Full plan markdown' },
        todos: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              id: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
        status: {
          type: 'string',
          enum: ['draft', 'ready'],
          description: 'Defaults to draft. Do not set approved — the human Approves in the UI.',
        },
        workflowId: { type: 'string' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_ingest',
    description:
      'Create or update a workspace plan from a plan file already in the workspace — a repo PLAN.md, a '
      + 'Cursor *.plan.md, or a .kusa/plans/*.json record. Markdown may carry --- frontmatter '
      + '(name:, overview:, todos: with id/content/status items); everything after it is the plan body, '
      + 'and a file without frontmatter is taken as body. A file that matches an existing plan (same path, '
      + 'or the planId you pass) refreshes that plan instead of creating a duplicate. Use this instead of '
      + 'pasting a long body into kusa_plan_create.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative plan file to ingest (e.g. PLAN.md, docs/plan.md)',
        },
        planId: {
          type: 'string',
          description: 'Refresh this specific plan instead of matching the file to one by its source path',
        },
        mode: {
          type: 'string',
          enum: ['upsert', 'create', 'update'],
          description:
            'upsert (default): add a plan when the file is new, refresh it when it is known. '
            + 'create: refuse if a plan already matches this file. update: refuse unless one matches.',
        },
        name: {
          type: 'string',
          description: 'Plan title when the file has no frontmatter name (defaults to the file name)',
        },
        overview: {
          type: 'string',
          description: 'One-paragraph summary when the file has none',
        },
        status: {
          type: 'string',
          enum: ['draft', 'ready'],
          description: 'Status for a newly created plan (default ready). Never approved — the human Approves in the UI.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_read',
    description: 'Read one workspace plan by id (full body + todos + status).',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan id from kusa_plan_list or kusa_plan_create' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_update',
    description:
      'Update an existing workspace plan (name, overview, body, todos, status). '
      + 'Prefer status ready when the plan is complete enough for human review. '
      + 'Do not set approved yourself — that is the Plan drawer Approve action. '
      + 'When implementation is finished, prefer kusa_plan_complete over setting status=done here.',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        name: { type: 'string' },
        overview: { type: 'string' },
        body: { type: 'string' },
        todos: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              id: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
        status: {
          type: 'string',
          enum: ['draft', 'ready', 'executing', 'done', 'cancelled'],
        },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_complete',
    description:
      'Mark a workspace plan as done after its implementation is finished. '
      + 'Sets status to done and marks open todos completed. '
      + 'planId defaults to the plan this Agent was assigned (session planId). '
      + 'Call this once execution is complete so the Plan drawer shows the plan as done.',
    parameters: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: 'Plan id. Optional when this Agent was assigned with that planId.',
        },
        summary: {
          type: 'string',
          description: 'Optional one-line note about what was implemented (returned in the tool result).',
        },
      },
      additionalProperties: false,
    },
  },
];

function agentIdFromSessionKey(sessionKey) {
  const key = String(sessionKey || '');
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
}

function sessionParentId(session) {
  return String(session?.parentId || session?.options?.parentId || '').trim();
}

function sessionWorkflowId(session) {
  return String(session?.workflowId || session?.options?.workflowId || '').trim();
}

function isOrchestratorSession(session) {
  if (!session) return false;
  const kind = String(session.kind || session.options?.kind || '').toLowerCase();
  return kind === 'orchestrated' || Boolean(sessionWorkflowId(session));
}

function firstUserPrompt(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (const msg of messages) {
    if (msg?.role !== 'user') continue;
    const text = String(msg.text || msg.content || '').trim();
    if (text) return text;
  }
  return '';
}

function hasExecutionForPlan(session, planId) {
  const id = String(planId || '').trim();
  if (!id || !session) return false;
  const kids = Array.isArray(session.subagents)
    ? session.subagents
    : (Array.isArray(session.options?.subagents) ? session.options.subagents : []);
  return kids.some((kid) => (
    isExecutorRole(kid?.role)
    && String(kid?.planId || '') === id
  ));
}

/**
 * Find the orchestrated parent that should continue after a plan is approved.
 * Prefers plan.createdByAgentId (walks up to parent when that agent is a Subagent),
 * then parents that already reference this planId, then recent Planner Subagents.
 */
export function resolveOrchestratorForPlan(dataDir, plan) {
  if (!dataDir || !plan) return null;
  const planId = String(plan.id || '').trim();
  const byId = String(plan.createdByAgentId || '').trim();

  if (byId) {
    const creator = readChatSession(dataDir, byId);
    const creatorConfig = readSessionConfig(dataDir, byId) || creator?.options || {};
    const parentId = String(creatorConfig.parentId || sessionParentId(creator) || '').trim();
    if (parentId) {
      const parent = readChatSession(dataDir, parentId);
      if (parent) return parent;
    }
    if (creator && isOrchestratorSession({ ...creator, ...creatorConfig, options: creatorConfig })) {
      return creator;
    }
  }

  const sessions = listChatSessions(dataDir);
  if (planId) {
    const byPlanRef = sessions.find((s) => (
      !sessionParentId(s)
      && isOrchestratorSession(s)
      && hasExecutionForPlan(s, planId) === false
      && (Array.isArray(s.subagents) ? s.subagents : []).some((kid) => String(kid?.planId || '') === planId)
    ));
    if (byPlanRef) return byPlanRef;
  }

  // Fallback: orchestrator with a Planner Subagent and no Executor for this plan yet.
  const candidates = sessions.filter((s) => {
    if (sessionParentId(s) || !isOrchestratorSession(s)) return false;
    if (planId && hasExecutionForPlan(s, planId)) return false;
    const kids = Array.isArray(s.subagents) ? s.subagents : [];
    return kids.some((kid) => isPlannerRole(kid?.role));
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  return candidates[0];
}

/**
 * Persist plan ↔ planner / orchestrator linkage on the plan record and session
 * sidecars so the Plan drawer can show the planner and delete can refuse the tree.
 */
export function linkPlanToAgents(dataDir, plan, {
  plannerId = '',
  orchestratorId = '',
} = {}) {
  if (!dataDir || !plan?.id) return plan;
  const planner = String(plannerId || plan.createdByAgentId || '').trim();
  let orch = String(orchestratorId || plan.orchestratorAgentId || '').trim();
  if (!orch && planner) {
    const cfg = readSessionConfig(dataDir, planner) || {};
    orch = String(cfg.parentId || '').trim();
  }
  const patch = {};
  if (planner && planner !== plan.createdByAgentId) patch.createdByAgentId = planner;
  if (orch && orch !== plan.orchestratorAgentId) patch.orchestratorAgentId = orch;
  let next = plan;
  if (Object.keys(patch).length) {
    try {
      next = updatePlan(dataDir, plan.id, patch);
    } catch {
      next = plan;
    }
  }

  if (planner) {
    try {
      const cfg = readSessionConfig(dataDir, planner) || {};
      writeSessionConfig(dataDir, planner, { ...cfg, planId: next.id }, null, cfg.parentId || null);
    } catch { /* best-effort */ }
  }
  if (orch && planner) {
    try {
      const parentCfg = readSessionConfig(dataDir, orch) || {};
      const kids = Array.isArray(parentCfg.subagents) ? parentCfg.subagents : [];
      const updated = kids.map((kid) => (
        kid?.id === planner ? { ...kid, planId: next.id } : kid
      ));
      if (updated.some((kid, i) => kid !== kids[i])) {
        writeSessionConfig(dataDir, orch, { ...parentCfg, subagents: updated });
      }
    } catch { /* best-effort */ }
  }
  return next;
}

/**
 * Cursor (and other CLI planners) often write `.kusa/plans/*.json` without
 * kusa_plan_create — claim unowned plans updated during/after the turn.
 */
export function claimUnownedPlansForAgent(dataDir, {
  agentId = '',
  parentId = '',
  workflowId = '',
  sinceMs = 0,
} = {}) {
  const planner = String(agentId || '').trim();
  if (!dataDir || !planner) return [];
  const since = Number.isFinite(sinceMs) ? sinceMs : 0;
  const wf = String(workflowId || '').trim();
  const claimed = [];
  for (const plan of listPlans(dataDir)) {
    if (plan.createdByAgentId) continue;
    if (since && Number(plan.updatedAt || plan.createdAt || 0) + 60_000 < since) continue;
    if (wf && plan.workflowId && plan.workflowId !== wf) continue;
    const linked = linkPlanToAgents(dataDir, plan, {
      plannerId: planner,
      orchestratorId: parentId,
    });
    if (wf && !linked.workflowId) {
      try {
        claimed.push(updatePlan(dataDir, linked.id, { workflowId: wf }));
        continue;
      } catch { /* ignore */ }
    }
    claimed.push(linked);
  }
  return claimed;
}

/**
 * Plans that block deleting these Agents — by planner/orchestrator refs or by
 * a session in the tree that still carries the planId.
 */
export function plansBlockingAgentDelete(dataDir, keysOrIds = []) {
  const treeIds = expandAgentTreeIds(dataDir, keysOrIds);
  const byRef = plansLockingAgentIds(dataDir, treeIds);
  const planIdsOnSessions = new Set();
  for (const s of listChatSessions(dataDir)) {
    if (!treeIds.includes(s.id)) continue;
    const pid = String(s.planId || s.options?.planId || '').trim();
    if (pid) planIdsOnSessions.add(pid);
  }
  const bySession = listPlans(dataDir).filter((p) => planIdsOnSessions.has(p.id));
  const seen = new Set();
  const out = [];
  for (const plan of [...byRef, ...bySession]) {
    if (!plan?.id || seen.has(plan.id)) continue;
    seen.add(plan.id);
    out.push(plan);
  }
  return out;
}

/**
 * Expand session keys / ids to every Agent id in the same tree (parent +
 * Subagents). Used before refusing delete when a plan still references the tree.
 */
export function expandAgentTreeIds(dataDir, keysOrIds = []) {
  const seeds = new Set();
  for (const raw of keysOrIds || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    seeds.add(text.includes(':') ? text.slice(text.indexOf(':') + 1) : text);
  }
  if (!seeds.size || !dataDir) return [...seeds];

  const sessions = listChatSessions(dataDir);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const roots = new Set();
  for (const id of seeds) {
    const row = byId.get(id);
    const parent = String(row?.parentId || row?.options?.parentId || '').trim();
    roots.add(parent || id);
  }
  const out = new Set(seeds);
  for (const root of roots) out.add(root);
  for (const s of sessions) {
    const parent = String(s.parentId || s.options?.parentId || '').trim();
    if (roots.has(s.id) || (parent && roots.has(parent))) {
      out.add(s.id);
      if (parent) out.add(parent);
    }
  }
  return [...out];
}

/**
 * Resolve DELETE keys for Agents: Subagents cannot be removed on their own
 * (they live under a parent). Parent deletes expand to include every child key
 * so monitor state stays in sync with the recursive folder wipe.
 *
 * @returns {{ keys: string[], blocked: string[] }}
 */
export function resolveAgentDeleteKeys(dataDir, keys = []) {
  const wanted = [...new Set(
    (Array.isArray(keys) ? keys : []).map((key) => String(key || '').trim()).filter(Boolean),
  )];
  if (!wanted.length) return { keys: [], blocked: [] };
  if (!dataDir) return { keys: wanted, blocked: [] };

  const sessions = listChatSessions(dataDir);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const byKey = new Map(sessions.filter((s) => s?.key).map((s) => [s.key, s]));

  const requestedIds = new Set();
  for (const key of wanted) {
    const id = agentIdFromSessionKey(key);
    if (id) requestedIds.add(id);
  }

  const allowed = [];
  const blocked = [];
  for (const key of wanted) {
    const id = agentIdFromSessionKey(key);
    const session = byKey.get(key) || byId.get(id) || null;
    const parent = sessionParentId(session);
    if (parent && !requestedIds.has(parent)) {
      blocked.push(key);
      continue;
    }
    allowed.push(key);
  }

  // Expand each allowed parent to its Subagent keys for a clean wipe.
  const out = new Set(allowed);
  const parentIds = new Set();
  for (const key of allowed) {
    const id = agentIdFromSessionKey(key);
    const session = byKey.get(key) || byId.get(id) || null;
    if (!sessionParentId(session)) parentIds.add(id);
  }
  for (const s of sessions) {
    const parent = sessionParentId(s);
    if (!parent || !parentIds.has(parent) || !s?.key) continue;
    out.add(s.key);
  }
  return { keys: [...out], blocked };
}

function appendParentApprovalNote(dataDir, orchestrator, plan) {
  if (!dataDir || !orchestrator?.id || !plan?.id) return;
  const session = readChatSession(dataDir, orchestrator.id, orchestrator.harness) || orchestrator;
  const note = `Plan approved: ${plan.name || plan.id} (${plan.id}). Starting execution.`;
  const messages = Array.isArray(session.messages) ? [...session.messages] : [];
  const already = messages.some((m) => m?.role === 'user' && String(m.text || '').includes(plan.id) && /Plan approved/i.test(String(m.text || '')));
  if (already) return;
  messages.push({
    id: `plan-approved-${plan.id}`,
    role: 'user',
    text: note,
    at: Date.now(),
  });
  try {
    writeChatSession(dataDir, { ...session, messages });
  } catch {
    /* best-effort transcript note */
  }
}

/**
 * After a human Approves a plan, assign the workflow's execution role on the
 * owning orchestrator (idempotent if execution for this planId already exists).
 *
 * Optional overrides from the Plan drawer:
 * - `prompt` — execution prompt (falls back to plan.executionPrompt / first user prompt)
 * - `assignToAgentId` — run under / on this Agent instead of the linked orchestrator
 * - `detachWorkflow` — clear workflowId / orchestratorAgentId before continuing
 */
export async function continueWorkflowAfterPlanApproval({
  dataDir = '',
  plan = null,
  workspaceRoot = process.cwd(),
  startTurn = null,
  prompt = '',
  assignToAgentId = '',
  detachWorkflow = false,
} = {}) {
  if (!dataDir || !plan?.id) {
    return { ok: false, error: 'dataDir and plan required', code: 'EINVAL' };
  }
  if (String(plan.status || '').toLowerCase() !== 'approved'
    && String(plan.status || '').toLowerCase() !== 'executing') {
    return { ok: false, error: `plan status is "${plan.status}" — need approved`, code: 'EPLAN' };
  }

  if (detachWorkflow) {
    try {
      plan = updatePlan(dataDir, plan.id, {
        workflowId: '',
        orchestratorAgentId: '',
      });
    } catch {
      /* non-fatal */
    }
  }

  const overrideId = String(assignToAgentId || '').trim();
  let orchestrator = overrideId
    ? (readChatSession(dataDir, overrideId) || null)
    : resolveOrchestratorForPlan(dataDir, plan);

  if (!orchestrator?.id) {
    return { ok: false, error: 'no orchestrator Agent found for this plan', code: 'ENOENT' };
  }

  if (hasExecutionForPlan(orchestrator, plan.id)) {
    return {
      ok: true,
      skipped: true,
      reason: 'execution_already_assigned',
      orchestratorId: orchestrator.id,
      planId: plan.id,
    };
  }

  // Backfill linkage when the Planner wrote the plan without kusa_plan_create metadata.
  // Skip when the human explicitly detached or picked a different Agent.
  if (!detachWorkflow && !overrideId) {
    try {
      const planner = (Array.isArray(orchestrator.subagents) ? orchestrator.subagents : [])
        .find((kid) => isPlannerRole(kid?.role));
      plan = linkPlanToAgents(dataDir, plan, {
        plannerId: plan.createdByAgentId || planner?.id || '',
        orchestratorId: orchestrator.id,
      });
      if (!plan.workflowId && sessionWorkflowId(orchestrator)) {
        plan = updatePlan(dataDir, plan.id, { workflowId: sessionWorkflowId(orchestrator) });
      }
    } catch {
      /* non-fatal */
    }
  }

  const promptText = String(prompt || plan.executionPrompt || '').trim()
    || firstUserPrompt(orchestrator)
    || plan.overview
    || plan.name
    || plan.id;

  if (promptText && promptText !== plan.executionPrompt) {
    try {
      plan = updatePlan(dataDir, plan.id, { executionPrompt: promptText });
    } catch {
      /* non-fatal */
    }
  }

  const canAssignExecutor = isOrchestratorSession(orchestrator)
    || Boolean(sessionWorkflowId(orchestrator));

  let result;
  if (canAssignExecutor) {
    const sessionKey = orchestrator.key || `kusa:${orchestrator.id}`;
    const assign = createAssignTools({
      dataDir,
      sessionKey,
      workspaceRoot,
      startTurn,
    });
    result = await assign.assign({
      role: 'executor',
      planId: plan.id,
      prompt: promptText,
    });
  } else if (typeof startTurn === 'function') {
    // Detached / non-orchestrated Agent: start a turn directly with the plan.
    const planBlock = [plan.name, plan.overview, plan.body].filter(Boolean).join('\n\n');
    const composed = [
      promptText,
      planBlock ? `\n\n---\nApproved plan (${plan.id}):\n${planBlock}` : '',
    ].join('').trim();
    try {
      result = await startTurn({
        sessionId: orchestrator.id,
        queueKey: orchestrator.key || `kusa:${orchestrator.id}`,
        harness: orchestrator.harness || 'kusa',
        provider: orchestrator.provider || orchestrator.options?.provider || 'kusa',
        prompt: composed,
        mode: orchestrator.options?.mode || 'agent',
        model: orchestrator.options?.model || '',
        rules: orchestrator.options?.rules || '',
        planId: plan.id,
      });
      result = {
        ok: Boolean(result?.ok || result?.started),
        started: Boolean(result?.started ?? result?.ok),
        ...(result && typeof result === 'object' ? result : {}),
        assignedDirectly: true,
      };
    } catch (err) {
      result = { ok: false, error: err?.message || String(err), code: 'EFAIL' };
    }
  } else {
    result = {
      ok: false,
      error: 'Selected Agent is not orchestrated and no turn starter is available',
      code: 'EINVAL',
    };
  }

  if (result?.ok) {
    appendParentApprovalNote(dataDir, orchestrator, plan);
    try {
      updatePlan(dataDir, plan.id, { status: 'executing' });
    } catch {
      /* status flip is best-effort */
    }
  }

  return {
    ...result,
    orchestratorId: orchestrator.id,
    planId: plan.id,
    detached: Boolean(detachWorkflow),
  };
}

/**
 * One plan file, read once, for the ingest tool to refuse rather than truncate
 * silently. Matches the store's own body cap (100k chars) with headroom.
 */
const MAX_INGEST_BYTES = 256 * 1024;

/**
 * Turn a plan file on disk into plan fields: `.json` records are read as-is
 * (they already carry an id), everything else goes through the Cursor-style
 * markdown parser (`---` frontmatter + body).
 */
function parseIngestedPlanFile(text, absPath) {
  if (/\.json$/i.test(absPath)) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `plan file is not valid JSON: ${err?.message || String(err)}`, code: 'EINVAL' };
    }
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'plan file JSON must be an object', code: 'EINVAL' };
    }
    return {
      ok: true,
      id: String(raw.id || '').trim(),
      name: String(raw.name || '').trim(),
      overview: String(raw.overview || '').trim(),
      body: String(raw.body || '').trim(),
      todos: Array.isArray(raw.todos) ? raw.todos : [],
    };
  }
  const parsed = parsePlanMarkdown(text, absPath);
  if (!parsed) return { ok: false, error: 'plan file is empty', code: 'EINVAL' };
  return {
    ok: true,
    id: '',
    name: String(parsed.plan.name || '').trim(),
    overview: String(parsed.plan.overview || '').trim(),
    body: String(parsed.plan.body || '').trim(),
    todos: parsed.todos || [],
  };
}

/** "PLAN.md" / "docs/refactor.plan.md" → a title the file itself never gave. */
function fallbackPlanName(absPath) {
  const base = basename(String(absPath || ''));
  const withoutExt = base.replace(/\.(md|markdown|txt|json)$/i, '');
  return withoutExt || base;
}

export function createPlanTools({ dataDir = '', sessionKey = '', workspaceRoot = process.cwd() } = {}) {
  function list(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    let plans = listPlans(dataDir).map(planSummary);
    const status = typeof args.status === 'string' ? args.status.trim().toLowerCase() : '';
    if (status) plans = plans.filter((p) => p.status === status);
    return { ok: true, plans, count: plans.length };
  }

  function create(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const agentId = agentIdFromSessionKey(sessionKey);
    const config = agentId ? (readSessionConfig(dataDir, agentId) || {}) : {};
    const workflowId = String(args.workflowId || config.workflowId || '').trim();
    const orchestratorAgentId = String(config.parentId || '').trim();
    try {
      let plan = createPlan(dataDir, {
        name: args.name,
        overview: args.overview,
        body: args.body,
        todos: args.todos,
        status: args.status === 'ready' ? 'ready' : 'draft',
        workflowId,
        createdByAgentId: agentId,
        orchestratorAgentId,
      });
      plan = linkPlanToAgents(dataDir, plan, {
        plannerId: agentId,
        orchestratorId: orchestratorAgentId,
      });
      return { ok: true, plan };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
    }
  }

  function ingest(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const rawPath = String(args.path || '').trim();
    if (!rawPath) return { ok: false, error: 'path is required (workspace-relative plan file)', code: 'EINVAL' };
    const mode = ['create', 'update'].includes(String(args.mode || '').trim().toLowerCase())
      ? String(args.mode).trim().toLowerCase()
      : 'upsert';

    let target;
    try {
      target = resolveWorkspacePath(workspaceRoot, rawPath);
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
    }
    if (!existsSync(target.abs)) {
      return { ok: false, error: `plan file not found: ${target.rel}`, code: 'ENOENT' };
    }
    let text;
    try {
      text = readFileSync(target.abs, 'utf8');
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EISDIR' };
    }
    if (text.length > MAX_INGEST_BYTES) {
      return {
        ok: false,
        error: `plan file is too large to ingest (${text.length} chars; cap ${MAX_INGEST_BYTES})`,
        code: 'EINVAL',
      };
    }

    const parsed = parseIngestedPlanFile(text, target.abs);
    if (!parsed.ok) return parsed;

    const agentId = agentIdFromSessionKey(sessionKey);
    const config = agentId ? (readSessionConfig(dataDir, agentId) || {}) : {};
    const orchestratorAgentId = String(config.parentId || '').trim();
    const requestedStatus = args.status === 'draft' ? 'draft' : 'ready';

    const result = upsertPlanFromSource(dataDir, {
      id: parsed.id || String(args.planId || '').trim(),
      sourcePath: target.abs,
      mode,
      name: String(args.name || '').trim() || parsed.name || fallbackPlanName(target.abs),
      overview: String(args.overview || '').trim() || parsed.overview,
      body: parsed.body,
      todos: parsed.todos,
      status: requestedStatus,
      createdByAgentId: agentId,
    });
    if (!result?.ok) return result;

    let plan = result.plan;
    // A brand-new ingested plan owns the same linkage a kusa_plan_create would have written.
    if (result.created) {
      plan = linkPlanToAgents(dataDir, plan, {
        plannerId: agentId,
        orchestratorId: orchestratorAgentId,
      });
    }
    return {
      ok: true,
      path: target.rel,
      created: Boolean(result.created),
      updated: Boolean(result.updated),
      matchedBy: result.matchedBy || '',
      plan,
      ...(result.note ? { note: result.note } : {}),
    };
  }

  function read(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const plan = readPlan(dataDir, args.planId);
    if (!plan) return { ok: false, error: `plan not found: ${args.planId}`, code: 'ENOENT' };
    return { ok: true, plan };
  }

  function update(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const patch = {};
    for (const key of ['name', 'overview', 'body', 'todos', 'status']) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    // Models must not self-approve — only draft/ready/executing/done/cancelled via tools.
    if (patch.status === 'approved') {
      return {
        ok: false,
        error: 'Cannot set status to approved via tools — the human Approves in the Plan drawer.',
        code: 'EPERM',
      };
    }
    try {
      const plan = updatePlan(dataDir, args.planId, patch);
      return { ok: true, plan };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
    }
  }

  function complete(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const agentId = agentIdFromSessionKey(sessionKey);
    const config = agentId ? (readSessionConfig(dataDir, agentId) || {}) : {};
    const planId = String(args.planId || config.planId || '').trim();
    if (!planId) {
      return {
        ok: false,
        error: 'planId is required (or assign this Agent with a planId first)',
        code: 'EINVAL',
      };
    }
    const existing = readPlan(dataDir, planId);
    if (!existing) return { ok: false, error: `plan not found: ${planId}`, code: 'ENOENT' };
    const status = String(existing.status || '').toLowerCase();
    if (status === 'done') {
      return { ok: true, plan: existing, alreadyDone: true };
    }
    if (status === 'cancelled') {
      return { ok: false, error: 'plan is cancelled — cannot mark done', code: 'EPLAN' };
    }
    if (status === 'draft' || status === 'ready') {
      return {
        ok: false,
        error: `plan status is "${status}" — approve and execute before completing`,
        code: 'EPLAN',
      };
    }
    const todos = Array.isArray(existing.todos)
      ? existing.todos.map((todo) => (
        todo?.status === 'cancelled'
          ? todo
          : { ...todo, status: 'completed' }
      ))
      : [];
    try {
      const plan = updatePlan(dataDir, planId, { status: 'done', todos });
      const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 2000) : '';
      return { ok: true, plan, ...(summary ? { summary } : {}) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
    }
  }

  function call(name, args = {}) {
    if (name === 'kusa_plan_list' || name === 'plan_list') return list(args);
    if (name === 'kusa_plan_create' || name === 'plan_create') return create(args);
    if (name === 'kusa_plan_ingest' || name === 'plan_ingest') return ingest(args);
    if (name === 'kusa_plan_read' || name === 'plan_read') return read(args);
    if (name === 'kusa_plan_update' || name === 'plan_update') return update(args);
    if (name === 'kusa_plan_complete' || name === 'plan_complete') return complete(args);
    return { ok: false, error: `unknown plan tool: ${name}`, code: 'ENOENT' };
  }

  return {
    defs: PLAN_TOOL_DEFS,
    call,
    list,
    create,
    ingest,
    read,
    update,
    complete,
  };
}

export function planSystemPromptAddon() {
  return [
    'Workspace plans are shared across Agents via kusa_plan_list / kusa_plan_create / kusa_plan_ingest /',
    'kusa_plan_read / kusa_plan_update / kusa_plan_complete. When planning work, write the',
    'plan with these tools so it appears in the Plan drawer. Humans Approve plans in the UI',
    '— never set status to approved yourself. After approval, an Orchestrator may kusa_assign',
    'role=executor with that planId. When implementation is finished, call kusa_plan_complete',
    'so the Plan drawer marks the plan done (planId is optional if this Agent was assigned that plan). '
    + 'When the plan already exists as a file in the workspace (PLAN.md, a *.plan.md, a .kusa/plans/*.json), '
    + 'ingest it with kusa_plan_ingest instead of pasting its body into kusa_plan_create — the same file '
    + 'refreshes the same plan, it never creates a duplicate.',
  ].join(' ');
}

export function planToolSchemas() {
  return PLAN_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
