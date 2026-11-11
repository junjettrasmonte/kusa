/**
 * Ask the user a question mid-turn — a clickable multiple-choice card.
 *
 * kusa_ask is the mirror of the approval gate for a different question: not
 * "may this run?" but "which of these does the user mean?". The model calls it,
 * the chat renders one clickable button per option, and open answers come from
 * the message composer (any prompt while the question is open). The call
 * resolves to the answer the user picked or typed — never to a pending state
 * the model could misread.
 *
 * A single call can carry several related questions (`questions[]`). The card
 * then numbers each question (1, 2, …) and letters its options (a, b, c). A
 * legacy `{ question, options }` call is still one question with numbered
 * options.
 *
 * Same contract as approval.mjs, on purpose: the wait lives inside the gate
 * every caller uses, so a tool can only ever report an answer or an outright
 * "nobody answered". With an interactive channel the gate waits indefinitely
 * until the user answers or Composer Stop aborts. With no interactive channel
 * wired (bare harness, no serve) the wait is over on arrival and the call says
 * so immediately — the model then states the assumption it is proceeding with
 * rather than inventing an answer.
 *
 * An unanswered ask is not a silent default: unlike an approval, there is no
 * safe fallback for a question, so the result refuses and tells the model to
 * name its assumption in plain text.
 */

/** 0 = wait forever (default). A positive value is only for explicit overrides. */
export const ASK_TIMEOUT_MS = 0;
export const MAX_OPTIONS = 6;
export const MAX_QUESTIONS = 6;
export const MAX_OPTION_LABEL = 120;
export const MAX_OPTION_DETAIL = 200;
export const MAX_QUESTION = 600;
export const MAX_ANSWER = 2_000;

/** a, b, c… for multi-question option controls (and stored on every option). */
export function optionLetter(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > 25) return '';
  return String.fromCharCode(97 + i);
}

const OPTION_ITEM_SCHEMA = {
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
};

/** Options are what make this a choice card; a question with none is free-text only. */
export const ASK_TOOL_DEFS = [
  {
    name: 'kusa_ask',
    description:
      'Ask the user one or more questions and wait for their answer(s). Use it when the request '
      + 'is ambiguous and the options are real alternatives you would act on differently — not '
      + 'to confirm something you already know. For one question, pass question + options (numbered '
      + 'clicks). For several related questions in one card, pass questions[] — the UI numbers each '
      + 'question (1, 2, …) and letters its options (a, b, c). Open answers use the message composer '
      + '(any prompt while the card is open). The call waits until the user answers (or the run is '
      + 'stopped). If it refuses unanswered, state the assumption you are proceeding with instead '
      + 'of inventing an answer.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'A single question, or a short summary when using questions[]. Required unless questions[] is set.',
        },
        options: {
          type: 'array',
          minItems: 0,
          maxItems: MAX_OPTIONS,
          description:
            'Choices for a single-question ask (2–6 is the useful range). Ignored when questions[] is used. '
            + 'Omit for a composer-only question.',
          items: OPTION_ITEM_SCHEMA,
        },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          description:
            'Several related questions in one card. Each entry has its own question + options; '
            + 'the UI shows 1./2. with a./b./c. under each. Prefer this over multiple kusa_ask calls.',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'This item\'s question, one or two sentences',
              },
              options: {
                type: 'array',
                minItems: 0,
                maxItems: MAX_OPTIONS,
                description: 'Clickable choices for this question (lettered a, b, c…)',
                items: OPTION_ITEM_SCHEMA,
              },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
        allowFreeText: {
          type: 'boolean',
          description:
            'Invite open answers via the message composer when none of the options fit (default true)',
        },
      },
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
    'When several related choices must be made together, pass questions[] once instead of',
    'calling kusa_ask repeatedly. Only ask when you cannot answer from what you have read.',
    'The call waits until the user answers. A free-text reply may be kind "options" (clear picks)',
    'or kind "custom" (clarification/override) — never invent option picks they did not state.',
    'If it refuses unanswered, say which assumption you are proceeding with rather than inventing',
    'an answer, and never say you are still waiting.',
  ].join(' ');
}

