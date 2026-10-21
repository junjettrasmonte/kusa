/**
 * OpenAI-compatible chat-completions agent loop using Kusă file tools.
 * Supports token streaming (content + thinking) and tool-call events via onEvent.
 */
import { agentSystemPrompt } from './files.mjs';
import {
  approvalSystemPromptAddon,
  normalizeApprovalMode,
  resolveApprovalTimeoutMs,
} from './approval.mjs';
import { askSystemPromptAddon } from './ask.mjs';
import {
  createTrailAwareTools,
  openaiToolSchemasWithTrail,
  resolveTrailPolicy,
  trailSystemPromptAddon,
} from './trail.mjs';
import { agentModeLabel, agentModeSystemPromptAddon, normalizeAgentMode } from './modes.mjs';
import { taskSystemPromptAddon } from './tasks.mjs';

export const DEFAULT_MAX_STEPS = 100;
const MAX_MAX_STEPS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @param {object} settings
 * @returns {{ baseUrl: string, model: string, headers: Record<string, string>, authMode: string, apiKey: string }}
 */
export function resolveAgentEndpoint(settings = {}) {
  const baseUrl = String(settings.agentBaseUrl || '').trim().replace(/\/+$/, '');
  const model = String(settings.agentModel || '').trim() || 'gpt-4o-mini';
  const authMode = (settings.agentAuthMode === 'apikey' || settings.agentAuthMode === 'bearer')
    ? 'apikey'
    : 'none';
  const apiKey = String(settings.agentApiKey ?? settings.agentAuthToken ?? '').trim();
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (authMode === 'apikey' && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return { baseUrl, model, headers, authMode, apiKey };
}

/**
 * Native tool-loop step budget from settings (`agentMaxSteps`).
 * @param {object} [settings]
 * @returns {number}
 */
export function resolveAgentMaxSteps(settings = {}) {
  const n = Number(settings?.agentMaxSteps);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(1, Math.floor(n)));
}

const MODEL_LIST_TIMEOUT_MS = 8_000;

/**
 * Models the configured OpenAI-compatible endpoint advertises (`GET /models`).
 * A single-model endpoint still gets a picker — it defaults to that model.
 * @param {object} settings
 * @returns {{ default: string, models: string[] }}
 */
export async function listAgentModels(settings = {}) {
  const { baseUrl, model, headers } = resolveAgentEndpoint(settings);
  const fallback = { default: model, models: model ? [model] : [] };
  if (!baseUrl) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { ...headers, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      return fallback;
    }
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
    const ids = list
      .map((entry) => (typeof entry === 'string' ? entry : String(entry?.id ?? entry?.model ?? '')).trim())
      .filter(Boolean);
    const unique = [...new Set(ids.length ? ids : fallback.models)];
    // Keep the configured model first so the picker's default is obvious.
    const ordered = model && unique.includes(model)
      ? [model, ...unique.filter((id) => id !== model)]
      : unique;
    return { default: model, models: ordered };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function asText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

function thinkingFromMessage(message) {
  if (!message || typeof message !== 'object') return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'reasoning_text']) {
    const v = message[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function thinkingFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'reasoning_text']) {
    const v = delta[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * Parse one SSE chunk block from an OpenAI-compatible stream.
 * @param {string} block
 */
function parseSseDataBlock(block) {
  const lines = block.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') return data === '[DONE]' ? { done: true } : null;
  try {
    return { json: JSON.parse(data) };
  } catch {
    return null;
  }
}

/**
 * Drain complete SSE frames from a buffer (supports \\n\\n and \\r\\n\\r\\n).
 */
function ingestSseBuffer(buffer, state) {
  let { content, thinking, finishReason, sawError, toolCalls, onEvent } = state;
  const splitAt = (buf) => {
    const a = buf.indexOf('\n\n');
    const b = buf.indexOf('\r\n\r\n');
    if (a === -1) return b === -1 ? -1 : b;
    if (b === -1) return a;
    return Math.min(a, b);
  };
  const sepLen = (buf, idx) => (buf.startsWith('\r\n\r\n', idx) ? 4 : 2);

  let sep;
  while ((sep = splitAt(buffer)) !== -1) {
    const block = buffer.slice(0, sep);
    buffer = buffer.slice(sep + sepLen(buffer, sep));
    const parsed = parseSseDataBlock(block);
    if (!parsed) continue;
    if (parsed.done) {
      finishReason = finishReason || 'stop';
      continue;
    }
    const json = parsed.json;
    if (json?.error) {
      sawError = json.error;
      continue;
    }
    const choice = json?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    // Some providers send a full message on the final chunk instead of deltas.
    if (choice.message && typeof choice.message === 'object') {
      const msg = choice.message;
      const think = thinkingFromMessage(msg);
      if (think && !thinking) {
        thinking = think;
        onEvent?.({ type: 'thinking', delta: think, text: thinking });
      }
      const text = asText(msg.content);
      if (text && !content) {
        content = text;
        onEvent?.({ type: 'content', delta: text, text: content });
      }
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc, idx) => {
          toolCalls.set(idx, {
            id: tc.id || `tool_${idx}`,
            type: tc.type || 'function',
            function: {
              name: tc.function?.name || '',
              arguments: typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || {}),
            },
          });
        });
      }
    }

    const delta = choice.delta || {};
    const thinkDelta = thinkingFromDelta(delta);
    if (thinkDelta) {
      thinking += thinkDelta;
      onEvent?.({ type: 'thinking', delta: thinkDelta, text: thinking });
    }

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onEvent?.({ type: 'content', delta: delta.content, text: content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isFinite(tc.index) ? tc.index : toolCalls.size;
        const cur = toolCalls.get(idx) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') {
          cur.function.arguments += tc.function.arguments;
        }
        toolCalls.set(idx, cur);
      }
    }
  }

  return { buffer, content, thinking, finishReason, sawError };
}

