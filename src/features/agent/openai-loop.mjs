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
} from '#features/trail/agent/trail.mjs';
import { agentModeLabel, agentModeSystemPromptAddon, normalizeAgentMode } from './modes.mjs';
import { taskSystemPromptAddon } from './tasks.mjs';
import { planSystemPromptAddon } from './plans.mjs';
import { assignSystemPromptAddon } from './assign.mjs';
import {
  escalateSystemPromptAddon,
  isOrchestratedSessionKey,
} from './escalate.mjs';
import { sessionNameSystemPromptAddon } from './session-name.mjs';
import { supportsVision } from './model-capabilities.mjs';
import {
  formatBytes,
  normalizeAttachments,
  splitAttachments,
} from '#features/chat/data/attachments.mjs';

export const DEFAULT_MAX_STEPS = 100;
const MAX_MAX_STEPS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Undici's TypeError("fetch failed") hides the useful `cause` (ECONNREFUSED,
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, …). Surface that so the Model error card
 * is actionable instead of a bare "fetch failed".
 * @param {unknown} err
 * @param {string} [url]
 */
export function formatModelFetchError(err, url = '') {
  const top = err && typeof err === 'object' ? err : null;
  const cause = top && 'cause' in top ? top.cause : null;
  const causeObj = cause && typeof cause === 'object' ? cause : null;
  const code = String(
    (causeObj && 'code' in causeObj && causeObj.code)
    || (top && 'code' in top && top.code)
    || '',
  ).trim();
  const causeMsg = String(
    (causeObj && 'message' in causeObj && causeObj.message)
    || (typeof cause === 'string' ? cause : '')
    || '',
  ).trim();
  const topMsg = String(top && 'message' in top ? top.message : err || '').trim()
    || 'fetch failed';
  const host = (() => {
    try {
      return url ? new URL(url).host : '';
    } catch {
      return '';
    }
  })();

  if (code === 'ABORT' || top?.name === 'AbortError' || /aborted/i.test(topMsg)) {
    const abort = new Error('Model request timed out or was aborted');
    abort.code = 'ABORT';
    return abort;
  }

  const tls = /UNABLE_TO_VERIFY|CERT_|TLS|SSL|self[- ]signed|unable to get local issuer/i
    .test(`${code} ${causeMsg} ${topMsg}`);
  let message;
  if (tls) {
    message = `TLS to model endpoint failed${host ? ` (${host})` : ''}: ${
      code || causeMsg || topMsg
    }. Fix the certificate chain (or NODE_EXTRA_CA_CERTS) for this host.`;
  } else if (code || causeMsg) {
    message = `Could not reach model endpoint${host ? ` (${host})` : ''}: ${
      [code, causeMsg || (topMsg !== 'fetch failed' ? topMsg : '')].filter(Boolean).join(' — ')
    }`;
  } else {
    message = topMsg;
  }
  const out = new Error(message);
  out.code = tls ? 'ETLS' : (code || 'EFETCH');
  out.cause = cause || err;
  return out;
}

