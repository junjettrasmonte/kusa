/**
 * Session naming for the Kusă agent — what the sidebar row is called.
 *
 * A session with no name is labelled by its first user prompt (see chat-store
 * `deriveSessionTitle`): good enough to find a chat again, terrible as a title
 * for a rambling first prompt ("ok so basically the parser is slow because…").
 * The model knows what the chat is actually about once it has read the request,
 * so `kusa_name_session` lets it write that as the row's name.
 *
 * The name is NOT turn data, so it does not live in the transcript — chat-store
 * keeps it in the session's settings sidecar (`session.json` → `name`) and
 * `normalizeChatSession` prefers it over a derived title. Turn writers rebuild
 * chat.json on every step and know nothing about names, so anything written
 * inside the transcript would be reset by the next turn write; the sidecar is
 * never touched by those writes.
 *
 * A write is self-announcing, like the task tools: after the sidecar is
 * updated the monitor is re-rendered in the same call, so the sidebar row
 * changes on the UI's next poll (one second) instead of waiting for a page
 * refresh. Renaming is not an error — the previous name is reported, so a
 * retried call never fails the turn.
 *
 * The first prompt is also titled without waiting for the model to decide:
 * `requestSessionName` is one small non-streaming call the console fires while a
 * session's first turn starts, so a brand-new chat gets a real name the moment
 * it exists. It is best-effort — no endpoint, no answer, or an unparseable one
 * all just leave the first-prompt title in place.
 */
import { nameChatSession } from '#features/chat/data/chat-store.mjs';
import { refreshMonitorArtifacts } from '#features/monitor/lib.mjs';
import { resolveAgentEndpoint } from './openai-loop.mjs';

/** Hard cap on a name the model writes. chat-store clamps again (same value). */
const MAX_NAME_CHARS = 72;
/** One short titling call must never hold a turn open — it is best-effort. */
const TITLE_REQUEST_TIMEOUT_MS = 8_000;

