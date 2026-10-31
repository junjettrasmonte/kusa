/**
 * Chat agent modes — the VS Code Copilot-style Ask / Plan / Agent picker.
 * A mode decides which tool families the agent may call; the approval rules
 * (see approval.mjs) decide whether the gated terminal/browser tools need a
 * user yes first. Ask and Plan share the read-only surface, Plan additionally
 * asks the model to answer with a numbered plan instead of edits.
 */

export const AGENT_MODE_ASK = 'ask';
export const AGENT_MODE_PLAN = 'plan';
export const AGENT_MODE_AGENT = 'agent';

/** Picker options shown in the composer (label + one-line blurb). */
export const AGENT_MODES = [
  {
    id: AGENT_MODE_ASK,
    label: 'Ask',
    blurb: 'Read-only — search and read files, never edit, never run commands.',
  },
  {
    id: AGENT_MODE_PLAN,
    label: 'Plan',
    blurb: 'Read-only — answers with a numbered plan; no file changes.',
  },
  {
    id: AGENT_MODE_AGENT,
    label: 'Agent',
    blurb: 'Read and write files; commands follow the approval rules.',
  },
];

/** Tools that change the working copy — Agent mode only. Bare aliases included. */
const WRITE_TOOLS = new Set([
  'kusa_write_file',
  'kusa_patch_file',
  'kusa_delete_file',
  'write_file',
  'write',
  'patch_file',
  'patch',
  'edit',
  'delete_file',
  'delete',
]);

/** Terminal/browser tools — Agent mode only, and gated by the approval rules. */
const EXEC_TOOLS = new Set(['kusa_terminal', 'terminal', 'kusa_browse', 'browse']);

/**
 * Anything unknown stays allowed: the native loop only advertises filtered
 * schemas, and OpenCode has its own built-in tool names we must not block.
 * @param {string} toolName
 * @param {string} mode
 * @returns {boolean}
 */
export function isToolAllowedInMode(toolName, mode) {
  if (normalizeAgentMode(mode) === AGENT_MODE_AGENT) return true;
  const name = String(toolName || '');
  return !WRITE_TOOLS.has(name) && !EXEC_TOOLS.has(name);
}

/** Default is Agent so chat keeps its full read/write behaviour when unset. */
export function normalizeAgentMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === AGENT_MODE_PLAN || mode === AGENT_MODE_ASK) return mode;
  return AGENT_MODE_AGENT;
}

/** Extra system-prompt lines for the selected mode ('' for Agent). */
export function agentModeSystemPromptAddon(mode) {
  const normalized = normalizeAgentMode(mode);
  if (normalized === AGENT_MODE_ASK) {
    return 'Mode: Ask. Answer questions about this codebase using read-only tools only — never create, change, or delete files, and never run commands.';
  }
  if (normalized === AGENT_MODE_PLAN) {
    return 'Mode: Plan. Read and search the codebase, then answer with a short numbered plan of steps to implement. Do not create, change, or delete files and do not run commands — the plan is text only.';
  }
  return '';
}

/** Human label for a mode id (used in status events and the composer). */
export function agentModeLabel(mode) {
  const normalized = normalizeAgentMode(mode);
  const entry = AGENT_MODES.find((option) => option.id === normalized);
  return entry?.label || 'Agent';
}
