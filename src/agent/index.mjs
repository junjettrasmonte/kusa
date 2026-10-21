/**
 * Kusă agent harness entry — OpenCode SDK when selected/available,
 * otherwise a native OpenAI-compatible tool loop with Kusă file tools.
 */
import { runOpenAiAgentLoop } from './openai-loop.mjs';
import { agentModeLabel, normalizeAgentMode } from './modes.mjs';
import { opencodeCliAvailable, runOpencodePrompt } from './opencode.mjs';

export {
  agentSystemPrompt,
  createFileTools,
  FILE_TOOL_DEFS,
  openaiToolSchemas,
  resolveWorkspacePath,
} from './files.mjs';
export { createKusaHookEmitter, KUSA_HOOK_VERSION } from './hooks.mjs';
export {
  DEFAULT_MAX_STEPS,
  listAgentModels,
  resolveAgentEndpoint,
  resolveAgentMaxSteps,
  runOpenAiAgentLoop,
} from './openai-loop.mjs';
export {
  AGENT_MODES,
  AGENT_MODE_AGENT,
  agentModeLabel,
  agentModeSystemPromptAddon,
  isToolAllowedInMode,
  normalizeAgentMode,
} from './modes.mjs';
export {
  agentToolGroups,
  createTrailAwareTools,
  openaiToolSchemasWithTrail,
  resolveTrailPolicy,
  trailNotReadyMessage,
  trailSystemPromptAddon,
  TRAIL_TOOL_DEFS,
} from './trail.mjs';
export {
  buildOpencodeConfig,
  closeOpencodeInstance,
  getOpencodeInstance,
  opencodeCliAvailable,
  runOpencodePrompt,
} from './opencode.mjs';
export {
  approvalModeLabel,
  approvalTimeoutAllows,
  APPROVAL_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  resolveApprovalTimeoutMs,
  createApprovalGate,
  APPROVAL_GATED_TOOLS,
  approvalSystemPromptAddon,
  normalizeApprovalMode,
} from './approval.mjs';
export { createTerminalTools, TERMINAL_TOOL_DEFS } from './terminal.mjs';
export { createBrowserTools, BROWSER_TOOL_DEFS } from './browser.mjs';
export {
  TASK_TOOL_DEFS,
  createTaskTools,
  taskToolSchemas,
  taskSystemPromptAddon,
} from './tasks.mjs';
export {
  ASK_TOOL_DEFS,
  ASK_TIMEOUT_MS,
  MAX_OPTIONS,
  askSystemPromptAddon,
  askToolSchemas,
  createAskGate,
  normalizeAskArgs,
} from './ask.mjs';

/**
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {object} options.settings
 * @param {string} options.prompt
 * @param {Array<{ role: string, text?: string, content?: string }>} [options.history]
 * @param {string} [options.opencodeSessionId]
 * @param {string} [options.sessionTitle]
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.hooks] monitor hook emitter from createKusaHookEmitter
 * @param {string} [options.approvalMode] 'ask-deny' (default) | 'ask-allow' | 'allow' | 'deny' for terminal/browser tools
 * @param {(request) => boolean} [options.onApprove] surfaces a user decision for a gated tool
 * @param {(ask) => { selected?, freeText? }} [options.onAsk] owns the wait for a kusa_ask answer
 * @param {string} [options.mode] 'ask' | 'plan' | 'agent' (default) — tool capability gate
 * @param {string} [options.modelOverride] model id from the composer picker, else settings.agentModel
 * @param {() => Promise<string[]> | string[]} [options.onSteer] mid-turn "send now" prompts
 * @param {() => Promise<{ mode?: string, approvalMode?: string } | null> | { mode?: string, approvalMode?: string } | null} [options.onOptions]
 *   mid-turn composer Mode / Rules — applied at the next step boundary
 */
export async function runKusaAgent({
  workspaceRoot,
  settings,
  prompt,
  history = [],
  opencodeSessionId,
  sessionTitle,
  signal,
  onEvent,
  stream = true,
  hooks = null,
  approvalMode = null,
  onApprove = null,
  onAsk = null,
  mode = null,
  modelOverride = null,
  onSteer = null,
  onOptions = null,
}) {
  const scopedSettings = modelOverride
    ? { ...settings, agentModel: String(modelOverride).trim() }
    : settings;
  const withMode = {
    ...scopedSettings,
    ...(approvalMode ? { agentApprovalMode: approvalMode } : {}),
    agentMode: normalizeAgentMode(mode),
  };
  const backend = withMode?.agentBackend === 'opencode' ? 'opencode' : 'native';

  if (backend === 'opencode') {
    try {
      onEvent?.({
        type: 'status',
        status: 'started',
        backend: 'opencode',
        mode: withMode.agentMode,
        modeLabel: agentModeLabel(withMode.agentMode),
      });
      const result = await runOpencodePrompt({
        workspaceRoot,
        settings: withMode,
        prompt,
        opencodeSessionId,
        title: sessionTitle,
      });
      if (result.text) onEvent?.({ type: 'content', delta: result.text, text: result.text });
      onEvent?.({ type: 'done', ...result, thinking: result.thinking || '' });
      return result;
    } catch (err) {
      if (err?.code === 'ENOENT' || !opencodeCliAvailable()) {
        // Fall through to native so chat still works without the CLI.
      } else {
        onEvent?.({ type: 'error', message: err?.message || String(err) });
        throw err;
      }
    }
  }

  const messages = [
    ...history
      .filter((m) => m && (m.text || m.content) && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({
        role: m.role,
        content: String(m.text ?? m.content ?? ''),
      })),
    { role: 'user', content: String(prompt || '') },
  ];

  return runOpenAiAgentLoop({
    workspaceRoot,
    settings: scopedSettings,
    messages,
    signal,
    onEvent,
    stream,
    hooks,
    approvalMode,
    onApprove,
    onAsk,
    mode,
    modelOverride,
    onSteer,
    onOptions,
  });
}
