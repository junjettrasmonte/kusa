/**
 * Pure text/data helpers for the chat surface — no DOM, no React.
 *
 * Message parts are grouped here (a run of thinking, a batch of tool calls, the
 * reply) because that grouping is data, not presentation: the UI components
 * decide how a group is drawn. The preview helpers live here once so a clipped
 * line reads the same in the queue, the task list, and the transcript.
 */
export function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function stringify(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeArgs(args) {
  if (args == null) return null;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : { value: trimmed };
    } catch {
      return { value: trimmed };
    }
  }
  if (typeof args === 'object') return args;
  return { value: String(args) };
}

export function previewLine(text, max = 120) {
  const line = String(text || '').trim().split(/\n/).find((l) => l.trim()) || '';
  return truncate(line, max);
}

export function toolDetail(tool) {
  const args = normalizeArgs(tool.args);
  if (!args) {
    if (typeof tool.summary === 'string' && tool.summary) return truncate(tool.summary, 72);
    return '';
  }
  for (const key of [
    'path', 'file_path', 'filePath', 'target', 'command', 'cmd',
    'query', 'pattern', 'url', 'uri', 'name', 'id',
  ]) {
    if (args[key] != null && String(args[key]).trim()) {
      return truncate(String(args[key]).trim(), 72);
    }
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 72);
  }
  return '';
}

/** Interleaved timeline; fall back to legacy thinking-then-tools shape. */
export function assistantParts(msg) {
  if (Array.isArray(msg.parts) && msg.parts.length) return msg.parts;
  const parts = [];
  if (typeof msg.thinking === 'string' && msg.thinking.trim()) {
    parts.push({ type: 'thinking', text: msg.thinking });
  }
  for (const tool of Array.isArray(msg.tools) ? msg.tools : []) {
    parts.push({ type: 'tool', tool });
  }
  return parts;
}

/** Collapse consecutive tool parts into tool_group entries for the timeline. */
export function groupAssistantParts(parts) {
  /** @type {Array<{ type: 'thinking', text: string, lastInParts: boolean } | { type: 'tool_group', tools: object[] } | { type: 'approval', approval: object } | { type: 'ask', ask: object }>} */
  const groups = [];
  const list = Array.isArray(parts) ? parts : [];
  for (let i = 0; i < list.length; i++) {
    const part = list[i];
    if (part?.type === 'thinking') {
      groups.push({
        type: 'thinking',
        text: part.text || '',
        lastInParts: i === list.length - 1,
      });
      continue;
    }
    if (part?.type === 'approval' && part.approval) {
      groups.push({ type: 'approval', approval: part.approval });
      continue;
    }
    if (part?.type === 'ask' && part.ask) {
      groups.push({ type: 'ask', ask: part.ask });
      continue;
    }
    if (part?.type === 'tool' && part.tool) {
      const tools = [part.tool];
      while (i + 1 < list.length && list[i + 1]?.type === 'tool' && list[i + 1].tool) {
        i += 1;
        tools.push(list[i].tool);
      }
      groups.push({ type: 'tool_group', tools });
    }
  }
  return groups;
}

/**
 * Resolve what the user actually said back to an ask: the server records either
 * the chosen option index or the typed text, so the reply shows the words the
 * user used rather than a re-derived guess.
 */
export function answeredAskText(ask) {
  const answer = ask?.answer;
  const selected = Number(answer?.selected);
  if (selected >= 0) {
    const options = Array.isArray(ask?.options) ? ask.options : [];
    const option = options.find((o) => Number(o?.index) === selected);
    if (option?.label) return String(option.label);
  }
  return String(answer?.freeText ?? '');
}

/**
 * Whether an assistant row is a failed turn (model/endpoint error), not a
 * normal reply. Legacy rows stored the failure as `Agent error: …` text before
 * the `error` flag existed.
 * @param {object | null | undefined} msg
 */
export function isAgentErrorMessage(msg) {
  if (!msg || msg.role !== 'assistant') return false;
  if (msg.error === true) return true;
  return /^Agent error:\s*/i.test(String(msg.text || ''));
}

/**
 * Drop leaked XML tool-protocol dumps models sometimes paste into the reply
 * body (`<tool_call>…</tool_call>` with HTML/file payloads inside). Those
 * blocks break ReactMarkdown (raw HTML flow nodes vanish / wreck the tree);
 * the real tool call already lives in `parts` as a ToolCallRow.
 *
 * Unclosed tags (mid-stream) are stripped from the open tag through EOF so
 * partial HTML never reaches the renderer.
 * @param {string} text
 */
