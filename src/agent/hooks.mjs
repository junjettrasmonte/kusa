/**
 * In-process monitor hooks for the first-party Kusă chat agent.
 * Emits Cursor event names with Copilot-shaped camelCase payloads tagged
 * `kusa_version` so the store labels them harness: "kusa".
 */
import { runHook, readMonoClock, laneKey } from '../lib.mjs';
import { KUSA_HARNESS } from '../chat-store.mjs';

export const KUSA_HOOK_VERSION = '1';

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.sessionId
 * @param {string} [options.workspaceRoot]
 */
export function createKusaHookEmitter({ dataDir, sessionId, workspaceRoot = process.cwd() }) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!dataDir || !id) {
    return {
      enabled: false,
      dataDir: '',
      sessionId: '',
      sessionKey: '',
      sessionStart() {},
      userPrompt() {},
      preToolUse() {},
      postToolUse() {},
      postToolUseFailure() {},
      afterAgentResponse() {},
      agentStop() {},
    };
  }

  function emit(eventName, payload = {}) {
    try {
      const clock = readMonoClock();
      const body = {
        kusa_version: KUSA_HOOK_VERSION,
        harness: 'kusa',
        sessionId: id,
        timestamp: Date.now(),
        cwd: workspaceRoot,
        ...payload,
      };
      return runHook({
        dir: dataDir,
        eventName,
        stdinText: JSON.stringify(body),
        nowWall: body.timestamp,
        nowMono: clock.mono,
        bootId: clock.bootId,
        origin: 'kusa-agent',
      });
    } catch {
      // Monitoring must never break the chat agent.
      return null;
    }
  }

  return {
    enabled: true,
    // Monitor context for the agent's own tools (task tools keep their list in
    // the per-session sidecar under this lane key).
    dataDir,
    sessionId: id,
    sessionKey: laneKey(KUSA_HARNESS, id),
    sessionStart(extra = {}) {
      emit('sessionStart', { source: 'new', ...extra });
    },
    userPrompt(prompt, extra = {}) {
      emit('beforeSubmitPrompt', { prompt: String(prompt || ''), ...extra });
    },
    preToolUse({ name, args, callId } = {}) {
      emit('preToolUse', {
        toolName: String(name || ''),
        toolArgs: args && typeof args === 'object' ? args : {},
        toolCallId: callId ? String(callId) : undefined,
      });
    },
    postToolUse({ name, args, callId, result } = {}) {
      emit('postToolUse', {
        toolName: String(name || ''),
        toolArgs: args && typeof args === 'object' ? args : {},
        toolCallId: callId ? String(callId) : undefined,
        toolResult: {
          resultType: 'success',
          textResultForLlm: summarizeToolResult(result),
        },
      });
    },
    postToolUseFailure({ name, args, callId, error } = {}) {
      emit('postToolUseFailure', {
        toolName: String(name || ''),
        toolArgs: args && typeof args === 'object' ? args : {},
        toolCallId: callId ? String(callId) : undefined,
        error: String(error || 'tool failed'),
      });
    },
    afterAgentResponse(text, extra = {}) {
      emit('afterAgentResponse', { text: String(text || ''), ...extra });
    },
    agentStop(extra = {}) {
      return emit('stop', { stopReason: 'end_turn', ...extra });
    },
  };
}

function summarizeToolResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(0, 400);
  try {
    const json = JSON.stringify(result);
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return String(result).slice(0, 400);
  }
}
