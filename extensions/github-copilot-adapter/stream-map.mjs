/**
 * Pure Copilot JSONL → harness event mapper (testable without spawning).
 */
import { summariseToolResult } from '#features/chat/data/cli-ndjson-stream.mjs';

function dataOf(ev) {
  return ev?.data && typeof ev.data === 'object' ? ev.data : {};
}

export function emptyCopilotStreamState(cliSessionId = '') {
  return {
    cliSessionId: String(cliSessionId || '').trim(),
    thinking: '',
    content: '',
    turnError: null,
    toolMeta: new Map(),
  };
}

/**
 * @param {ReturnType<typeof emptyCopilotStreamState>} state
 * @param {object} ev
 * @param {(ev: object) => void} [emit]
 */
export function applyCopilotStreamEvent(state, ev, emit = () => {}) {
  const type = String(ev?.type || '');
  const data = dataOf(ev);

  if (type === 'session.start') {
    const sid = String(
      data.sessionId || data.session_id || ev.sessionId || ev.session_id || '',
    ).trim();
    if (sid) state.cliSessionId = sid;
    return;
  }

  if (type === 'assistant.reasoning_delta') {
    const delta = typeof data.deltaContent === 'string'
      ? data.deltaContent
      : (typeof data.delta === 'string' ? data.delta : '');
    if (!delta) return;
    state.thinking += delta;
    emit({ type: 'thinking', text: state.thinking });
    return;
  }

  if (type === 'assistant.message_delta') {
    const delta = typeof data.deltaContent === 'string'
      ? data.deltaContent
      : (typeof data.delta === 'string' ? data.delta : '');
    if (!delta) return;
    state.content += delta;
    emit({ type: 'content', text: state.content, delta });
    return;
  }

  if (type === 'assistant.message') {
    if (typeof data.reasoningText === 'string' && data.reasoningText && !state.thinking) {
      state.thinking = data.reasoningText;
      emit({ type: 'thinking', text: state.thinking });
    }
    if (typeof data.content === 'string' && data.content) {
      if (!state.content || data.content.length >= state.content.length) {
        state.content = data.content;
        emit({ type: 'content', text: state.content, delta: '' });
      }
    }
    return;
  }

  if (type === 'tool.execution_start') {
    const id = String(data.toolCallId || data.id || `tool-${Date.now()}`).trim();
    const name = String(data.toolName || data.name || 'tool');
    const argsObj = data.arguments && typeof data.arguments === 'object'
      ? data.arguments
      : {};
    state.toolMeta.set(id, { name, args: argsObj });
    emit({ type: 'tool_start', id, name, args: argsObj });
    return;
  }

  if (type === 'tool.execution_complete') {
    const id = String(data.toolCallId || data.id || '').trim();
    const meta = state.toolMeta.get(id) || {
      name: String(data.toolName || data.name || 'tool'),
      args: {},
    };
    emit({
      type: 'tool_result',
      id: id || `tool-${Date.now()}`,
      name: meta.name,
      args: meta.args,
      result: data.result,
      summary: summariseToolResult(data.result),
      ok: data.success !== false,
    });
    state.toolMeta.delete(id);
    return;
  }

  if (type === 'session.task_complete' || type === 'session.shutdown') {
    const sid = String(
      data.sessionId || data.session_id || ev.sessionId || '',
    ).trim();
    if (sid) state.cliSessionId = sid;
    if (typeof data.summary === 'string' && data.summary && !state.content.trim()) {
      state.content = data.summary;
      emit({ type: 'content', text: state.content, delta: '' });
    }
    return;
  }

  if (type === 'result') {
    const sid = String(ev.sessionId || data.sessionId || '').trim();
    if (sid) state.cliSessionId = sid;
    if (ev.success === false || (ev.exitCode != null && Number(ev.exitCode) !== 0)) {
      state.turnError = new Error(
        String(data.message || ev.error || 'Copilot CLI turn failed'),
      );
      state.turnError.code = 'ECOPILOT';
    }
  }

  if (type === 'error' || type === 'system.error') {
    state.turnError = new Error(String(data.message || ev.message || 'Copilot CLI error'));
    state.turnError.code = 'ECOPILOT';
  }
}