/**
 * @param {unknown} raw
 * @returns {{ index: number, letter: string, label: string, detail: string }[]}
 */
function normalizeOptions(raw) {
  const seen = new Set();
  const options = [];
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, MAX_OPTIONS)) {
    const label = String(entry?.label ?? '').trim().slice(0, MAX_OPTION_LABEL);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const index = options.length;
    options.push({
      index,
      letter: optionLetter(index),
      label,
      detail: String(entry?.detail ?? '').trim().slice(0, MAX_OPTION_DETAIL),
    });
  }
  return options;
}

/**
 * Clamp whatever the model sent into the shape the card renders.
 * Always returns a `questions[]` (length ≥ 1). Single-question calls also
 * mirror the first entry onto top-level `question` / `options` for older UI.
 * @param {object} args
 * @returns {{ error?: string, question: string, options: object[], questions: object[], multi: boolean, allowFreeText: boolean }}
 */
export function normalizeAskArgs(args = {}) {
  const allowFreeText = args.allowFreeText !== false;
  /** @type {{ index: number, question: string, options: object[] }[]} */
  const questions = [];

  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
  for (const entry of rawQuestions.slice(0, MAX_QUESTIONS)) {
    const text = String(entry?.question ?? '').trim().slice(0, MAX_QUESTION);
    if (!text) continue;
    questions.push({
      index: questions.length,
      question: text,
      options: normalizeOptions(entry?.options),
    });
  }

  if (!questions.length) {
    const question = String(args.question ?? '').trim().slice(0, MAX_QUESTION);
    if (!question) return { error: 'question is required' };
    questions.push({
      index: 0,
      question,
      options: normalizeOptions(args.options),
    });
  }

  const multi = questions.length > 1;
  const summary = multi
    ? questions.map((q) => `${q.index + 1}. ${q.question}`).join(' ')
    : questions[0].question;
  // Prefer an explicit summary when the model sent both; otherwise derive it.
  const question = multi
    ? (String(args.question ?? '').trim().slice(0, MAX_QUESTION) || summary)
    : questions[0].question;

  return {
    question,
    // Single-question cards keep top-level options (numbered clicks). Multi
    // cards only expose options under each questions[] entry (lettered).
    options: multi ? [] : questions[0].options,
    questions,
    multi,
    allowFreeText,
  };
}

/**
 * Strict option match from a token — exact label, letter (a), or 1-based number.
 * No fuzzy / partial guessing: unmatched tokens return null.
 * @param {object[]} options
 * @param {unknown} token
 * @returns {object | null}
 */
export function matchOptionToken(options, token) {
  const list = Array.isArray(options) ? options : [];
  const raw = String(token ?? '').trim();
  if (!raw || !list.length) return null;
  const t = raw.toLowerCase();

  if (/^[a-z]$/i.test(t)) {
    const idx = t.charCodeAt(0) - 97;
    return idx >= 0 && idx < list.length ? { ...list[idx] } : null;
  }
  if (/^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    return idx >= 0 && idx < list.length ? { ...list[idx] } : null;
  }
  const match = list.find((option) => option.label.toLowerCase() === t);
  return match ? { ...match } : null;
}

/**
 * Parse composer free text against the ask card.
 * - kind: 'options' only when every option-question has a clear, unambiguous pick
 * - kind: 'custom' when the user wrote a clarification / override / incomplete reply
 *   (any clear option refs are returned as matched hints — never invent the rest)
 * - kind: 'empty' when there is nothing to parse
 * @param {object[]} questions
 * @param {unknown} freeText
 */