export function stripLeakedToolCalls(text) {
  let s = String(text || '');
  if (!s.includes('<tool_call') && !s.includes('</tool_call')) return s;
  // Closed blocks (non-greedy; nested HTML inside is fine).
  s = s.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi, '');
  // Streaming / truncated: open tag with no closer yet.
  s = s.replace(/<tool_call\b[^>]*>[\s\S]*$/gi, '');
  s = s.replace(/<\/tool_call\s*>/gi, '');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Models often glue a fenced block to the previous sentence
 * (`…as-is.```\n…`) — CommonMark only opens a fence at line start, so the
 * backticks leak as literal text and the closing fence swallows the rest.
 * Split those onto their own line. Leaves real line-start fences alone, and
 * ignores inline ```code``` (no trailing newline/EOF after the opener).
 * @param {string} text
 */
export function breakGluedCodeFences(text) {
  return String(text || '').replace(
    /([^\s`])(```+)([a-zA-Z0-9_-]*)(\r?\n|$)/g,
    '$1\n$2$3$4',
  );
}

/**
 * Prep assistant reply text for chat markdown render / speech.
 * @param {string} text
 */
export function normalizeChatMarkdown(text) {
  return breakGluedCodeFences(stripLeakedToolCalls(text));
}

/**
 * Light markdown → spoken prose for Live Chat TTS (final assistant text only).
 * @param {string} text
 * @param {number} [max=4000]
 */
export function stripMarkdownForSpeech(text, max = 4000) {
  const cleaned = normalizeChatMarkdown(String(text || ''))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

/** Cursor CAO turns that failed because workspace trust was never granted. */
const CURSOR_TRUST_RE =
  /Workspace Trust Required|Do you trust the contents of this directory|trust this workspace|ECAO_TRUST|workspace trust is usually blocking/i;

const CURSOR_TLS_RE =
  /unable to get local issuer certificate|ECURSOR_TLS|HTTP_PROXY MITM/i;

/**
 * @param {object | string | null | undefined} msgOrText
 */
export function isCursorTrustError(msgOrText) {
  if (msgOrText == null) return false;
  if (typeof msgOrText === 'object') {
    if (msgOrText.code === 'ECAO_TRUST') return true;
    const blob = [
      msgOrText.code,
      msgOrText.errorMessage,
      msgOrText.message,
      msgOrText.text,
    ].filter(Boolean).join('\n');
    return CURSOR_TRUST_RE.test(blob);
  }
  return CURSOR_TRUST_RE.test(String(msgOrText));
}

/**
 * Human-readable body for an agent/model failure. Strips the legacy
 * `Agent error:` prefix and unwraps `Model endpoint HTTP N: <json>` payloads
 * (including Google's `[{ error: { message } }]` shape) down to the message.
 * @param {object | string | null | undefined} msgOrText
 */
export function agentErrorDisplayText(msgOrText) {
  let raw = typeof msgOrText === 'string'
    ? msgOrText
    : String(msgOrText?.text || '');
  raw = raw.replace(/^Agent error:\s*/i, '').trim();
  const httpMatch = raw.match(/^Model endpoint HTTP (\d+):\s*([\s\S]*)$/i);
  if (httpMatch) {
    let detail = httpMatch[2].trim();
    try {
      const data = JSON.parse(detail);
      const entry = Array.isArray(data) ? data[0] : data;
      detail = String(entry?.error?.message || entry?.message || detail).trim();
    } catch { /* keep detail */ }
    return detail || `Model endpoint HTTP ${httpMatch[1]}`;
  }
  if (CURSOR_TLS_RE.test(raw) || (typeof msgOrText === 'object' && msgOrText?.code === 'ECURSOR_TLS')) {
    return raw.includes('HTTP_PROXY')
      ? raw
      : `${raw}\n\nCursor Agent could not verify TLS (often HTTP_PROXY). Retry — kusa now strips proxy for Cursor/Copilot spawns.`;
  }
  return raw || 'Something went wrong talking to the model.';
}

/**
 * Rough context-window estimate for the composer meter (~4 chars per token).
 * The endpoint reports no usage, so this is an estimate of what a turn would
 * send: the transcript plus whatever is streaming now.
 */
export function estimateContextTokens(messages, live) {
  let chars = 0;
  for (const msg of messages) {
    chars += String(msg?.text || msg?.content || '').length;
  }
  chars += String(live?.text || '').length + String(live?.thinking || '').length;
  for (const part of live?.parts || []) {
    chars += String(part?.text || '').length;
    chars += JSON.stringify(part?.args || {}).length;
  }
  return Math.round(chars / 4);
}
