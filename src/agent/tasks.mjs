/**
 * Session task tools for the Kusă agent — the model's own work list.
 *
 * A multi-step request is easier to keep straight when the model writes the steps
 * down first, so these tools let it create a task list, read it back at any point
 * ("what is still open?"), and flag a step completed once the work is done.
 *
 * Rows are the SAME {id,content,status} shape the monitor already keeps for
 * Cursor's TodoWrite and they live in the SAME per-session Task List
 * (`.kusa/kusa/tasks.json` → the lane's `todos`), so the chat Task Stack and
 * the dashboard show the model's plan instead of a second copy of it. The tool is
 * the single writer: the monitor picks the rows up through the existing
 * tasks.json → lane hydration, so nothing double-applies them.
 *
 * Flagging a task that is already completed is not an error — the call reports
 * `unchanged` so a retried step never duplicates a row or fails the turn.
 *
 * A batch (two or more steps in one call) that lands on a list which already
 * has tasks does not silently append. It asks the user, through the same
 * question card as kusa_ask, whether to start fresh (replace the list) or
 * merge the batch into it. Nobody answering merges — replacing would drop
 * work the user did not agree to drop. With no interactive channel the batch
 * is merged immediately, so a bare harness never stalls.
 *
 * A write is self-announcing: after the sidecar is updated the monitor is
 * re-rendered in the same call, so the chat Task Stack shows the rows on the
 * UI's next poll (one second) instead of waiting for some other tool to fire a
 * hook event — which is what forced a page refresh before.
 */
import { loadTasks, saveTasks } from '../task-store.mjs';
import { refreshMonitorArtifacts } from '../lib.mjs';

const MAX_TASKS = 60;
const MAX_ID = 80;
const MAX_CONTENT = 500;
// Must match task-store.mjs normalizeTodo(): an omitted id falls back to the
// first characters of the content, so both writers agree on the same id.
const AUTO_ID_CHARS = 40;
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

export const TASK_TOOL_DEFS = [
  {
    name: 'kusa_task_list',
    description:
      'Read this session\'s task list (id, content, status) as it currently stands. '
      + 'Use it to discover which steps are still open before continuing or resuming work — '
      + 'the list is the model\'s own plan, kept per session, never workspace-shared.',
    parameters: {
      type: 'object',
      properties: {
        openOnly: {
          type: 'boolean',
          description: 'Return only tasks that are not completed or cancelled',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_task_add',
    description:
      'Create tasks for a multi-step request: append steps to this session\'s task list. '
      + 'Pass tasks: [{ content }] — leave ids out, they are generated. New steps start "pending"; '
      + 'use kusa_task_update to move one forward. Re-adding the same step is a no-op, not a duplicate. '
      + 'A batch of two or more steps, when this session already has tasks, asks the user whether to '
      + 'start fresh (replace the list) or merge the batch into it. Wait for that result — do not also '
      + 'call kusa_ask for the same choice. If nobody answers, the batch is merged and the result says so.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'Steps to create',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What this step does, one sentence' },
              id: {
                type: 'string',
                description: 'Optional stable id; generated from the content when omitted',
              },
              status: {
                type: 'string',
                enum: TASK_STATUSES,
                description: 'Defaults to pending',
              },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_task_update',
    description:
      'Change the status of existing tasks — flag a finished step "completed" (or set '
      + '"in_progress" while working, "cancelled" to drop it). Idempotent: a task already in the '
      + 'requested status is reported as unchanged, never duplicated and never an error. '
      + 'Identify rows by the id from kusa_task_list; a unique text fragment also resolves a row.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'One patch per task to change',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Task id from kusa_task_list (or a unique fragment of its content)',
              },
              status: {
                type: 'string',
                enum: TASK_STATUSES,
                description: 'New status — completed when the step is done',
              },
              content: {
                type: 'string',
                description: 'Optional rewrite of the step text (e.g. after splitting a step)',
              },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
];

function normalizeRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = String(raw.content ?? raw.text ?? raw.title ?? '').trim().slice(0, MAX_CONTENT);
  const id = String(raw.id ?? '').trim().slice(0, MAX_ID);
  if (!id && !content) return null;
  const status = String(raw.status ?? '').trim();
  return {
    id: id || content.slice(0, AUTO_ID_CHARS),
    content: content || id,
    status: TASK_STATUSES.includes(status) ? status : 'pending',
  };
}

/** Patch row: a missing field means "leave it as it is", not "clear it". */
function normalizePatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim().slice(0, MAX_ID);
  if (!id) return null;
  const contentProvided = raw.content != null || raw.text != null || raw.title != null;
  const content = contentProvided
    ? String(raw.content ?? raw.text ?? raw.title ?? '').trim().slice(0, MAX_CONTENT)
    : null;
  const status = typeof raw.status === 'string' ? String(raw.status).trim() : '';
  if (!content && !status) return null;
  return {
    id,
    content,
    status: TASK_STATUSES.includes(status) ? status : '',
  };
}