export const SESSION_NAME_TOOL_DEFS = [
  {
    name: 'kusa_name_session',
    description:
      'Name (or rename) this session — the one short line the sidebar row shows. '
      + 'Call it ONCE, before any other tool, at the start of a session that has no name yet; '
      + 'name what the chat is trying to do, not the greeting: "Fix the CSV parser in src/io" '
      + 'is a name, "Question about parser" is not. Write one plain line, no quotes, no code, '
      + 'no trailing punctuation, at most 72 characters. '
      + 'Call it again only when the session drifts to a genuinely different task — that renames '
      + 'the row, it never touches the transcript. Passing an empty name clears the authored name '
      + 'and lets the first prompt title the row again. Renaming is not an error: the previous '
      + 'name is reported back.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: `One-line session name, max ${MAX_NAME_CHARS} characters ('' clears it)`,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

/**
 * @param {object} options
 * @param {string} [options.dataDir] monitor data dir (`.kusa/`) — enables persistence
 * @param {string} [options.sessionKey] lane key (`kusa:<sessionId>`) for this turn
 */
export function createSessionNameTools({ dataDir = '', sessionKey = '' } = {}) {
  const dir = String(dataDir || '').trim();
  const key = String(sessionKey || '').trim();
  const persistable = Boolean(dir && key);
  // Adapter-owned sessions (Cursor CLI, Copilot, CAO…) carry THAT agent's title —
  // Kusă renaming them would fight the IDE on the next refresh, so the row stays
  // owned by whoever created it.
  const harness = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'kusa';
  const foreignSession = persistable && harness !== 'kusa';

  /** Re-render monitor-data so the renamed row is on the sidebar on the next poll. */
  function pushToMonitor() {
    try {
      refreshMonitorArtifacts(dir, { origin: '' });
    } catch {
      /* monitoring must never break the agent */
    }
  }

  function set(rawName) {
    if (!persistable) {
      return { ok: false, error: 'no session to name (dataDir / sessionKey missing)' };
    }
    if (foreignSession) {
      return {
        ok: false,
        error: `${harness} sessions keep that agent's own title — Kusă cannot name this row.`,
        code: 'EFOREIGN',
      };
    }
    const applied = nameChatSession(dir, key, typeof rawName === 'string' ? rawName : '');
    if (!applied?.ok) {
      return { ok: false, error: applied?.error || 'could not name the session' };
    }
    if (applied.name) pushToMonitor();
    return {
      ok: true,
      name: applied.name ?? null,
      previous: applied.previous ?? null,
      cleared: Boolean(applied.cleared),
      unchanged: Boolean(applied.previous) && applied.previous === applied.name,
      sessionId: applied.sessionId ?? null,
      persisted: persistable,
    };
  }

  function call(name, args = {}, _callId = null) {
    switch (name) {
      case 'kusa_name_session':
      case 'name_session':
      case 'rename_session':
      case 'set_session_name':
        return set(args.name);
      default:
        return { ok: false, error: `unknown session name tool: ${name}` };
    }
  }

  return {
    defs: SESSION_NAME_TOOL_DEFS,
    sessionKey: key,
    dataDir: dir,
    persisted: persistable,
    set,
    call,
  };
}

/**
 * System-prompt nudge: the tool is always advertised, so this only tells the
 * model when a name is worth writing.
 * @returns {string}
 */
export function sessionNameSystemPromptAddon() {
  return [
    'Name the session so the sidebar row says what the chat is about:',
    'kusa_name_session writes one short line (max 72 characters) as this session\'s name.',
    'Call it once, before any other tool, at the start of a session that has no name yet —',
    'name the task the user is asking for, never the greeting or the phrasing.',
    'Call it again only when the session drifts to a genuinely different task; that renames',
    'the row and never touches the transcript.',
    'A session already named by the console does not need naming again.',
  ].join(' ');
}

/** OpenAI/Chat Completions tool schema list. */
export function sessionNameToolSchemas() {
  return SESSION_NAME_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** One-line the model wrote as a title: no quotes, no code fence, no newline. */
function clampSessionName(raw) {
  if (typeof raw !== 'string') return null;
  const oneLine = raw
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/["'““”'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:–—-]+$/, '')
    .trim();
  if (!oneLine) return null;
  return oneLine.length <= MAX_NAME_CHARS ? oneLine : `${oneLine.slice(0, MAX_NAME_CHARS - 1).trim()}…`;
}

/**
 * Title a session with one small model call — the console fires this while a
 * session's first turn starts, so a brand-new chat is named the moment it
 * exists instead of waiting for the model to decide to call its tool.
 *
 * Best-effort by design: no endpoint, a dead endpoint, an aborted signal, or an
 * answer that is not a title all return null and leave the first-prompt title
 * in place. It must never throw into the turn that started the session.
 * @param {object} options
 * @param {object} options.settings agent settings (already scoped to the picked model)
 * @param {string} options.prompt the opening user prompt
 * @param {Array<object>} [options.attachments] files the composer attached (named only)
 * @returns {Promise<{ name: string, model: string } | null>}
 */
export async function requestSessionName({ settings, prompt, attachments = [] } = {}) {
  const ask = String(prompt || '').trim();
  const attached = (Array.isArray(attachments) ? attachments : [])
    .map((file) => (typeof file?.name === 'string' ? file.name.trim() : ''))
    .filter(Boolean);
  if (!ask && !attached.length) return null;
  const endpoint = resolveAgentEndpoint(settings || {});
  if (!endpoint?.baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...endpoint.headers, Accept: 'application/json' },
      body: JSON.stringify({
        model: endpoint.model,
        stream: false,
        // Naming is a labelling task, not a reasoning task: keep it one short
        // completion so it cannot outlive the turn that started the session.
        max_tokens: 48,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: [
              'You name chat sessions. Reply with ONE short line that names what the',
              'session is trying to do — an imperative or a noun phrase, never a greeting,',
              'never a restatement of the whole ask. No quotes, no code, no markdown,',
              'no trailing punctuation, at most 72 characters. Reply with the name only.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              ask ? `The session's first prompt:\n${ask.slice(0, 4_000)}` : '',
              attached.length ? `\nAttached files: ${attached.slice(0, 12).join(', ')}` : '',
            ].filter(Boolean).join('\n'),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw = await res.text();
    const data = raw ? JSON.parse(raw) : {};
    const content = data?.choices?.[0]?.message?.content;
    const name = clampSessionName(typeof content === 'string' ? content : '');
    return name ? { name, model: endpoint.model || '' } : null;
  } catch {
    /* best-effort: an unreachable endpoint leaves the first-prompt title */
    return null;
  } finally {
    clearTimeout(timer);
  }
}
