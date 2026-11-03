/**
 * Pure Cursor stream-json → harness event mapper (testable without spawning).
 */
import { summariseToolResult } from '#features/chat/data/cli-ndjson-stream.mjs';

export function assistantTextFromMessage(message) {
  const content = message?.content;
  if (typeof message?.text === 'string') return message.text;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

export function parseCursorToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') {
    return { name: 'tool', args: {}, result: null, ok: true };
  }
  if (toolCall.function && typeof toolCall.function === 'object') {
    let args = toolCall.function.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* keep string */ }
    }
    return {
      name: String(toolCall.function.name || 'function'),
      args: args && typeof args === 'object' ? args : { raw: args },
      result: toolCall.function.result ?? null,
      ok: toolCall.function.result?.error == null,
    };
  }
  const key = Object.keys(toolCall).find((k) => /ToolCall$/i.test(k) || k === 'function')
    || Object.keys(toolCall)[0];
  const body = key ? toolCall[key] : null;
  const name = key
    ? key.replace(/ToolCall$/i, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
    : 'tool';
  const result = body?.result ?? null;
  const ok = !(result && (result.error || result.failure || result.failed));
  return {
    name: name || 'tool',
    args: body?.args && typeof body.args === 'object' ? body.args : {},
    result,
    ok,
  };
}

/** @returns {{ cliSessionId?: string, thinking: string, content: string, segmentHadDeltas: boolean, sawResultText: string, turnError: Error | null, toolArgsById: Map<string, object> }} */
export function emptyCursorStreamState(cliSessionId = '') {
  return {
    cliSessionId: String(cliSessionId || '').trim(),
    thinking: '',
    content: '',
    segmentHadDeltas: false,
    sawResultText: '',
    turnError: null,
    toolArgsById: new Map(),
  };
}

/**
 * Apply one Cursor NDJSON event into state + emit harness events.
 * @param {ReturnType<typeof emptyCursorStreamState>} state
 * @param {object} ev
 * @param {(ev: object) => void} [emit]
 */
export function applyCursorStreamEvent(state, ev, emit = () => {}) {
  const type = String(ev?.type || '');

  if (type === 'system' && (ev.subtype === 'init' || ev.session_id)) {
    const sid = String(ev.session_id || '').trim();
    if (sid) state.cliSessionId = sid;
    return;
  }

  if (type === 'thinking') {
    if (ev.subtype === 'delta' && typeof ev.text === 'string') {
      state.thinking += ev.text;
      emit({ type: 'thinking', text: state.thinking });
    } else if (typeof ev.text === 'string' && ev.text) {
      state.thinking = state.thinking ? `${state.thinking}\n${ev.text}` : ev.text;
      emit({ type: 'thinking', text: state.thinking });
    } else if (ev.subtype === 'completed' && state.thinking) {
      emit({ type: 'thinking', text: state.thinking });
    }
    return;
  }

  if (type === 'assistant') {
    const text = assistantTextFromMessage(ev.message);
    if (!text) return;
    if (ev.model_call_id != null) return;
    if (ev.timestamp_ms != null) {
      state.content += text;
      state.segmentHadDeltas = true;
      emit({ type: 'content', text: state.content, delta: text });
      return;
    }
    if (state.segmentHadDeltas) return;
    state.content = text;
    emit({ type: 'content', text: state.content, delta: '' });
    return;
  }

  if (type === 'tool_call') {
    const callId = String(ev.call_id || ev.id || '').trim() || `tool-${Date.now()}`;
    const parsed = parseCursorToolCall(ev.tool_call);
    if (ev.subtype === 'started' || (!ev.subtype && !parsed.result)) {
      state.toolArgsById.set(callId, parsed.args);
      emit({
        type: 'tool_start',
        id: callId,
        name: parsed.name,
        args: parsed.args,
      });
      state.segmentHadDeltas = false;
      return;
    }
    if (ev.subtype === 'completed' || parsed.result != null) {
      const args = state.toolArgsById.get(callId) || parsed.args;
      emit({
        type: 'tool_result',
        id: callId,
        name: parsed.name,
        args,
        result: parsed.result,
        summary: summariseToolResult(parsed.result),
        ok: parsed.ok !== false,
      });
      state.toolArgsById.delete(callId);
      state.segmentHadDeltas = false;
    }
    return;
  }

  if (type === 'result') {
    const sid = String(ev.session_id || '').trim();
    if (sid) state.cliSessionId = sid;
    if (typeof ev.result === 'string' && ev.result.trim()) {
      state.sawResultText = ev.result;
      if (!state.content.trim()) {
        state.content = ev.result;
        emit({ type: 'content', text: state.content, delta: '' });
      }
    }
    if (ev.is_error || ev.subtype === 'error') {
      state.turnError = new Error(String(ev.result || ev.error || 'Cursor Agent turn failed'));
      state.turnError.code = 'ECURSOR';
    }
  }
}