/**
 * Consume an OpenAI chat.completions stream and accumulate message + tool calls.
 * @param {Response} response
 * @param {{ onEvent?: (ev: object) => void, signal?: AbortSignal }} opts
 */
async function consumeChatCompletionStream(response, { onEvent, signal } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};
    return {
      message: data?.choices?.[0]?.message || null,
      finishReason: data?.choices?.[0]?.finish_reason || null,
      errorBody: data,
    };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  /** @type {Map<number, { id: string, type: string, function: { name: string, arguments: string } }>} */
  const toolCalls = new Map();
  let finishReason = null;
  let sawError = null;

  while (true) {
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
      const err = new Error('aborted');
      err.code = 'ABORT';
      throw err;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    ({ buffer, content, thinking, finishReason, sawError } = ingestSseBuffer(buffer, {
      content,
      thinking,
      finishReason,
      sawError,
      toolCalls,
      onEvent,
    }));
  }

  // Flush a trailing SSE frame that lacked a final blank line.
  if (buffer.trim()) {
    buffer += '\n\n';
    ({ buffer, content, thinking, finishReason, sawError } = ingestSseBuffer(buffer, {
      content,
      thinking,
      finishReason,
      sawError,
      toolCalls,
      onEvent,
    }));
  }

  if (sawError) {
    const err = new Error(sawError.message || JSON.stringify(sawError));
    err.code = 'EHTTP';
    throw err;
  }

  const orderedTools = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((t) => t.function?.name);

  /** @type {Record<string, unknown>} */
  const message = {
    role: 'assistant',
    content: content || null,
  };
  if (thinking) message.reasoning_content = thinking;
  if (orderedTools.length) message.tool_calls = orderedTools;

  return { message, finishReason, errorBody: null };
}

