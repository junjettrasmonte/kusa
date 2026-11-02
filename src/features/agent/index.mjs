/**
 * Kusă agent harness entry — OpenCode SDK when selected/available,
 * otherwise a native OpenAI-compatible tool loop with Kusă file tools.
 */
import { runOpenAiAgentLoop } from './openai-loop.mjs';
import { agentModeLabel, normalizeAgentMode } from './modes.mjs';
import { opencodeCliAvailable, runOpencodePrompt } from './opencode.mjs';
import { supportsVision } from './model-capabilities.mjs';
import {
  attachmentTextBlock,
  normalizeAttachments,
} from '#features/chat/data/attachments.mjs';

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
  DEFAULT_ENDPOINT_LABEL,
  listAgentModelGroups,
  listAgentModels,
  resolveAgentEndpoint,
  resolveAgentMaxSteps,
  runOpenAiAgentLoop,
} from './openai-loop.mjs';
export { supportsVision, visionLabel } from './model-capabilities.mjs';
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
} from '#features/trail/agent/trail.mjs';
export {
  buildOpencodeConfig,
  closeOpencodeInstance,
  getOpencodeInstance,
  opencodeCliAvailable,
  runOpencodePrompt,
  // Rule mapping helpers: the OpenCode backend enforces the Rule through its
  // own permission set, so callers and tests need to read that map.
  resolveApprovalRule,
  ruleClassOf,
  permissionForRule,
  agentToolFlags,
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
 * @param {Array<object>} [options.attachments] files the composer attached to this prompt
 * @param {() => Promise<string[]> | string[]} [options.onSteer] mid-turn "send now" prompts,
 *   polled per streamed chunk so the prompt interrupts the running model call
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
  endpointIdOverride = null,
  onSteer = null,
  onOptions = null,
  attachments = null,
}) {
  // Composer Model pick: model id + optional endpoint id (which heading the
  // pick sat under). endpointId is what routes a probed-only Google / proxy
  // model to that endpoint instead of Default.
  const scopedSettings = {
    ...settings,
    ...(modelOverride ? { agentModel: String(modelOverride).trim() } : {}),
    ...(endpointIdOverride != null
      ? { agentEndpointId: String(endpointIdOverride).trim() }
      : {}),
  };
  const withMode = {
    ...scopedSettings,
    ...(approvalMode ? { agentApprovalMode: approvalMode } : {}),
    agentMode: normalizeAgentMode(mode),
  };
  // The composer's files for this prompt, normalised once so both backends
  // read the same records the browser staged.
  const attachedFiles = normalizeAttachments(attachments);
  const backend = withMode?.agentBackend === 'opencode' ? 'opencode' : 'native';

  if (backend === 'opencode') {
    try {
      onEvent?.({
        type: 'status',
        status: 'started',
        backend: 'opencode',
        mode: withMode.agentMode,
        modeLabel: agentModeLabel(withMode.agentMode),
        // The Rule this turn actually runs under: OpenCode enforces it through
        // its own permission set (see opencode.mjs), so the monitor must show
        // the effective value, not the settings default.
        approvalMode: approvalMode || withMode?.agentApprovalMode || '',
        attachments: {
          files: attachedFiles.length,
          // OpenCode takes a prompt string: nothing is sent as an image part,
          // so every picture is named rather than shown.
          images: 0,
          droppedImages: supportsVision(withMode?.agentModel) === false
            ? attachedFiles.length
            : attachedFiles.filter((file) => file.kind === 'image').length,
        },
      });
      const result = await runOpencodePrompt({
        workspaceRoot,
        settings: withMode,
        // OpenCode takes a prompt string, so an attachment can only arrive as
        // text: readable files are inlined, everything else is named. Images
        // it cannot see are named too — the note says so.
        prompt: attachedFiles.length
          ? [String(prompt || '').trim(), attachmentTextBlock(attachedFiles)].filter(Boolean).join('\n\n')
          : prompt,
        opencodeSessionId,
        title: sessionTitle,
        // The composer Rule must reach this backend: it decides whether OpenCode
        // may run bash/webfetch at all.
        approvalMode,
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
      .filter((m) => m && (m.text || m.content || m.attachments) && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({
        role: m.role,
        content: String(m.text ?? m.content ?? ''),
        ...(normalizeAttachments(m.attachments).length ? { attachments: m.attachments } : {}),
      })),
    {
      role: 'user',
      content: String(prompt || ''),
      ...(attachedFiles.length ? { attachments: attachedFiles } : {}),
    },
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
