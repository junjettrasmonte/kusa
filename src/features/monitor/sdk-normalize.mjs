/**
 * Normalize GitHub Copilot SDK session events into the Kusă monitor event shape.
 *
 * Event names and payload fields are taken from `@github/copilot-sdk` typings
 * (`SessionEvent` in generated/session-events). Only types listed in
 * SDK_MONITOR_TYPES are accepted; unknown types return null.
 *
 * Reasoning: by default we keep status/duration metadata only — never raw
 * reasoning text — unless `persistReasoningText` is explicitly true.
 */

/** Event types confirmed in SDK 1.0.22 session-events and docs. */
export const SDK_MONITOR_TYPES = Object.freeze([
  'assistant.turn_start',
  'assistant.turn_end',
  'assistant.intent',
  'assistant.message',
  'assistant.message_delta',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'assistant.usage',
  'tool.execution_start',
  'tool.execution_complete',
  'session.idle',
  'session.error',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
]);

const MONITOR_SET = new Set(SDK_MONITOR_TYPES);

export const DEFAULT_SDK_SETTINGS = Object.freeze({
  sdkListenerEnabled: true,
  collectReasoningEvents: true,
  persistReasoningText: false,
});

/**
 * Targets the public `joinSession()` API can observe.
 * VS Code Copilot Chat / Local / Cursor have no supported join API.
 */
export const SDK_JOIN_TARGETS = Object.freeze({
  'copilot-cli': {
    supported: true,
    label: 'Copilot CLI',
    note: 'joinSession() attaches to the CLI foreground session when this process is a Copilot CLI extension child (SESSION_ID set).',
  },
  'vscode-copilot-chat': {
    supported: false,
    label: 'VS Code Copilot Chat',
    note: 'No public joinSession API for IDE Copilot Chat. Use .github/hooks/copilot-runtime-monitor.json.',
  },
  'vscode-local': {
    supported: false,
    label: 'VS Code Local',
    note: 'No public session join API. Use Copilot-format hooks mapped to Local payloads.',
  },
  cursor: {
    supported: false,
    label: 'Cursor',
    note: 'No Copilot SDK joinSession for Cursor. Use .cursor/hooks.json.',
  },
});

function asString(value, max = 240) {
  if (value == null) return '';
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function parseWall(timestamp, fallback) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string' && timestamp.trim()) {
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

function tokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * @param {object} raw - SDK SessionEvent-like `{ id, type, timestamp, data, agentId? }`
 * @param {object} [options]
 * @param {string} [options.sessionId]
 * @param {number} [options.nowWall]
 * @param {boolean} [options.collectReasoningEvents=true]
 * @param {boolean} [options.persistReasoningText=false]
 * @returns {object|null} normalized monitor event, or null to skip
 */
export function normalizeSdkEvent(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const type = asString(raw.type, 80);
  if (!type || !MONITOR_SET.has(type)) return null;

  const collectReasoning = options.collectReasoningEvents !== false;
  const persistText = options.persistReasoningText === true;
  if (!collectReasoning && (type === 'assistant.reasoning' || type === 'assistant.reasoning_delta')) {
    return null;
  }

  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const wall = parseWall(raw.timestamp, options.nowWall ?? Date.now());
  const eventId = asString(raw.id, 80) || `sdk-${type}-${wall}`;
  const sessionId = asString(options.sessionId ?? raw.sessionId ?? data.sessionId, 120) || null;
  const turnId = asString(data.turnId, 80) || null;
  const toolName = asString(data.toolName, 120) || '';
  const invocationId = asString(data.toolCallId, 120) || '';
  const agentId = asString(raw.agentId ?? data.agentId, 80) || '';

  /** @type {Record<string, unknown>} */
  const out = {
    id: eventId,
    sessionId,
    turnId,
    type,
    wall,
    toolName,
    invocationId,
    durationMs: null,
    success: null,
    source: 'sdk',
    harness: 'github-copilot',
    agentId,
    model: asString(data.model, 80) || '',
    intent: '',
    usage: null,
    reasoning: null,
    messageChars: null,
    aborted: null,
    errorMessage: '',
    subagentName: '',
  };

  if (type === 'assistant.intent') {
    out.intent = asString(data.intent, 400);
  }

  if (type === 'assistant.message') {
    const content = typeof data.content === 'string' ? data.content : '';
    out.messageChars = content.length;
    // Do not persist assistant reply text from the SDK path by default.
  }

  if (type === 'assistant.message_delta') {
    const delta = typeof data.deltaContent === 'string' ? data.deltaContent : '';
    out.messageChars = delta.length;
  }

  if (type === 'assistant.reasoning' || type === 'assistant.reasoning_delta') {
    const hasText = type === 'assistant.reasoning'
      ? Boolean(typeof data.content === 'string' && data.content.length)
      : Boolean(typeof data.deltaContent === 'string' && data.deltaContent.length);
    out.reasoning = {
      id: asString(data.reasoningId, 80) || eventId,
      status: type === 'assistant.reasoning' ? 'complete' : 'delta',
      hasText,
      // Raw text only when explicitly enabled — never by default.
      text: persistText && type === 'assistant.reasoning' ? asString(data.content, 4000) : '',
    };
  }

  if (type === 'assistant.usage') {
    const duration = Number(data.duration);
    out.durationMs = Number.isFinite(duration) && duration >= 0 ? duration : null;
    out.usage = {
      apiCallId: asString(data.apiCallId, 80) || '',
      inputTokens: tokenCount(data.inputTokens),
      outputTokens: tokenCount(data.outputTokens),
      cacheReadTokens: tokenCount(data.cacheReadTokens),
      cacheWriteTokens: tokenCount(data.cacheWriteTokens),
      reasoningTokens: tokenCount(data.reasoningTokens),
      durationMs: out.durationMs,
      model: asString(data.model, 80) || '',
      interactionType: asString(data.interactionType, 80) || '',
    };
  }

  if (type === 'tool.execution_start') {
    out.toolName = toolName || '(unknown)';
    out.invocationId = invocationId;
  }

  if (type === 'tool.execution_complete') {
    out.toolName = toolName || '(unknown)';
    out.invocationId = invocationId;
    out.success = data.success === true;
    if (data.error && typeof data.error === 'object') {
      out.errorMessage = asString(data.error.message || data.error.code || 'tool error', 240);
    }
  }

  if (type === 'session.idle') {
    out.aborted = data.aborted === true;
  }

  if (type === 'session.error') {
    out.errorMessage = asString(data.message || data.errorType || 'session error', 240);
    out.success = false;
  }

  if (type === 'subagent.started' || type === 'subagent.completed' || type === 'subagent.failed') {
    out.subagentName = asString(data.agentName || data.agentDisplayName, 120);
    const duration = Number(data.durationMs);
    if (Number.isFinite(duration) && duration >= 0) out.durationMs = duration;
    if (type === 'subagent.failed') {
      out.success = false;
      out.errorMessage = asString(data.error, 240);
    }
    if (type === 'subagent.completed') out.success = data.cancelled === true ? null : true;
  }

  return out;
}

/** Stable dedupe key for SDK events (prefer SDK event id). */
export function sdkDedupeKey(event) {
  if (!event) return '';
  if (event.id) return `sdk:${event.id}`;
  return `sdk:${event.type}:${event.sessionId || ''}:${event.turnId || ''}:${event.invocationId || ''}:${event.wall}`;
}
