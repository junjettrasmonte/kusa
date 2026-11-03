import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyCursorStreamEvent,
  emptyCursorStreamState,
  parseCursorToolCall,
} from '../extensions/cursor-adapter/stream-map.mjs';
import {
  applyCopilotStreamEvent,
  emptyCopilotStreamState,
} from '../extensions/github-copilot-adapter/stream-map.mjs';

describe('cursor stream map', () => {
  it('parses readToolCall names', () => {
    const parsed = parseCursorToolCall({
      readToolCall: { args: { path: 'a.txt' } },
    });
    assert.equal(parsed.name, 'read');
    assert.equal(parsed.args.path, 'a.txt');
  });

  it('captures the model reported on system init', () => {
    const state = emptyCursorStreamState();
    applyCursorStreamEvent(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-model',
      model: 'composer-1',
    });
    assert.equal(state.cliSessionId, 'sess-model');
    assert.equal(state.model, 'composer-1');
  });

  it('streams thinking, tools, and content deltas', () => {
    const state = emptyCursorStreamState();
    const events = [];
    const emit = (ev) => events.push(ev);

    applyCursorStreamEvent(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
    }, emit);
    assert.equal(state.cliSessionId, 'sess-1');

    applyCursorStreamEvent(state, {
      type: 'thinking',
      subtype: 'delta',
      text: 'Hmm',
    }, emit);
    applyCursorStreamEvent(state, {
      type: 'thinking',
      subtype: 'delta',
      text: '…',
    }, emit);
    applyCursorStreamEvent(state, {
      type: 'assistant',
      timestamp_ms: 1,
      message: { content: [{ type: 'text', text: 'Hi' }] },
    }, emit);
    applyCursorStreamEvent(state, {
      type: 'assistant',
      timestamp_ms: 2,
      message: { content: [{ type: 'text', text: ' there' }] },
    }, emit);
    applyCursorStreamEvent(state, {
      type: 'assistant',
      timestamp_ms: 3,
      model_call_id: 'm1',
      message: { content: [{ type: 'text', text: 'Hi there' }] },
    }, emit);
    applyCursorStreamEvent(state, {
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c1',
      tool_call: { shellToolCall: { args: { command: 'ls' } } },
    }, emit);
    applyCursorStreamEvent(state, {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c1',
      tool_call: {
        shellToolCall: {
          args: { command: 'ls' },
          result: { success: { exitCode: 0 } },
        },
      },
    }, emit);
    applyCursorStreamEvent(state, {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      result: 'Hi there',
    }, emit);

    assert.equal(state.thinking, 'Hmm…');
    assert.equal(state.content, 'Hi there');
    assert.deepEqual(
      events.filter((e) => e.type === 'thinking').map((e) => e.text),
      ['Hmm', 'Hmm…'],
    );
    assert.equal(events.some((e) => e.type === 'tool_start' && e.name === 'shell'), true);
    assert.equal(events.some((e) => e.type === 'tool_result' && e.id === 'c1'), true);
    // Duplicate flush before tool must not double content.
    assert.equal(events.filter((e) => e.type === 'content').at(-1).text, 'Hi there');
  });
});

describe('copilot stream map', () => {
  it('maps reasoning, tools, and message deltas', () => {
    const state = emptyCopilotStreamState();
    const events = [];
    const emit = (ev) => events.push(ev);

    applyCopilotStreamEvent(state, {
      type: 'session.start',
      data: { sessionId: 'cp-1' },
    }, emit);
    applyCopilotStreamEvent(state, {
      type: 'assistant.reasoning_delta',
      data: { deltaContent: 'plan' },
    }, emit);
    applyCopilotStreamEvent(state, {
      type: 'assistant.message_delta',
      data: { deltaContent: 'Hello' },
    }, emit);
    applyCopilotStreamEvent(state, {
      type: 'tool.execution_start',
      data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'pwd' } },
    }, emit);
    applyCopilotStreamEvent(state, {
      type: 'tool.execution_complete',
      data: { toolCallId: 't1', success: true, result: '/tmp' },
    }, emit);
    applyCopilotStreamEvent(state, {
      type: 'assistant.message_delta',
      data: { deltaContent: '!' },
    }, emit);

    assert.equal(state.cliSessionId, 'cp-1');
    assert.equal(state.thinking, 'plan');
    assert.equal(state.content, 'Hello!');
    assert.equal(events.some((e) => e.type === 'tool_start' && e.name === 'bash'), true);
    assert.equal(events.some((e) => e.type === 'tool_result' && e.summary.includes('/tmp')), true);
  });
});
