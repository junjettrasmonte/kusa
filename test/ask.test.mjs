import {
  createAskGate,
  ASK_TOOL_DEFS,
  ASK_TIMEOUT_MS,
  askToolSchemas,
  matchOptionToken,
  normalizeAskArgs,
  parseComposerAskText,
} from '#features/agent/index.mjs';
import { createTrailAwareTools, openaiToolSchemasWithTrail } from '#features/agent/index.mjs';
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

  it('treats unmatched composer text as a custom answer — not an assumed option', async () => {
    const gate = createAskGate({ onAsk: () => ({ freeText: '  build both, debug first  ' }) });
    const result = await gate.call('kusa_ask', {
      question: 'Which target should I build?',
      options: [{ label: 'debug' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'custom');
    assert.equal(result.custom, true);
    assert.equal(result.answer, 'build both, debug first');
    assert.equal(result.selected.index, -1);
    assert.equal(result.selected.custom, true);
    assert.equal(result.freeText, 'build both, debug first');
    assert.match(result.note, /Do not invent option picks/i);
  });

  it('matches composer text to an option only when the label/letter/number is exact', async () => {
    const gate = createAskGate({ onAsk: () => ({ freeText: ' Release ' }) });
    const result = await gate.call('kusa_ask', {
      question: 'Which target?',
      options: [{ label: 'debug' }, { label: 'release' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'options');
    assert.equal(result.answer, 'release');
    assert.equal(result.selected.index, 1);
    assert.equal(result.freeText, '');

    const byLetter = await createAskGate({ onAsk: () => ({ freeText: 'b' }) }).call('kusa_ask', {
      question: 'Which target?',
      options: [{ label: 'debug' }, { label: 'release' }],
    });
    assert.equal(byLetter.kind, 'options');
    assert.equal(byLetter.selected.index, 1);
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

  it('waits indefinitely by default — no countdown on the pending card', async () => {
    const gate = createAskGate({
      onAsk: () => ({ optionIndex: 0 }),
    });
    const result = await gate.call('kusa_ask', {
      question: 'Which target?',
      options: [{ label: 'debug' }, { label: 'release' }],
    });
    assert.equal(result.ok, true);
    assert.equal(gate.timeoutMs, 0);
    assert.equal(gate.requests[0].timeoutMs, 0);
    assert.equal(gate.requests[0].timeoutStartsAt, 0);
  });

  it('honours an explicit timeoutMs override without picking an option', async () => {
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
    assert.equal(normalized.options[0].letter, 'a');
    assert.equal(normalized.options[1].label, 'release');
    assert.equal(normalized.multi, false);
    assert.equal(normalized.questions.length, 1);
    assert.equal(normalized.allowFreeText, false);
    assert.equal(normalizeAskArgs({ question: '  ' }).error, 'question is required');
  });

  it('normalizes questions[] into a multi card with lettered options', () => {
    const normalized = normalizeAskArgs({
      questions: [
        {
          question: 'Which target?',
          options: [{ label: 'debug' }, { label: 'release' }],
        },
        {
          question: 'Which arch?',
          options: [{ label: 'arm64' }, { label: 'x64' }, { label: 'both' }],
        },
      ],
    });
    assert.equal(normalized.multi, true);
    assert.equal(normalized.questions.length, 2);
    assert.equal(normalized.options.length, 0);
    assert.equal(normalized.questions[0].options[0].letter, 'a');
    assert.equal(normalized.questions[1].options[2].letter, 'c');
    assert.match(normalized.question, /1\. Which target\?/);
  });

  it('resolves multi-question picks into one structured answer', async () => {
    const gate = createAskGate({
      onAsk: () => ({
        answers: [
          { questionIndex: 0, optionIndex: 1 },
          { questionIndex: 1, optionIndex: 0 },
        ],
      }),
    });
    const result = await gate.call('kusa_ask', {
      questions: [
        { question: 'Which target?', options: [{ label: 'debug' }, { label: 'release' }] },
        { question: 'Which arch?', options: [{ label: 'arm64' }, { label: 'x64' }] },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.multi, true);
    assert.equal(result.answers.length, 2);
    assert.equal(result.answers[0].answer, 'release');
    assert.equal(result.answers[1].answer, 'arm64');
    assert.match(result.answer, /1\. Which target\? → release/);
    assert.match(result.answer, /2\. Which arch\? → arm64/);
  });

  it('parses multi composer text into options only when every question is clear', async () => {
    const parsed = parseComposerAskText([
      { index: 0, question: 'Which target?', options: [
        { index: 0, letter: 'a', label: 'debug' },
        { index: 1, letter: 'b', label: 'release' },
      ] },
      { index: 1, question: 'Which arch?', options: [
        { index: 0, letter: 'a', label: 'arm64' },
        { index: 1, letter: 'b', label: 'x64' },
      ] },
    ], '1b\n2a');
    assert.equal(parsed.kind, 'options');
    assert.equal(parsed.rows[0].selected.label, 'release');
    assert.equal(parsed.rows[1].selected.label, 'arm64');

    const gate = createAskGate({ onAsk: () => ({ freeText: '1: release\n2: arm64' }) });
    const result = await gate.call('kusa_ask', {
      questions: [
        { question: 'Which target?', options: [{ label: 'debug' }, { label: 'release' }] },
        { question: 'Which arch?', options: [{ label: 'arm64' }, { label: 'x64' }] },
      ],
    });
    assert.equal(result.kind, 'options');
    assert.equal(result.answers[0].answer, 'release');
    assert.equal(result.answers[1].answer, 'arm64');
  });

  it('keeps incomplete multi composer text as custom — does not assume the rest', async () => {
    assert.equal(matchOptionToken([{ index: 0, label: 'debug' }], 'deb'), null);

    const gate = createAskGate({
      onAsk: () => ({ freeText: '1b — and for arch, whatever is fastest' }),
    });
    const result = await gate.call('kusa_ask', {
      questions: [
        { question: 'Which target?', options: [{ label: 'debug' }, { label: 'release' }] },
        { question: 'Which arch?', options: [{ label: 'arm64' }, { label: 'x64' }] },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'custom');
    assert.equal(result.custom, true);
    assert.equal(result.matchedOptions.length, 1);
    assert.equal(result.matchedOptions[0].answer, 'release');
    assert.deepEqual(result.unansweredQuestions, ['Which arch?']);
    assert.match(result.note, /Do not invent option picks/i);
  });

  it('accepts a free-text clarification/override for a multi card as custom', async () => {
    const gate = createAskGate({
      onAsk: () => ({ freeText: 'skip both — ship the canary build instead' }),
    });
    const result = await gate.call('kusa_ask', {
      questions: [
        { question: 'Which target?', options: [{ label: 'debug' }, { label: 'release' }] },
        { question: 'Which arch?', options: [{ label: 'arm64' }, { label: 'x64' }] },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'custom');
    assert.equal(result.matchedOptions.length, 0);
    assert.equal(result.answer, 'skip both — ship the canary build instead');
  });

  it('advertises kusa_ask in every mode — asking is read-only', async () => {
    const names = (mode) => openaiToolSchemasWithTrail(mode).map((schema) => schema.function.name);
    for (const mode of ['agent', 'plan', 'ask']) {
      assert.ok(names(mode).includes('kusa_ask'));
    }
    assert.equal(ASK_TOOL_DEFS.length, 1);
    assert.equal(ASK_TIMEOUT_MS, 0);
    assert.ok(askToolSchemas()[0].function.parameters.properties.options.items.properties.label);
    assert.ok(askToolSchemas()[0].function.parameters.properties.questions);
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