/**
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {object} options.settings
 * @param {Array<{ role: string, content: string }>} options.messages
 * @param {number} [options.maxSteps]
 * @param {AbortSignal} [options.signal]
 * @param {(ev: object) => void} [options.onEvent]
 * @param {boolean} [options.stream]
 * @param {object} [options.hooks] Kusă monitor hook emitter (pre/post tool)
 * @param {string} [options.approvalMode] overrides settings.agentApprovalMode for this run ('ask-deny' | 'ask-allow' | 'allow' | 'deny')
 * @param {(request) => boolean | { allowed, remember }} [options.onApprove] user decision for gated tools
 * @param {string} [options.mode] 'ask' | 'plan' | 'agent'
 * @param {string} [options.modelOverride] composer model picker
 * @param {() => Promise<string[]> | string[]} [options.onSteer] mid-turn "send now" prompts
 * @param {() => Promise<{ mode?: string, approvalMode?: string } | null> | { mode?: string, approvalMode?: string } | null} [options.onOptions]
 *   mid-turn Mode / Rules — applied at each step boundary before the model call
 */
export async function runOpenAiAgentLoop({
  workspaceRoot,
  settings,
  messages,
  maxSteps: maxStepsOpt,
  signal,
  onEvent,
  stream = true,
  hooks = null,
  approvalMode = null,
  onApprove = null,
  onAsk = null,
  mode = null,
  modelOverride = null,
  onSteer = null,
  onOptions = null,
}) {
  const maxSteps = maxStepsOpt != null
    ? resolveAgentMaxSteps({ agentMaxSteps: maxStepsOpt })
    : resolveAgentMaxSteps(settings);
  const endpoint = resolveAgentEndpoint(settings);
  const { baseUrl, headers } = endpoint;
  // The composer's model picker wins over the configured default; Ask/Plan modes
  // only advertise read-only tools, Agent adds write + approval-gated tools.
  const model = String(modelOverride || '').trim() || endpoint.model;
  // Mutable: composer Mode / Rules changes land at the next step boundary via
  // onOptions (same timing as steering), so they affect the next model call and
  // any tools that follow — not only the next turn.
  let agentMode = normalizeAgentMode(mode);
  if (!baseUrl) {
    const err = new Error('Set an OpenAI-compatible base URL under Settings → Kusă agent.');
    err.code = 'EINVAL';
    throw err;
  }

  const trailPolicy = resolveTrailPolicy(settings, workspaceRoot);
  let approvalModeResolved = normalizeApprovalMode(approvalMode ?? settings?.agentApprovalMode);
  // Settings → minutes → ms; the gate owns this one deadline for ask-deny / ask-allow.
  const approvalTimeoutMs = resolveApprovalTimeoutMs((() => {
    const n = Number(settings?.agentApprovalTimeoutMinutes);
    const mins = Number.isFinite(n) ? Math.min(60, Math.max(1, Math.floor(n))) : 2;
    return mins * 60_000;
  })());
  const tools = createTrailAwareTools(workspaceRoot, {
    enforceTrail: trailPolicy.enforce && trailPolicy.ready,
    approvalMode: approvalModeResolved,
    approvalTimeoutMs,
    mode: agentMode,
    onApprove,
    // Same AbortSignal the composer Stop button aborts — gated tools waiting
    // on an ask race this, so Stop is not stuck behind the approval countdown.
    signal,
    approvalEvent: (ask) => onEvent?.({ type: 'approval_request', ...ask }),
    // Monitor context so the task tools can keep the model's task list in the
    // per-session sidecar. Absent (bare harness) the list stays in memory only.
    dataDir: hooks?.dataDir || '',
    sessionKey: hooks?.sessionKey || '',
    // Interactive channel for kusa_ask: serve's resolver holds the question
    // until POST /kusa/ask answers it. Absent, the ask refuses immediately.
    onAsk,
    askEvent: (ask) => onEvent?.({ type: 'ask_request', ...ask }),
  });
  let toolSchemas = openaiToolSchemasWithTrail(agentMode);
  const buildSystemPrompt = (modeNow, approvalNow) => {
    const promptAddons = [
      agentModeSystemPromptAddon(modeNow),
      taskSystemPromptAddon(),
      askSystemPromptAddon(),
      trailSystemPromptAddon(trailPolicy),
      approvalSystemPromptAddon(approvalNow, approvalTimeoutMs),
    ].filter((addon) => typeof addon === 'string' && addon.trim());
    return agentSystemPrompt(promptAddons.join(' '));
  };
  let systemPrompt = buildSystemPrompt(agentMode, approvalModeResolved);
  /** @type {Array<{ role: string, content?: string | null, tool_calls?: unknown[], tool_call_id?: string, name?: string, reasoning_content?: string }>} */
  const transcript = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? m.text ?? ''),
  }));

  /** @type {{ id: string, name: string, ok: boolean, summary: string, args?: object, result?: unknown }[]} */
  const toolTrace = [];
  let steps = 0;
  let finalText = '';
  let allThinking = '';
  // Messages the user pushed while this turn was already running (Composer
  // "queue" → "send now"). onSteer is the queue owner's handle; drainSteer()
  // empties it into the transcript, so a steering message is seen by the model
  // at the next step boundary and never re-sent as a duplicate turn later.
  let steeredText = '';

  onEvent?.({
    type: 'status',
    status: 'started',
    model,
    baseUrl,
    mode: agentMode,
    modeLabel: agentModeLabel(agentMode),
    approvalMode: approvalModeResolved,
  });

  // Composer Mode / Rules while busy: apply before the next model call so the
  // advertised tools, system prompt, and approval gate match the pickers.
  const applyLiveOptions = async () => {
    if (typeof onOptions !== 'function') return;
    let opts = null;
    try {
      opts = await onOptions();
    } catch {
      return;
    }
    if (!opts || typeof opts !== 'object') return;
    const nextMode = opts.mode != null && String(opts.mode).trim()
      ? normalizeAgentMode(opts.mode)
      : agentMode;
    const nextApproval = opts.approvalMode != null && String(opts.approvalMode).trim()
      ? normalizeApprovalMode(opts.approvalMode)
      : approvalModeResolved;
    if (nextMode === agentMode && nextApproval === approvalModeResolved) return;
    agentMode = nextMode;
    approvalModeResolved = nextApproval;
    tools.setMode(agentMode);
    tools.approval.setMode(approvalModeResolved);
    toolSchemas = openaiToolSchemasWithTrail(agentMode);
    systemPrompt = buildSystemPrompt(agentMode, approvalModeResolved);
    onEvent?.({
      type: 'status',
      status: 'options',
      mode: agentMode,
      modeLabel: agentModeLabel(agentMode),
      approvalMode: approvalModeResolved,
    });
  };

  while (steps < maxSteps) {
    steps += 1;
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.code = 'ABORT';
      throw err;
    }

    onEvent?.({ type: 'step', step: steps });

    // Steering boundary: anything the user sent now lands before the next model
    // call, so the model reacts to it instead of finishing the old request.
    const drainSteer = async (source) => {
      const texts = source ? await source() : [];
      for (const entry of (texts || [])) {
        const text = String(typeof entry === 'string' ? entry : (entry?.text ?? '')).trim();
        if (!text) continue;
        transcript.push({ role: 'user', content: text });
        steeredText = steeredText ? `${steeredText}\n\n${text}` : text;
        onEvent?.({ type: 'steer', text });
      }
    };
    await applyLiveOptions();
    await drainSteer(onSteer);

    const url = `${baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify({
          model,
          stream: Boolean(stream),
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            ...transcript,
          ],
          tools: toolSchemas,
          tool_choice: 'auto',
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let detail = raw.slice(0, 400) || response.statusText;
      try {
        const data = raw ? JSON.parse(raw) : {};
        detail = data?.error?.message || data?.message || detail;
      } catch { /* keep */ }
      const err = new Error(`Model endpoint HTTP ${response.status}: ${detail}`);
      err.code = 'EHTTP';
      err.status = response.status;
      throw err;
    }

    let choice;

    const contentType = String(response.headers.get('content-type') || '');
    const looksLikeSse = contentType.includes('text/event-stream')
      || contentType.includes('application/x-ndjson')
      || contentType.includes('text/plain');

    if (stream && response.body && (looksLikeSse || !contentType.includes('application/json'))) {
      const consumed = await consumeChatCompletionStream(response, { onEvent, signal });
      choice = consumed.message;
      if (typeof choice?.reasoning_content === 'string' && choice.reasoning_content) {
        allThinking += (allThinking ? '\n' : '') + choice.reasoning_content;
      }
    } else {
      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        const err = new Error(`Model endpoint returned non-JSON (HTTP ${response.status})`);
        err.code = 'EPROTO';
        throw err;
      }
      choice = data?.choices?.[0]?.message;
      if (choice) {
        const think = thinkingFromMessage(choice);
        if (think) {
          allThinking += (allThinking ? '\n' : '') + think;
          onEvent?.({ type: 'thinking', delta: think, text: allThinking });
        }
        const content = asText(choice.content);
        if (content) onEvent?.({ type: 'content', delta: content, text: content });
      }
    }

    if (!choice || typeof choice !== 'object') {
      const err = new Error('Model endpoint returned no message choice');
      err.code = 'EPROTO';
      throw err;
    }

    const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    const content = asText(choice.content);
    const stepThinking = thinkingFromMessage(choice);
    if (stepThinking && !allThinking.includes(stepThinking)) {
      allThinking += (allThinking ? '\n' : '') + stepThinking;
    }

    if (!toolCalls.length) {
      finalText = (content || '').trim();
      // Thinking-only replies: keep text empty so the UI shows the thinking pane
      // instead of the misleading "(empty response)" placeholder.
      if (!finalText && !allThinking.trim() && !stepThinking) {
        finalText = '(empty response)';
      }
      transcript.push({ role: 'assistant', content: finalText || content || '' });
      break;
    }

    transcript.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls,
      ...(stepThinking ? { reasoning_content: stepThinking } : {}),
    });

    for (const call of toolCalls) {
      if (signal?.aborted) {
        const err = new Error('aborted');
        err.code = 'ABORT';
        throw err;
      }
      const name = call?.function?.name || call?.name || '';
      const callId = call.id || `tool_${toolTrace.length + 1}`;
      let args = {};
      const argText = call?.function?.arguments ?? call?.arguments ?? '{}';
      try {
        args = typeof argText === 'string' ? JSON.parse(argText || '{}') : (argText || {});
      } catch {
        args = { _raw: argText };
      }

      onEvent?.({ type: 'tool_start', id: callId, name, args });
      hooks?.preToolUse?.({ name, args, callId });

      let result;
      try {
        result = await tools.call(name, args, callId);
      } catch (err) {
        // Approval-gate Stop (and any other ABORT) must end the turn, not look
        // like a tool failure the model can retry.
        if (err?.code === 'ABORT' || signal?.aborted) {
          const abortErr = err?.code === 'ABORT' ? err : new Error('aborted');
          abortErr.code = 'ABORT';
          throw abortErr;
        }
        throw err;
      }
      const ok = result?.ok !== false;
      const summary = ok
        ? `${name} ok`
        : `${name} failed: ${result?.error || 'error'}`;
      toolTrace.push({ id: callId, name, ok, summary, args, result });
      if (ok) {
        hooks?.postToolUse?.({ name, args, callId, result });
      } else {
        hooks?.postToolUseFailure?.({
          name,
          args,
          callId,
          error: result?.error || summary,
        });
      }
      onEvent?.({
        type: 'tool_result',
        id: callId,
        name,
        ok,
        summary,
        args,
        result,
      });
      transcript.push({
        role: 'tool',
        tool_call_id: callId,
        name,
        content: JSON.stringify(result),
      });
    }
  }

  if (!finalText) {
    if (steps >= maxSteps) {
      finalText = `Stopped after ${maxSteps} tool steps without a final reply.`;
    } else if (allThinking.trim() || steeredText) {
      // Keep text empty so the UI shows the thinking pane (and the steering
      // note) instead of the misleading "(empty response)" placeholder.
      finalText = '';
    } else if (toolTrace.length) {
      finalText = 'Finished tool calls but the model returned no visible reply.';
    } else {
      finalText = '(empty response)';
    }
  }

  const result = {
    backend: 'openai-compatible',
    text: finalText,
    thinking: allThinking,
    toolTrace,
    steps,
    model,
    baseUrl,
    mode: agentMode,
  };
  onEvent?.({ type: 'done', ...result });
  return result;
}
