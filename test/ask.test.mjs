import { createAskGate, ASK_TOOL_DEFS, ASK_TIMEOUT_MS, askToolSchemas, normalizeAskArgs } from '../src/agent/index.mjs';
import { createTrailAwareTools, openaiToolSchemasWithTrail } from '../src/agent/index.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('ask gate', () => {
  it('refuses outright when nothing can answer it', async () => {
    const gate = createAskGate();
    const result = await gate.call('kusa_ask', {
      question: 'Which target should I build?',
      options: [{ label: 'debug', detail: 'unoptimised build' }, { label: 'release' }],
    });
    // No pending state and no countdown: an unattended question is not a stall.
    assert.equal(result.ok, false);
    assert.equal(result.unanswered, true);
    assert.equal(result.decision, undefined);
    assert.match(result.error, /no interactive channel/);
    assert.match(result.error, /state the assumption/i);
    assert.equal(gate.requests.length, 1);
    assert.equal(gate.requests[0].status, 'pending');
  });

  it('resolves to the option the user clicked', async () => {
    const asked = [];
    const gate = createAskGate({
      onAsk: (ask) => {
        asked.push(ask);
        return { optionIndex: 1 };
      },
    });
    const result = await gate.call('kusa_ask', {
      question: 'Which target should I build?',
      options: [{ label: 'debug' }, { label: 'release', detail: 'optimised' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'release');
    assert.equal(result.selected.label, 'release');
    assert.equal(result.selected.index, 1);
    assert.equal(result.freeText, '');
    assert.equal(result.decision, 'answered');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].options.length, 2);
    assert.equal(asked[0].allowFreeText, true);
  });

  it('accepts a typed answer when no option fits', async () => {
    const gate = createAskGate({ onAsk: () => ({ freeText: '  build both, debug first  ' }) });
    const result = await gate.call('kusa_ask', {
      question: 'Which target should I build?',
      options: [{ label: 'debug' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'build both, debug first');
    assert.equal(result.selected.index, -1);
    assert.equal(result.freeText, 'build both, debug first');
  });

  it('matches a label when the index is missing, and ignores a stale one', async () => {
    const gate = createAskGate({ onAsk: () => ({ optionIndex: 99, optionLabel: ' Debug ' }) });
    const result = await gate.call('kusa_ask', {
      question: 'Which target?',
      options: [{ label: 'debug' }, { label: 'release' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.selected.label, 'debug');
    assert.equal(result.selected.index, 0);
  });

  it('refuses when the card was opened but nothing was typed', async () => {
    const gate = createAskGate({ onAsk: () => ({ freeText: '   ' }) });
    const result = await gate.call('kusa_ask', { question: 'Which target?', options: [] });
    assert.equal(result.ok, false);
    assert.equal(result.unanswered, true);
    assert.match(result.error, /gave no answer/);
  });

  it('refuses after its own countdown, never picking an option for the model', async () => {
    const gate = createAskGate({ timeoutMs: 5, onAsk: () => new Promise(() => {}) });
    const result = await gate.call('kusa_ask', {
      question: 'Which target?',
      options: [{ label: 'debug' }, { label: 'release' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.unanswered, true);
    assert.match(result.error, /no answer within/);
    assert.equal(result.selected, undefined);
  });

  it('ends the turn when the composer Stop aborts a pending question', async () => {
    const controller = new AbortController();
    const gate = createAskGate({ signal: controller.signal, onAsk: () => new Promise(() => {}) });
    controller.abort();
    let thrown = null;
    try {
      await gate.call('kusa_ask', { question: 'Which target?' });
    } catch (err) {
      thrown = err;
    }
    assert.equal(thrown?.code, 'ABORT');
  });

  it('serves Stop as an abort, not as an empty answer', async () => {
    const gate = createAskGate({ onAsk: () => ({ reason: 'stopped' }) });
    let thrown = null;
    try {
      await gate.call('kusa_ask', { question: 'Which target?' });
    } catch (err) {
      thrown = err;
    }
    assert.equal(thrown?.code, 'ABORT');
  });

  it('emits the same id twice so the UI card flips instead of sticking', async () => {
    const frames = [];
    const gate = createAskGate({
      emit: (frame) => frames.push(frame),
      onAsk: () => ({ optionIndex: 0 }),
    });
    await gate.call('kusa_ask', {
      question: 'Which target?',
      options: [{ label: 'debug' }],
    });
    assert.equal(frames.length, 2);
    assert.equal(frames[0].id, frames[1].id);
    assert.equal(frames[0].status, 'pending');
    assert.equal(frames[1].status, 'answered');
    assert.equal(frames[1].answer.selected, 0);
  });

  it('clamps what the model sent: dedupe, cap, and trim', async () => {
    const normalized = normalizeAskArgs({
      question: '  Which target?  ',
      options: [
        { label: 'debug' },
        { label: ' DEBUG ', detail: 'dupes are dropped' },
        { label: 'release' },
        { label: '' },
      ],
      allowFreeText: false,
    });
    assert.equal(normalized.question, 'Which target?');
    assert.equal(normalized.options.length, 2);
    assert.equal(normalized.options[0].index, 0);
    assert.equal(normalized.options[1].label, 'release');
    assert.equal(normalized.allowFreeText, false);
    assert.equal(normalizeAskArgs({ question: '  ' }).error, 'question is required');
  });

  it('advertises kusa_ask in every mode — asking is read-only', async () => {
    const names = (mode) => openaiToolSchemasWithTrail(mode).map((schema) => schema.function.name);
    for (const mode of ['agent', 'plan', 'ask']) {
      assert.ok(names(mode).includes('kusa_ask'));
    }
    assert.equal(ASK_TOOL_DEFS.length, 1);
    assert.equal(ASK_TIMEOUT_MS, 120_000);
    assert.ok(askToolSchemas()[0].function.parameters.properties.options.items.properties.label);
  });

  it('routes the tool through the agent tool set', async () => {
    const tools = createTrailAwareTools(process.cwd(), {
      onAsk: () => ({ optionIndex: 0 }),
    });
    assert.ok(tools.defs.some((def) => def.name === 'kusa_ask'));
    const result = await tools.call('kusa_ask', { question: 'Which target?', options: [{ label: 'debug' }] });
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'debug');
  });
});
