/**
 * Ask the user a question mid-turn — a clickable multiple-choice card.
 *
 * kusa_ask is the mirror of the approval gate for a different question: not
 * "may this run?" but "which of these does the user mean?". The model calls it,
 * the chat renders one clickable button per option plus a free-text answer
 * field, and the call resolves to the answer the user picked or typed — never
 * to a pending state the model could misread.
 *
 * Same contract as approval.mjs, on purpose: the wait and its fallback live
 * inside the gate every caller uses, so a tool can only ever report an answer
 * or an outright "nobody answered". With no interactive channel wired (bare
 * harness, no serve) the wait is over on arrival and the call says so
 * immediately instead of stalling for the timeout — the model then states the
 * assumption it is proceeding with rather than inventing an answer.
 *
 * An unanswered ask is not a silent default: unlike an approval, there is no
 * safe fallback for a question, so the result refuses and tells the model to
 * name its assumption in plain text.
 */

export const ASK_TIMEOUT_MS = 120_000;
export const MAX_OPTIONS = 6;
export const MAX_OPTION_LABEL = 120;
export const MAX_OPTION_DETAIL = 200;
export const MAX_QUESTION = 600;
export const MAX_ANSWER = 2_000;

/** Options are what make this a choice card; a question with none is free-text only. */
export const ASK_TOOL_DEFS = [
  {
    name: 'kusa_ask',
    description:
      'Ask the user a question and wait for their answer. Use it when the request is ambiguous '
      + 'and the options are real alternatives you would act on differently — not to confirm '
      + 'something you already know. The chat shows the question with one clickable button per '
      + 'option, plus a free-text field for anything none of them covers. The call resolves to '
      + 'the answer the user picked or typed. Nobody answering is not a stall: after 2 minutes '
      + 'the call refuses, so state the assumption you are proceeding with instead of inventing an answer.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question, one or two sentences, phrased for the user',
        },
        options: {
          type: 'array',
          minItems: 0,
          maxItems: MAX_OPTIONS,
          description:
            'Mutually exclusive choices the user can click (2–6 is the useful range). '
            + 'Omit for a free-text-only question.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The choice, shown as the button label' },
              detail: {
                type: 'string',
                description: 'Optional one-line clarification of that choice',
              },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        allowFreeText: {
          type: 'boolean',
          description: 'Offer the free-text answer field (default true)',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];

/** OpenAI/Chat Completions tool schema list. */
export function askToolSchemas() {
  return ASK_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * System-prompt nudge: the tool is always advertised, so this only tells the
 * model when asking is worth it.
 * @returns {string}
 */
export function askSystemPromptAddon() {
  return [
    'When a request is ambiguous and the alternatives change what you would do, ask the user',
    'instead of guessing: kusa_ask with a question and 2–6 mutually exclusive options.',
    'Keep it to one question at a time, and only when you cannot answer from what you have read.',
    'If nobody answers within 2 minutes the call refuses — say which assumption you are proceeding',
    'with rather than inventing an answer, and never say you are still waiting for one.',
  ].join(' ');
}

/**
 * Clamp whatever the model sent into the shape the card renders.
 * @param {object} args
 * @returns {{ error?: string, question: string, options: object[], allowFreeText: boolean }}
 */
export function normalizeAskArgs(args = {}) {
  const question = String(args.question ?? '').trim().slice(0, MAX_QUESTION);
  if (!question) return { error: 'question is required' };

  const raw = Array.isArray(args.options) ? args.options : [];
  const seen = new Set();
  const options = [];
  for (const entry of raw.slice(0, MAX_OPTIONS)) {
    const label = String(entry?.label ?? '').trim().slice(0, MAX_OPTION_LABEL);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    options.push({
      index: options.length,
      label,
      detail: String(entry?.detail ?? '').trim().slice(0, MAX_OPTION_DETAIL),
    });
  }

  return {
    question,
    options,
    allowFreeText: args.allowFreeText !== false,
  };
}

/**
 * @param {object} options
 * @param {(ask) => { selected?, freeText?, reason? }} [options.onAsk]
 *   owns the wait — serve's resolver settles it from POST /kusa/ask.
 * @param {(ask) => void} [options.emit] surfaces the question (UI/SSE).
 * @param {AbortSignal} [options.signal] Composer Stop — unblocks a pending ask.
 * @param {number} [options.timeoutMs]
 */
export function createAskGate({ onAsk = null, emit = null, signal = null, timeoutMs = null } = {}) {
  const askTimeoutMs = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), ASK_TIMEOUT_MS) : ASK_TIMEOUT_MS;
  const requests = [];
  let seq = 0;

  function abortError() {
    const err = new Error('aborted');
    err.code = 'ABORT';
    return err;
  }

  /** The card the UI renders, and the payload the model reads back. */
  function unanswered(reason, why) {
    return {
      ok: false,
      error: `the user did not answer — ${why}. Do not ask again for this question; `
        + 'state the assumption you are proceeding with in your reply.',
      unanswered: true,
      reason,
    };
  }

  async function call(name = '', args = {}, callId = null) {
    const normalized = normalizeAskArgs(args);
    if (normalized.error) return { ok: false, error: normalized.error };
    const { question, options, allowFreeText } = normalized;

    const id = `${callId || 'ask'}_${(seq += 1)}`;
    const ask = {
      id,
      callId,
      question,
      options,
      allowFreeText,
      // No rule default for a question — the countdown only explains that
      // nobody answering refuses the call, it never picks an option.
      status: 'pending',
      timeoutMs: askTimeoutMs,
      timeoutStartsAt: Date.now(),
    };
    requests.push(ask);
    emit?.(ask);

    if (typeof onAsk !== 'function') {
      // Nothing can answer this ask, so the wait is over on arrival.
      const settled = { ...ask, status: 'unanswered', reason: 'no interactive channel' };
      emit?.(settled);
      return { ...unanswered('unattended', 'no interactive channel is wired for this run') };
    }

    let onAbort = null;
    let timer = null;
    let answer = null;
    try {
      if (signal?.aborted) throw abortError();
      const races = [onAsk(ask)];
      races.push(new Promise((settleTimeout) => {
        timer = setTimeout(() => settleTimeout({ timeout: true }), askTimeoutMs);
      }));
      if (signal && typeof signal.addEventListener === 'function') {
        races.push(new Promise((_, reject) => {
          onAbort = () => reject(abortError());
          signal.addEventListener('abort', onAbort, { once: true });
        }));
      }
      answer = await Promise.race(races);
    } catch (err) {
      if (err?.code === 'ABORT') throw err;
      answer = { freeText: '', reason: 'ask could not be delivered' };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && signal) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
    }

    if (answer?.reason === 'stopped' || answer?.aborted === true) throw abortError();
    if (answer?.timeout === true) {
      const settled = { ...ask, status: 'unanswered' };
      emit?.(settled);
      return unanswered(
        'timeout',
        `no answer within ${Math.round(askTimeoutMs / 1000)}s — nobody clicked a choice`,
      );
    }

    // Resolve what the user actually chose: an index wins, then a label match,
    // then typed text. A click on an option is still reported verbatim so the
    // model acts on the exact wording the user saw.
    let selected = null;
    const index = Number(answer?.optionIndex);
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      selected = { ...options[index] };
    } else {
      const label = String(answer?.optionLabel ?? '').trim().toLowerCase();
      if (label) {
        const match = options.find((option) => option.label.toLowerCase() === label);
        if (match) selected = { ...match };
      }
    }
    const freeText = String(answer?.freeText ?? '').trim().slice(0, MAX_ANSWER);
    if (!selected && freeText) selected = { index: -1, label: freeText, detail: '' };

    if (!selected) {
      const settled = { ...ask, status: 'unanswered' };
      emit?.(settled);
      return unanswered('empty', 'the user opened the card but gave no answer');
    }

    const answerText = selected.label;
    const settled = {
      ...ask,
      status: 'answered',
      answer: { selected: selected.index >= 0 ? selected.index : null, freeText: selected.index === -1 ? selected.label : '' },
    };
    // Second emit for the same id: the UI merges by id, so the card flips from
    // "waiting" to "answered" instead of leaving a stuck countdown.
    emit?.(settled);
    return {
      ok: true,
      question,
      options,
      answer: answerText,
      selected,
      freeText: selected.index === -1 ? selected.label : '',
      decision: 'answered',
    };
  }

  return {
    defs: ASK_TOOL_DEFS,
    requests,
    timeoutMs: askTimeoutMs,
    call,
  };
}