/** Auth headers for one endpoint's class + key (Default or extra — same rule). */
function endpointHeaders(authMode, apiKey) {
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (authMode === 'apikey' && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * The OpenAI-compatible endpoint a request should talk to.
 *
 * The Default endpoint keeps living in the agentBaseUrl / agentAuthMode /
 * agentApiKey fields, so a settings file written before extra endpoints existed
 * still resolves to exactly one working endpoint. A model that one of the EXTRA
 * endpoints declares resolves to THAT endpoint instead — its own base URL and its
 * own key — which is why the loop, the OpenCode config and the instance key all
 * call this one function rather than reading the fields themselves. The caller
 * puts the chosen model in settings.agentModel (runKusaAgent scopes it there),
 * so nothing downstream has to know about endpoints.
 * @param {object} settings
 * @returns {{ baseUrl: string, model: string, headers: Record<string, string>, authMode: string, apiKey: string }}
 */
/** The endpoint the top-level agent* fields describe — the Default one, always present. */
function defaultAgentEndpoint(settings = {}) {
  const authMode = (settings.agentAuthMode === 'apikey' || settings.agentAuthMode === 'bearer')
    ? 'apikey'
    : 'none';
  const apiKey = String(settings.agentApiKey ?? settings.agentAuthToken ?? '').trim();
  return {
    baseUrl: String(settings.agentBaseUrl || '').trim().replace(/\/+$/, ''),
    model: String(settings.agentModel || '').trim() || 'gpt-4o-mini',
    headers: endpointHeaders(authMode, apiKey),
    authMode,
    apiKey,
  };
}

/**
 * Whether a declared model id matches the requested pick. Google AI Studio's
 * OpenAI-compatible `/models` lists ids as `models/<name>`, so a typed
 * `gemini-flash-latest` and a probed `models/gemini-flash-latest` are the same
 * pick for routing.
 * @param {string} declared
 * @param {string} requested
 */
function modelIdMatches(declared, requested) {
  const a = String(declared || '').trim();
  const b = String(requested || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = (id) => id.replace(/^models\//, '');
  return strip(a) === strip(b);
}

/**
 * Build the resolved endpoint shape from one `agentEndpoints[]` entry.
 * @param {object} entry
 * @param {string} model
 */
function endpointFromExtra(entry, model) {
  const authMode = (entry.authMode === 'apikey' || entry.authMode === 'bearer') ? 'apikey' : 'none';
  const apiKey = String(entry.apiKey ?? '').trim();
  return {
    baseUrl: String(entry.baseUrl || '').trim().replace(/\/+$/, ''),
    model,
    headers: endpointHeaders(authMode, apiKey),
    authMode,
    apiKey,
  };
}

export function resolveAgentEndpoint(settings = {}) {
  const requested = String(settings.agentModel || '').trim();
  const requestedEndpointId = String(settings.agentEndpointId || '').trim();
  const extras = Array.isArray(settings.agentEndpoints) ? settings.agentEndpoints : [];
  // Composer pick under an extra endpoint's heading owns that endpoint — the
  // picker sends its id so a probed-only model (never typed into Models) still
  // uses that base URL and key instead of falling through to Default.
  if (requestedEndpointId) {
    const byId = extras.find((entry) => (
      entry
      && typeof entry === 'object'
      && String(entry.id || '').trim() === requestedEndpointId
      && String(entry.baseUrl || '').trim()
    ));
    if (byId) {
      return endpointFromExtra(byId, requested || defaultAgentEndpoint(settings).model);
    }
  }
  // Declared ids own their endpoint: an id two endpoints both offer belongs to
  // the one the user configured by name, and the model picker applies the same
  // rule when it lists it under that endpoint's heading.
  const match = extras.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return Array.isArray(entry.models)
      && entry.models.some((id) => modelIdMatches(id, requested));
  });
  if (match) return endpointFromExtra(match, requested);
  return defaultAgentEndpoint(settings);
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
/** Heading for the endpoint the top-level agent* fields describe. */
export const DEFAULT_ENDPOINT_LABEL = 'Default';

/**
 * Model ids one endpoint advertises over `GET /models` — its own headers, so an
 * extra endpoint is probed with its own credentials. Empty when it does not
 * answer: a dead or offline endpoint is not an error here, the picker simply has
 * nothing to offer from it.
 * @param {string} baseUrl
 * @param {object} [headers]
 * @returns {Array<string>}
 */
async function probeEndpointModels(baseUrl, headers = {}) {
  if (!baseUrl) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { ...headers, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      return [];
    }
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
    return list
      .map((entry) => (typeof entry === 'string' ? entry : String(entry?.id ?? entry?.model ?? '')).trim())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Declared model ids, trimmed and de-duplicated — the comma-delimited field's final form. */
function declaredModelList(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[,;\n]/) : []);
  const ids = list.map((value) => String(value ?? '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

/**
 * Models EVERY configured (active) endpoint has, as one group per endpoint — the
 * composer's Model picker draws those headings, so a pick states which base URL
 * and which key it would use. Every endpoint with a base URL is active: its group
 * merges what it declares (comma-delimited) with what its own `GET /models`
 * advertises. The Default endpoint (the agentBaseUrl fields) is listed first.
 * An id an extra endpoint declared belongs to that endpoint alone, which is the
 * rule resolveAgentEndpoint applies when the pick is sent — probed-only ids do
 * not steal ownership across endpoints.
 * @param {object} settings
 * @returns {{ default: string, groups: Array<{ name: string, models: Array<string> }> }}
 */
export async function listAgentModelGroups(settings = {}) {
  const extras = (Array.isArray(settings.agentEndpoints) ? settings.agentEndpoints : [])
    .filter((entry) => entry && typeof entry === 'object' && String(entry.baseUrl || '').trim())
    .map((entry, index) => {
      const authMode = (entry.authMode === 'apikey' || entry.authMode === 'bearer') ? 'apikey' : 'none';
      const apiKey = String(entry.apiKey ?? '').trim();
      const declared = declaredModelList(entry.models);
      return {
        id: String(entry.id || '').trim(),
        name: String(entry.name ?? '').trim() || `Endpoint ${index + 1}`,
        baseUrl: String(entry.baseUrl).trim().replace(/\/+$/, ''),
        headers: endpointHeaders(authMode, apiKey),
        declared,
      };
    });
  /** @type {Array<{ name: string, endpointId: string, models: Array<string> }>} */
  const groups = [];
  // Only a DECLARED id claims ownership of it when the composer sends no
  // endpointId. A list an endpoint merely advertises does not steal a bare id
  // from Default — two servers that both happen to offer gpt-4o-mini would
  // otherwise resolve to credentials the heading does not show. The picker's
  // endpointId (group.endpointId) is what makes a probed-only pick under an
  // extra heading use that endpoint.
  const declaredByExtras = new Set(extras.flatMap((entry) => entry.declared));
  const current = defaultAgentEndpoint(settings);
  const probedDefault = await probeEndpointModels(current.baseUrl, current.headers);
  const declaredDefault = declaredModelList(settings.agentModels);
  // The configured model leads so the picker's default is obvious.
  const merged = [...new Set([current.model, ...declaredDefault, ...probedDefault])]
    .filter((id) => id && !declaredByExtras.has(id));
  const offered = new Set(merged);
  for (const entry of extras) {
    const probed = await probeEndpointModels(entry.baseUrl, entry.headers);
    const ids = [...new Set([...entry.declared, ...probed])]
      .filter((id) => id && !offered.has(id));
    if (!ids.length) continue;
    ids.forEach((id) => offered.add(id));
    groups.push({ name: entry.name, endpointId: entry.id, models: ids });
  }
  return {
    default: resolveAgentEndpoint(settings).model,
    groups: [
      ...(merged.length ? [{ name: DEFAULT_ENDPOINT_LABEL, endpointId: '', models: merged }] : []),
      ...groups,
    ],
  };
}

/**
 * Flat union of every endpoint's models — the shape a single-endpoint caller
 * already expects. The picker wants listAgentModelGroups; this stays for callers
 * that only need the ids (a single endpoint produces exactly the old list).
 * @param {object} settings
 * @returns {{ default: string, models: Array<string> }}
 */
export async function listAgentModels(settings = {}) {
  const { default: defaultModel, groups } = await listAgentModelGroups(settings);
  const models = [];
  for (const group of groups) {
    for (const id of group.models) {
      if (!models.includes(id)) models.push(id);
    }
  }
  return { default: defaultModel, models };
}

/**
 * Attachments as the model actually sees them.
 *
 * A text file is inlined — every model can read it. An image is sent as an
 * image_url part only when the model is known to see images; a text-only model
 * gets a named note instead, so the prompt still says what the user attached
 * rather than quietly losing half of it. An unknown model is left to answer for
 * itself: dropping the picture behind the user's back would be a guess about a
 * capability nobody checked.
 *
 * @param {Array<object>} attachments
 * @param {string} model
 * @returns {{ text: string, images: Array<object>, dropped: Array<object> }}
 */
export function attachmentPayload(attachments, model) {
  const list = normalizeAttachments(attachments);
  if (!list.length) return { text: '', images: [], dropped: [] };
  const { images, readable, named } = splitAttachments(list);
  const blocks = [];
  for (const file of readable) {
    blocks.push(
      `Attached file "${file.name}" (${formatBytes(file.size || file.text.length)}):\n` +
        '"""\n' + `${file.text}\n` + '"""',
    );
  }
  for (const file of named) {
    blocks.push(
      `Attached file "${file.name}" (${formatBytes(file.size)}) — ` +
        (file.note || 'contents not included; read it with the file tools if it is in the workspace.'),
    );
  }
  const seesImages = supportsVision(model) !== false;
  if (!seesImages) {
    for (const file of images) {
      blocks.push(
        `Attached image "${file.name}" (${formatBytes(file.size)}) — this model is text-only, so the picture was not sent.`,
      );
    }
  }
  return {
    text: blocks.join('\n\n'),
    images: seesImages ? images : [],
    dropped: seesImages ? [] : images,
  };
}

/**
 * Compose one user turn: the typed prompt, the readable half of its files, and
 * the images as parts. Returns a plain string when nothing needs parts, so a
 * text-only request keeps exactly the shape the endpoint has always taken.
 * @param {string} text
 * @param {Array<object>} attachments
 * @param {string} model
 * @returns {{ content: string | Array<object>, files: number, images: number, dropped: Array<object> }}
 */
export function composeUserTurn(text, attachments, model) {
  const list = normalizeAttachments(attachments);
  if (!list.length) {
    return { content: String(text ?? ''), files: 0, images: 0, dropped: [] };
  }
  const payload = attachmentPayload(list, model);
  const body = [String(text || '').trim(), payload.text].filter(Boolean).join('\n\n');
  if (!payload.images.length) {
    return { content: body, files: list.length, images: 0, dropped: payload.dropped };
  }
  const parts = [];
  if (body) parts.push({ type: 'text', text: body });
  for (const image of payload.images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } });
  }
  return { content: parts, files: list.length, images: payload.images.length, dropped: payload.dropped };
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
 * @param {{ onEvent?: (ev: object) => void, signal?: AbortSignal,
 *           onSteerPoll?: () => boolean }} opts
 *   [opts.onSteerPoll] asked before every chunk. A `true` return means the user
 *   just pushed a "send now" prompt (Codex/OpenCode steer): reading stops so the
 *   prompt can reach the model right away. The half-finished reply comes back in
 *   `message` with `interrupted: true` — the caller must keep that partial
 *   (text + thinking) as transcript context, inject the prompt, and re-issue;
 *   it is NOT the turn's final answer.
 */
async function consumeChatCompletionStream(response, { onEvent, signal, onSteerPoll = null } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};
    return {
      message: data?.choices?.[0]?.message || null,
      finishReason: data?.choices?.[0]?.finish_reason || null,
      errorBody: data,
      interrupted: false,
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
  let interrupted = false;

  while (true) {
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
      const err = new Error('aborted');
      err.code = 'ABORT';
      throw err;
    }
    // "Send now" mid-answer: stop reading this completion so the caller can
    // inject the prompt and re-issue the call straight away.
    if (await onSteerPoll?.()) {
      interrupted = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
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
  // A cancelled completion leaves half-written tool arguments; the caller
  // re-issues the call, so those partial tool calls are not usable context.
  if (!interrupted && orderedTools.length) message.tool_calls = orderedTools;

  return { message, finishReason, errorBody: null, interrupted };
}

/**
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {object} options.settings
 * @param {Array<{ role: string, content?: string, text?: string, attachments?: Array<object> }>} options.messages
 *   a `user` entry may carry `attachments` — they are inlined as text and, when
 *   the model sees images, sent as image parts (see userMessageContent)
 * @param {number} [options.maxSteps]
 * @param {AbortSignal} [options.signal]
 * @param {(ev: object) => void} [options.onEvent]
 * @param {boolean} [options.stream]
 * @param {object} [options.hooks] Kusă monitor hook emitter (pre/post tool)
 * @param {string} [options.approvalMode] overrides settings.agentApprovalMode for this run ('ask-deny' | 'ask-allow' | 'allow' | 'deny')
 * @param {(request) => boolean | { allowed }} [options.onApprove] user decision for the ONE gated call being asked — it is not remembered, and it never moves the Rule
 * @param {string} [options.mode] 'ask' | 'plan' | 'agent'
 * @param {string} [options.modelOverride] composer model picker
 * @param {() => Promise<string[]> | string[]} [options.onSteer] mid-turn "send now" prompts,
 *   polled per streamed chunk so the prompt interrupts the running model call
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
  onAssignTurn = null,
  onEscalateTurn = null,
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
    onAssignTurn,
    onEscalateTurn,
  });
  const orchestrated = isOrchestratedSessionKey(hooks?.dataDir || '', hooks?.sessionKey || '');
  let toolSchemas = openaiToolSchemasWithTrail(agentMode, { orchestrated });
  const buildSystemPrompt = (modeNow, approvalNow) => {
    const promptAddons = [
      agentModeSystemPromptAddon(modeNow),
      taskSystemPromptAddon(),
      planSystemPromptAddon(),
      assignSystemPromptAddon({
        dataDir: hooks?.dataDir || '',
        sessionKey: hooks?.sessionKey || '',
      }),
      escalateSystemPromptAddon({
        dataDir: hooks?.dataDir || '',
        sessionKey: hooks?.sessionKey || '',
      }),
      sessionNameSystemPromptAddon(),
      askSystemPromptAddon(),
      trailSystemPromptAddon(trailPolicy),
      approvalSystemPromptAddon(approvalNow, approvalTimeoutMs),
    ].filter((addon) => typeof addon === 'string' && addon.trim());
    return agentSystemPrompt(promptAddons.join(' '));
  };
  let systemPrompt = buildSystemPrompt(agentMode, approvalModeResolved);
  /** @type {Array<{ role: string, content?: string | null, tool_calls?: unknown[], tool_call_id?: string, name?: string, reasoning_content?: string }>} */
  const transcript = [];
  let attachedFiles = 0;
  let attachedImages = 0;
  let droppedImages = 0;
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const turn = composeUserTurn(String(message.content ?? message.text ?? ''), message.attachments, model);
    attachedFiles += turn.files;
    attachedImages += turn.images;
    droppedImages += turn.dropped.length;
    transcript.push({ role, content: turn.content });
  }

  /** @type {{ id: string, name: string, ok: boolean, summary: string, args?: object, result?: unknown }[]} */
  const toolTrace = [];
  let steps = 0;
  let finalText = '';
  let allThinking = '';
  // Messages the user pushed while this turn was already running (Composer
  // "queue" → "send now"). Codex/OpenCode steer semantics:
  //   • soft-cancel the in-flight completion (not the turn AbortSignal)
  //   • keep partial assistant text + thinking as model context
  //   • let a tool already running finish; skip tools not yet started
  //   • inject the prompt before the next model call
  // onSteer is the queue owner's handle; collectSteer() pulls into pendingSteer
  // and flushSteer() empties that into the transcript once, so a steering
  // message is never re-sent as a duplicate turn later.
  let steeredText = '';
  /** @type {string[]} */
  const pendingSteer = [];

  // Ask the queue owner for anything new. Returns true when something arrived,
  // which is how the stream consumer knows it must stop reading.
  const collectSteer = async () => {
    const texts = typeof onSteer === 'function' ? await onSteer() : [];
    let found = false;
    for (const entry of (texts || [])) {
      const text = String(typeof entry === 'string' ? entry : (entry?.text ?? '')).trim();
      if (!text) continue;
      pendingSteer.push(text);
      found = true;
    }
    return found;
  };
  // Move anything collected into the transcript before the next model call.
  const flushSteer = () => {
    for (const text of pendingSteer.splice(0, pendingSteer.length)) {
      transcript.push({ role: 'user', content: text });
      steeredText = steeredText ? `${steeredText}\n\n${text}` : text;
      onEvent?.({ type: 'steer', text });
    }
  };

  /** Keep a soft-interrupted completion as model context, then re-issue. */
  const retainInterruptedPartial = (choice) => {
    const partial = asText(choice?.content);
    const partialThinking = typeof choice?.reasoning_content === 'string'
      ? choice.reasoning_content.trim()
      : '';
    if (partial || partialThinking) {
      transcript.push({
        role: 'assistant',
        content: partial || null,
        ...(partialThinking ? { reasoning_content: partialThinking } : {}),
      });
    }
    // UI freezes the live bubble before the steered user row; the next stream
    // starts a fresh live.text without wiping what the model already said.
    onEvent?.({
      type: 'interrupted',
      text: partial || '',
      thinking: partialThinking || '',
    });
  };

  /**
   * Codex: skip tool calls the model had not yet started. Emit cancelled
   * results so the transcript stays well-formed (every tool_call has a result).
   */
  const skipRemainingTools = (calls, fromIndex) => {
    for (let i = fromIndex; i < calls.length; i += 1) {
      const call = calls[i];
      const name = call?.function?.name || call?.name || '';
      const callId = call.id || `tool_${toolTrace.length + 1}`;
      let args = {};
      const argText = call?.function?.arguments ?? call?.arguments ?? '{}';
      try {
        args = typeof argText === 'string' ? JSON.parse(argText || '{}') : (argText || {});
      } catch {
        args = { _raw: argText };
      }
      const result = {
        ok: false,
        error: 'Skipped — steered by user before this tool started',
        interrupted: true,
      };
      const summary = `${name} skipped (steered)`;
      toolTrace.push({ id: callId, name, ok: false, summary, args, result });
      onEvent?.({
        type: 'tool_result',
        id: callId,
        name,
        ok: false,
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
  };

  onEvent?.({
    type: 'status',
    status: 'started',
    model,
    baseUrl,
    mode: agentMode,
    modeLabel: agentModeLabel(agentMode),
    approvalMode: approvalModeResolved,
    // What the composer's files became for this model, so the transcript can
    // say which pictures actually reached it.
    attachments: { files: attachedFiles, images: attachedImages, droppedImages },
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
    toolSchemas = openaiToolSchemasWithTrail(agentMode, { orchestrated });
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
    await applyLiveOptions();
    await collectSteer();
    flushSteer();

    const url = `${baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    let response;
    try {
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
      } catch (err) {
        throw formatModelFetchError(err, url);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let detail = raw.slice(0, 800) || response.statusText;
      try {
        const data = raw ? JSON.parse(raw) : {};
        // Google AI Studio (and some proxies) answer as `[{ error: { message } }]`
        // rather than OpenAI's `{ error: { message } }`.
        const entry = Array.isArray(data) ? data[0] : data;
        detail = entry?.error?.message || entry?.message || detail;
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
      const consumed = await consumeChatCompletionStream(response, {
        onEvent,
        signal,
        // "Send now" while the model is still answering: the poll returns true
        // the moment the queue owner hands us a prompt, so reading stops here and
        // the prompt is injected + the call re-issued on the next iteration.
        onSteerPoll: collectSteer,
      });
      choice = consumed.message;
      if (typeof choice?.reasoning_content === 'string' && choice.reasoning_content) {
        allThinking += (allThinking ? '\n' : '') + choice.reasoning_content;
      }
      if (consumed.interrupted) {
        // Soft interrupt (not Stop): keep text + thinking as context, refund
        // the aborted call, inject the steer on the next iteration, re-issue.
        retainInterruptedPartial(choice);
        steps -= 1;
        continue;
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

    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
      const call = toolCalls[toolIndex];
      if (signal?.aborted) {
        const err = new Error('aborted');
        err.code = 'ABORT';
        throw err;
      }
      // Steer arrived while earlier tools in this step were running: finish is
      // already done for those; skip anything not yet started (Codex), then
      // inject the prompt before the next model call.
      if (pendingSteer.length) {
        skipRemainingTools(toolCalls, toolIndex);
        break;
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

      // Re-read the composer pickers before EVERY tool call, not only at the step
      // boundary above. A model step can emit several gated calls at once; a Rule
      // picked while they are running must reach the NEXT one, so switching to
      // Allow cannot leave the rest of this step asking under the old rule.
      await applyLiveOptions();
      // Drain steers that landed before this tool starts — same skip path as
      // above, so "send now" during a long prior tool does not wait for the
      // whole remaining batch.
      if (await collectSteer()) {
        skipRemainingTools(toolCalls, toolIndex);
        break;
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

      // After each finished tool: poll again. In-flight work is done; remaining
      // calls in this step are skipped so the steer reaches the next model call.
      if (await collectSteer()) {
        skipRemainingTools(toolCalls, toolIndex + 1);
        break;
      }
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