export function parseComposerAskText(questions, freeText) {
  const text = String(freeText ?? '').trim().slice(0, MAX_ANSWER);
  const list = Array.isArray(questions) ? questions : [];
  if (!text) return { kind: 'empty' };
  if (!list.length) return { kind: 'custom', freeText: text, matched: [], unmatched: [] };

  if (list.length === 1) {
    const matched = matchOptionToken(list[0].options, text);
    if (matched) {
      return {
        kind: 'options',
        rows: [{ questionIndex: list[0].index, question: list[0].question, selected: matched }],
      };
    }
    return {
      kind: 'custom',
      freeText: text,
      matched: [],
      unmatched: [list[0].index],
    };
  }

  /** @type {Map<number, object>} */
  const found = new Map();

  function tryAssign(qIndex, token) {
    if (!Number.isInteger(qIndex) || qIndex < 0 || qIndex >= list.length) return;
    if (found.has(qIndex)) return;
    const opt = matchOptionToken(list[qIndex].options, token);
    if (opt) found.set(qIndex, opt);
  }

  const segments = text.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    let m = seg.match(/^(\d+)\s*[.:)\-]\s*(.+)$/i);
    if (!m) m = seg.match(/^(\d+)\s+(.+)$/);
    if (m) {
      tryAssign(Number(m[1]) - 1, m[2].trim());
      continue;
    }
    m = seg.match(/^(\d+)\s*([a-z])$/i);
    if (m) tryAssign(Number(m[1]) - 1, m[2]);
  }

  for (const m of text.matchAll(/\b(\d+)\s*([a-z])\b/gi)) {
    tryAssign(Number(m[1]) - 1, m[2]);
  }

  const needed = list.filter((q) => Array.isArray(q.options) && q.options.length);
  if (needed.length && needed.every((q) => found.has(q.index))) {
    return {
      kind: 'options',
      rows: needed.map((q) => ({
        questionIndex: q.index,
        question: q.question,
        selected: found.get(q.index),
      })),
    };
  }

  const matched = [...found.entries()].map(([questionIndex, selected]) => ({
    questionIndex,
    question: list[questionIndex]?.question || '',
    selected,
  }));
  const unmatched = needed.filter((q) => !found.has(q.index)).map((q) => q.index);
  return { kind: 'custom', freeText: text, matched, unmatched };
}

/**
 * Resolve one question's pick from optionIndex / optionLabel / freeText.
 * freeText only becomes an option when matchOptionToken succeeds — otherwise
 * it is a custom answer (index -1), never a guessed option.
 * @param {object[]} options
 * @param {{ optionIndex?: unknown, optionLabel?: unknown, freeText?: unknown }} answer
 */
function resolveOneSelection(options, answer = {}) {
  const index = Number(answer?.optionIndex);
  if (Number.isInteger(index) && index >= 0 && index < options.length) {
    return { ...options[index] };
  }
  const fromLabel = matchOptionToken(options, answer?.optionLabel);
  if (fromLabel) return fromLabel;

  const freeText = String(answer?.freeText ?? '').trim().slice(0, MAX_ANSWER);
  if (!freeText) return null;
  const fromText = matchOptionToken(options, freeText);
  if (fromText) return fromText;
  return {
    index: -1,
    letter: '',
    label: freeText,
    detail: '',
    custom: true,
  };
}

/**
 * Format the structured answers the model reads back.
 * @param {{ question: string, selected: { label: string } }[]} rows
 */
function formatMultiAnswerText(rows) {
  return rows
    .map((row, i) => `${i + 1}. ${row.question} → ${row.selected.label}`)
    .join('\n');
}

function customAnswerNote(matched = [], unmatchedQuestions = []) {
  const parts = [
    'The user replied in free text (custom answer, clarification, or override).',
    'Do not invent option picks they did not clearly state.',
  ];
  if (matched.length) {
    parts.push(
      `Unambiguous option refs found: ${matched
        .map((row) => `${row.questionIndex + 1}→${row.selected.label}`)
        .join(', ')}.`,
    );
  }
  if (unmatchedQuestions.length) {
    parts.push(
      `No clear option pick for: ${unmatchedQuestions.map((q) => `"${q}"`).join('; ')}.`,
    );
  }
  return parts.join(' ');
}

