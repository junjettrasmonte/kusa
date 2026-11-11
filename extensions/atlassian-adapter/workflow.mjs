/**
 * Ticket First — Atlassian Adapter orchestrator workflow catalog entry.
 *
 * Seeded into `.kusa/workflows/ticket-first.json` as a side-effect of the
 * adapter being present (serve start / workflows list). Roles + prompt live
 * here; lifecycle is LangGraph in `langgraph/ticket-first.mjs`. Missing-only
 * for foreign edits; stock seeds refresh when seedVersion advances.
 */
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TICKET_FIRST_WORKFLOW_ID = 'ticket-first';

/** Bump when the stock seed prompt/roles/runtime change so installs refresh. */
export const TICKET_FIRST_SEED_VERSION = 3;

export const TICKET_FIRST_WORKFLOW = Object.freeze({
  id: TICKET_FIRST_WORKFLOW_ID,
  name: 'Ticket First',
  /** Lifecycle framed by extension LangGraph; Orchestrator LLM still owns kusa_ask. */
  runtime: 'langgraph',
  description:
    'LangGraph-backed lifecycle (ensure ticket → kickoff → await direction). '
    + 'Starts from a Jira ticket on the session (attachments/ticket.json). '
    + 'The Orchestrator acknowledges the ticket and asks what to do next with clickable options.',
  seededBy: 'atlassian-adapter',
  seedVersion: TICKET_FIRST_SEED_VERSION,
  roles: {
    orchestrator: {
      profile: 'orchestrator',
      promptTemplate: [
        'You are the Ticket First Orchestrator for this session.',
        '',
        'Context: a Jira ticket is already attached to this session',
        '(composer Jira chip and/or attachments/ticket.json). Do not wait for a free-form brief.',
        '',
        'On this kickoff turn:',
        '1. Identify the issue key from the attached Jira chip or ticket.json.',
        '2. If ticket.json looks thin, call kusa_jira_get_issue then kusa_jira_save_session_ticket',
        '   so the session has full detail. Otherwise use what is already saved.',
        '3. Briefly acknowledge the ticket (key + summary) in plain language — what it is asking for.',
        '4. Immediately call kusa_ask with a short question and 2–5 mutually exclusive clickable options',
        '   so the user can choose the next step. Prefer concrete actions, for example:',
        '   - Investigate this ticket against the current workspace working copy, produce findings,',
        '     then formulate a recommendation',
        '   - Draft an implementation plan only (no code yet)',
        '   - Summarize the ticket and clarify acceptance criteria',
        '   - Something else (allow free text)',
        '5. Do not assign Subagents or implement code until the user picks an option.',
        '',
        'If Atlassian is not configured or no issue key can be found, say what is needed and stop.',
        '',
        '{{prompt}}',
      ].join('\n'),
    },
  },
});

function workflowsRoot(monitorDir) {
  return join(String(monitorDir || ''), 'workflows');
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
 * Seed or refresh ticket-first.json when missing / still a stock seed.
 * Never clobber a user-edited copy (seededBy missing or foreign, or higher version kept).
 * @param {string} monitorDir
 * @returns {string} workflows root
 */
export function ensureAtlassianWorkflowsSeeded(monitorDir) {
  const root = workflowsRoot(monitorDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, `${TICKET_FIRST_WORKFLOW.id}.json`);
  const existing = existsSync(path) ? readJsonSafe(path) : null;
  const shouldWrite = (() => {
    if (!existing || typeof existing !== 'object') return true;
    const ver = Number(existing.seedVersion) || 0;
    if (ver >= TICKET_FIRST_SEED_VERSION) return false;
    // Stock seeds (explicit or first-generation without seededBy) refresh.
    if (existing.seededBy === 'atlassian-adapter') return true;
    if (!existing.seededBy && String(existing.name || '') === TICKET_FIRST_WORKFLOW.name) {
      return true;
    }
    // Foreign / renamed copies stay untouched.
    return false;
  })();
  if (shouldWrite) {
    atomicWriteFile(path, `${JSON.stringify(TICKET_FIRST_WORKFLOW, null, 2)}\n`);
  }
  return root;
}

/** @param {string} monitorDir */
export function readTicketFirstWorkflowSource(monitorDir) {
  const path = join(workflowsRoot(monitorDir), `${TICKET_FIRST_WORKFLOW.id}.json`);
  if (!existsSync(path)) return null;
  return readJsonSafe(path);
}