function summaryText(rows) {
  const total = rows.length;
  const done = rows.filter((r) => r.status === 'completed').length;
  const doing = rows.filter((r) => r.status === 'in_progress').length;
  const cancelled = rows.filter((r) => r.status === 'cancelled').length;
  const open = total - done - doing - cancelled;
  return [
    `${total} task${total === 1 ? '' : 's'}`,
    doing ? ` · ${doing} in progress` : '',
    open ? ` · ${open} pending` : '',
    done ? ` · ${done} done` : '',
    cancelled ? ` · ${cancelled} cancelled` : '',
  ].join('');
}

/** Two or more new steps in one call is a plan, not a single follow-up step. */
const BATCH_MIN = 2;

function incomingRows(requested) {
  const rows = [];
  const seen = new Set();
  for (const raw of requested) {
    const row = normalizeRow(raw);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

function conflictQuestion(existing, incomingCount) {
  const shown = existing
    .slice(0, 3)
    .map((row) => row.content.replace(/\s+/g, ' ').trim().slice(0, 80));
  const extra = existing.length > shown.length ? `; +${existing.length - shown.length} more` : '';
  const head = `This session already has ${summaryText(existing)}`;
  const preview = shown.length ? `: ${shown.join('; ')}${extra}` : '';
  const tail = `Start fresh with this batch of ${incomingCount}, or merge it into the current list? Not answering merges.`;
  const question = `${head}${preview}. ${tail}`;
  return question.length <= 600 ? question : `${head}. ${tail}`;
}

/** A click on "Start fresh" replaces the list. Anything else keeps it and appends. */
function choiceFromAsk(result) {
  const label = String(result?.selected?.label || result?.answer || '').trim().toLowerCase();
  if (result?.ok && label.startsWith('start fresh')) return { choice: 'fresh' };
  if (result?.ok && (label === 'merge' || label.startsWith('merge '))) return { choice: 'merge' };
  const reason = result?.ok ? 'unrecognized' : (result?.reason || 'unanswered');
  return { choice: 'merge', assumed: true, reason };
}

function withChoice(result, decision) {
  if (!decision) return result;
  const extra = { choice: decision.choice };
  if (decision.assumed) {
    extra.assumed = true;
    extra.assumption = decision.reason === 'unrecognized'
      ? 'The answer was not start fresh or merge, so the batch was merged into the existing list.'
      : 'Nobody answered, so the batch was merged into the existing list instead of replacing it.';
  }
  return { ...result, ...extra };
}

/**
 * @param {object} options
 * @param {string} [options.dataDir] monitor data dir (`.kusa/`) — enables persistence
 * @param {string} [options.sessionKey] lane key (`kusa:<sessionId>`) for this turn
 * @param {(prompt: object, callId?: string|null) => Promise<object>} [options.ask]
 *   kusa_ask channel. A batch landing on an existing list asks start-fresh or
 *   merge through this. Absent, the batch is merged so a bare harness never stalls.
 */
export function createTaskTools({ dataDir = '', sessionKey = '', ask = null } = {}) {
  const dir = String(dataDir || '').trim();
  const key = String(sessionKey || '').trim();
  const persistable = Boolean(dir && key);
  // Fallback when there is no session to persist into (bare harness / tests).
  /** @type {Map<string, { id: string, content: string, status: string }>} */
  const memory = new Map();

  /** Authoritative rows from the sidecar, or null when it is unreadable. */
  function diskRows() {
    if (!persistable) return null;
    try {
      const entry = loadTasks(dir)[key];
      if (!entry || !Array.isArray(entry.todos)) return [];
      return entry.todos.map(normalizeRow).filter(Boolean);
    } catch {
      return null;
    }
  }

  function currentRows() {
    const disk = diskRows();
    if (disk) return disk;
    return [...memory.values()];
  }

  /** Rewrite the whole list (order preserved) and keep the sidecar in step. */
  function commit(rows) {
    memory.clear();
    for (const row of rows) memory.set(row.id, row);
    if (!persistable) return;
    try {
      const sessions = loadTasks(dir) || {};
      sessions[key] = { todos: rows, updatedAtWall: Date.now() };
      saveTasks(dir, sessions);
    } catch {
      /* disk must not break the agent */
    }
    pushToMonitor();
  }

  /**
   * Re-render monitor-data.js so the rows are on the lane the chat Task Stack
   * reads. `readState` hydrates tasks.json onto lanes (newer wins), so this is
   * the same single writer — never a second copy of the list. `origin: ''`
   * keeps the existing origin: this is a re-render, not a harness event.
   * A held monitor lock (ELOCK) is not fatal — the next hook event hydrates
   * the rows anyway, and the sidecar write above already landed.
   */
  function pushToMonitor() {
    try {
      refreshMonitorArtifacts(dir, { origin: '' });
    } catch {
      /* monitoring must never break the agent */
    }
  }

  function listTasks(args = {}) {
    const rows = currentRows();
    const openOnly = Boolean(args.openOnly);
    const kept = openOnly
      ? rows.filter((r) => r.status !== 'completed' && r.status !== 'cancelled')
      : rows;
    return {
      ok: true,
      openOnly,
      total: rows.length,
      truncated: kept.length > MAX_TASKS ? kept.length - MAX_TASKS : 0,
      tasks: kept.slice(0, MAX_TASKS),
      summary: summaryText(rows),
      sessionKey: key || null,
      persisted: persistable,
    };
  }

  function applyAdd(rows, incoming, decision) {
    const replace = decision?.choice === 'fresh';
    if (replace) {
      if (incoming.length > MAX_TASKS) {
        return {
          ok: false,
          error: `task list is full (${MAX_TASKS} max) — flag finished steps completed or cancelled first`,
          tasks: rows,
          summary: summaryText(rows),
        };
      }
      commit(incoming);
      return {
        ok: true,
        replaced: rows.map((row) => row.id),
        added: incoming.map((row) => row.id),
        duplicates: [],
        tasks: incoming,
        summary: summaryText(incoming),
      };
    }

    const byId = new Map(rows.map((row) => [row.id, { ...row }]));
    const added = [];
    const duplicates = [];
    for (const row of incoming) {
      if (byId.has(row.id)) {
        duplicates.push(row.id);
        continue;
      }
      if (byId.size >= MAX_TASKS) {
        return {
          ok: false,
          error: `task list is full (${MAX_TASKS} max) — flag finished steps completed or cancelled first`,
          tasks: rows,
          summary: summaryText(rows),
        };
      }
      byId.set(row.id, row);
      added.push(row.id);
    }
    if (!added.length && duplicates.length) {
      return {
        ok: true,
        unchanged: true,
        added,
        duplicates,
        tasks: rows,
        summary: summaryText(rows),
      };
    }
    const next = [...byId.values()];
    commit(next);
    return {
      ok: true,
      added,
      duplicates,
      tasks: next,
      summary: summaryText(next),
    };
  }

  async function addTasks(args = {}, callId = null) {
    const requested = Array.isArray(args.tasks)
      ? args.tasks
      : args.content != null
        ? [args]
        : [];
    if (!requested.length) {
      return { ok: false, error: 'tasks is required: [{ "content": "…" }]' };
    }
    const incoming = incomingRows(requested);
    if (!incoming.length) {
      return { ok: false, error: 'tasks is required: [{ "content": "…" }]' };
    }
    const existing = currentRows();
    // One extra step is an append. A batch on a list that already has tasks
    // is a new plan, and only the user decides whether the old plan stays.
    let decision = null;
    if (incoming.length >= BATCH_MIN && existing.length && typeof ask === 'function') {
      const verdict = await ask({
        question: conflictQuestion(existing, incoming.length),
        options: [
          { label: 'Start fresh', detail: 'Replace the current list with this batch' },
          { label: 'Merge', detail: 'Keep the current tasks and add the new ones' },
        ],
        allowFreeText: false,
      }, callId);
      decision = choiceFromAsk(verdict);
    }
    // The question can sit open for minutes. Apply it to the list as it stands
    // when the user answers, not the snapshot from when the question was asked.
    const rows = decision ? currentRows() : existing;
    return withChoice(applyAdd(rows, incoming, decision), decision);
  }

  function updateTasks(args = {}) {
    const requested = Array.isArray(args.tasks) ? args.tasks : args.id != null ? [args] : [];
    if (!requested.length) {
      return { ok: false, error: 'tasks is required: [{ "id": "…", "status": "completed" }]' };
    }
    const rows = currentRows();
    if (!rows.length) {
      return {
        ok: false,
        error: 'no tasks yet — create them with kusa_task_add first',
        tasks: rows,
      };
    }
    const patches = requested.map(normalizePatch).filter(Boolean);
    if (!patches.length) {
      return { ok: false, error: 'each task needs an id plus a status and/or content' };
    }

    const next = rows.map((row) => ({ ...row }));
    const byId = new Map(next.map((row, index) => [row.id, index]));
    const updated = [];
    const unchanged = [];
    const alreadyCompleted = [];
    const notFound = [];
    for (const patch of patches) {
      let index = byId.get(patch.id);
      let matchedById = index != null;
      if (index == null) {
        // A unique fragment of the step text is enough — the model often
        // paraphrases an id it read earlier in the turn.
        const needle = patch.id.toLowerCase();
        const candidates = next
          .map((row, at) => ({ at, row }))
          .filter(({ row }) => row.content.toLowerCase().includes(needle)
            || row.id.toLowerCase().includes(needle));
        if (candidates.length === 1) index = candidates[0].at;
      }
      if (index == null) {
        notFound.push(patch.id);
        continue;
      }
      const target = next[index];
      const sameStatus = !patch.status || target.status === patch.status;
      const sameContent = patch.content == null || target.content === patch.content;
      if (sameStatus && sameContent) {
        unchanged.push(target.id);
        if (patch.status === 'completed' || (!patch.status && target.status === 'completed')) {
          alreadyCompleted.push(target.id);
        }
        continue;
      }
      if (patch.content != null) target.content = patch.content;
      if (patch.status) target.status = patch.status;
      updated.push(target.id);
      if (!matchedById) byId.set(target.id, index);
    }

    if (updated.length) commit(next);
    return {
      ok: !notFound.length ? true : updated.length || unchanged.length ? true : false,
      updated,
      unchanged,
      alreadyCompleted,
      notFound,
      // Nothing was flagged completed: tell the model what it can pick.
      availableIds: notFound.length ? next.map((row) => row.id) : undefined,
      tasks: next,
      summary: summaryText(next),
    };
  }

  function call(name, args = {}, callId = null) {
    switch (name) {
      case 'kusa_task_list':
      case 'task_list':
      case 'list_tasks':
        return listTasks(args);
      case 'kusa_task_add':
      case 'task_add':
      case 'add_task':
      case 'create_task':
        return addTasks(args, callId);
      case 'kusa_task_update':
      case 'task_update':
      case 'update_task':
      case 'complete_task':
        return updateTasks(args);
      default:
        return { ok: false, error: `unknown task tool: ${name}` };
    }
  }

  return {
    defs: TASK_TOOL_DEFS,
    sessionKey: key,
    dataDir: dir,
    persisted: persistable,
    list: listTasks,
    add: addTasks,
    update: updateTasks,
    call,
  };
}

/**
 * System-prompt nudge: the tools are always advertised, so this only tells the
 * model when they are worth using.
 * @returns {string}
 */
export function taskSystemPromptAddon() {
  return [
    'For a request that needs more than one step, write the steps down first:',
    'kusa_task_add creates them, kusa_task_list shows what is still open, and',
    'kusa_task_update flags each step completed as you finish it.',
    'Flagging a step that is already completed is harmless — it reports "unchanged"',
    'rather than failing or duplicating the row, so re-running a finished step is safe.',
    'A batch of two or more steps, when this session already has tasks, asks the user',
    'whether to start fresh or merge the batch into the current list. Do not call kusa_ask',
    'for that choice — kusa_task_add waits for it. If nobody answers, the batch is merged',
    'and the result says so.',
  ].join(' ');
}

/** OpenAI/Chat Completions tool schema list. */
export function taskToolSchemas() {
  return TASK_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