/**
 * @param {object} options
 * @param {(ask) => { selected?, freeText?, answers?, reason? }} [options.onAsk]
 *   owns the wait — serve's resolver settles it from POST /kusa/ask.
 * @param {(ask) => void} [options.emit] surfaces the question (UI/SSE).
 * @param {AbortSignal} [options.signal] Composer Stop — unblocks a pending ask.
 * @param {number} [options.timeoutMs] Optional positive ms; omit/0 waits forever.
 */
export function createAskGate({ onAsk = null, emit = null, signal = null, timeoutMs = null } = {}) {
  const explicitTimeout = Number(timeoutMs);
  const askTimeoutMs = Number.isFinite(explicitTimeout) && explicitTimeout > 0
    ? Math.floor(explicitTimeout)
    : ASK_TIMEOUT_MS;
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
    const { question, options, questions, multi, allowFreeText } = normalized;

    const id = `${callId || 'ask'}_${(seq += 1)}`;
    const ask = {
      id,
      callId,
      question,
      options,
      questions,
      multi,
      allowFreeText,
      // No rule default and no countdown by default — the gate waits until the
      // user answers or Stop aborts. A positive timeoutMs is an explicit override.
      status: 'pending',
      timeoutMs: askTimeoutMs,
      timeoutStartsAt: askTimeoutMs > 0 ? Date.now() : 0,
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
      if (askTimeoutMs > 0) {
        races.push(new Promise((settleTimeout) => {
          timer = setTimeout(() => settleTimeout({ timeout: true }), askTimeoutMs);
        }));
      }
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

    // Multi: prefer answers[] (clicks). Composer freeText is parsed against
    // questions/options — clear picks only; otherwise custom, never assumed.
    if (multi) {
      const rawAnswers = Array.isArray(answer?.answers) ? answer.answers : null;
      if (rawAnswers?.length) {
        const rows = [];
        for (const q of questions) {
          // Composer-only items (no options) are covered by whole-card freeText,
          // not by answers[] — skip them here.
          if (!q.options.length) continue;
          const patch = rawAnswers.find((row) => Number(row?.questionIndex) === q.index)
            || rawAnswers[q.index]
            || {};
          // Clicks send optionIndex — do not accept freeText-as-custom inside
          // answers[] rows (that path is whole-card composer parsing below).
          const selected = resolveOneSelection(q.options, {
            optionIndex: patch.optionIndex ?? patch.selected,
            optionLabel: patch.optionLabel,
          });
          if (!selected || selected.custom) {
            const settled = { ...ask, status: 'unanswered' };
            emit?.(settled);
            return unanswered('empty', 'not every question in the card was answered');
          }
          rows.push({ question: q.question, questionIndex: q.index, selected });
        }
        if (!rows.length) {
          const settled = { ...ask, status: 'unanswered' };
          emit?.(settled);
          return unanswered('empty', 'the user opened the card but gave no answer');
        }
        const answerText = formatMultiAnswerText(rows);
        const settled = {
          ...ask,
          status: 'answered',
          answer: {
            selected: null,
            freeText: '',
            kind: 'options',
            answers: rows.map((row) => ({
              questionIndex: row.questionIndex,
              selected: row.selected.index >= 0 ? row.selected.index : null,
              freeText: '',
            })),
          },
        };
        emit?.(settled);
        return {
          ok: true,
          kind: 'options',
          question,
          questions,
          multi: true,
          answers: rows.map((row) => ({
            question: row.question,
            questionIndex: row.questionIndex,
            answer: row.selected.label,
            selected: row.selected,
            freeText: '',
          })),
          answer: answerText,
          decision: 'answered',
        };
      }

      const freeText = String(answer?.freeText ?? '').trim().slice(0, MAX_ANSWER);
      const parsed = parseComposerAskText(questions, freeText);
      if (parsed.kind === 'empty') {
        const settled = { ...ask, status: 'unanswered' };
        emit?.(settled);
        return unanswered('empty', 'the user opened the card but gave no answer');
      }
      if (parsed.kind === 'options') {
        const rows = parsed.rows;
        const answerText = formatMultiAnswerText(rows);
        const settled = {
          ...ask,
          status: 'answered',
          answer: {
            selected: null,
            freeText: '',
            kind: 'options',
            answers: rows.map((row) => ({
              questionIndex: row.questionIndex,
              selected: row.selected.index,
              freeText: '',
            })),
          },
        };
        emit?.(settled);
        return {
          ok: true,
          kind: 'options',
          question,
          questions,
          multi: true,
          answers: rows.map((row) => ({
            question: row.question,
            questionIndex: row.questionIndex,
            answer: row.selected.label,
            selected: row.selected,
            freeText: '',
          })),
          answer: answerText,
          decision: 'answered',
        };
      }

      // Custom / clarification / override — do not invent missing option picks.
      const matched = Array.isArray(parsed.matched) ? parsed.matched : [];
      const unmatchedQuestions = (Array.isArray(parsed.unmatched) ? parsed.unmatched : [])
        .map((idx) => questions[idx]?.question)
        .filter(Boolean);
      const settled = {
        ...ask,
        status: 'answered',
        answer: {
          selected: null,
          freeText,
          kind: 'custom',
          custom: true,
          matched: matched.map((row) => ({
            questionIndex: row.questionIndex,
            selected: row.selected.index,
          })),
          answers: null,
        },
      };
      emit?.(settled);
      return {
        ok: true,
        kind: 'custom',
        custom: true,
        question,
        questions,
        multi: true,
        answer: freeText,
        freeText,
        matchedOptions: matched.map((row) => ({
          question: row.question,
          questionIndex: row.questionIndex,
          answer: row.selected.label,
          selected: row.selected,
        })),
        unansweredQuestions: unmatchedQuestions,
        note: customAnswerNote(matched, unmatchedQuestions),
        decision: 'answered',
      };
    }

    // Single question: click index / label first; composer text is matched
    // strictly (label, letter, or number) else custom — never assumed.
    const rawIndex = answer?.optionIndex;
    const clickIndex = Number(rawIndex);
    const hasClick = (
      rawIndex != null
      && rawIndex !== ''
      && Number.isFinite(clickIndex)
      && Number.isInteger(clickIndex)
    ) || Boolean(String(answer?.optionLabel ?? '').trim());
    if (hasClick) {
      const selected = resolveOneSelection(options, {
        optionIndex: answer?.optionIndex,
        optionLabel: answer?.optionLabel,
      });
      if (!selected || selected.custom) {
        const settled = { ...ask, status: 'unanswered' };
        emit?.(settled);
        return unanswered('empty', 'the user opened the card but gave no answer');
      }
      const settled = {
        ...ask,
        status: 'answered',
        answer: { selected: selected.index, freeText: '', kind: 'options' },
      };
      emit?.(settled);
      return {
        ok: true,
        kind: 'options',
        question,
        options,
        questions,
        multi: false,
        answer: selected.label,
        selected,
        freeText: '',
        decision: 'answered',
      };
    }

    const freeText = String(answer?.freeText ?? '').trim().slice(0, MAX_ANSWER);
    const parsed = parseComposerAskText(questions, freeText);
    if (parsed.kind === 'empty') {
      const settled = { ...ask, status: 'unanswered' };
      emit?.(settled);
      return unanswered('empty', 'the user opened the card but gave no answer');
    }
    if (parsed.kind === 'options') {
      const selected = parsed.rows[0].selected;
      const settled = {
        ...ask,
        status: 'answered',
        answer: { selected: selected.index, freeText: '', kind: 'options' },
      };
      emit?.(settled);
      return {
        ok: true,
        kind: 'options',
        question,
        options,
        questions,
        multi: false,
        answer: selected.label,
        selected,
        freeText: '',
        decision: 'answered',
      };
    }

    const settled = {
      ...ask,
      status: 'answered',
      answer: { selected: null, freeText, kind: 'custom', custom: true },
    };
    emit?.(settled);
    return {
      ok: true,
      kind: 'custom',
      custom: true,
      question,
      options,
      questions,
      multi: false,
      answer: freeText,
      selected: { index: -1, letter: '', label: freeText, detail: '', custom: true },
      freeText,
      note: customAnswerNote([], [question]),
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
