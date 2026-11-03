/**
 * Provider chat transcripts under `.kusa/sessions/<id>/chat.json`.
 *
 * Every session owns a folder under the shared `sessions/` tree that holds its
 * monitor lane, events, chat transcript, settings sidecar, and an
 * `attachments/` subfolder for files that rode on messages. Harness/provider is
 * a field on the record (and in lane keys), not a disk folder. Monitor lanes
 * stay in `lane.json` beside the chat sidecar so message history survives
 * across browsers and reloads.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  hydrateAttachments,
  normalizeAttachments,
  persistAttachments,
} from './attachments.mjs';
import { createKusaHookEmitter } from '#features/agent/hooks.mjs';
import { AGENT_MODE_ASK, AGENT_MODE_AGENT, AGENT_MODE_PLAN } from '#features/agent/modes.mjs';
import { normalizeApprovalMode } from '#features/agent/approval.mjs';
import {
  CHAT_FILE,
  ensureSessionDirs,
  laneFiles,
  laneKey,
  laneListedInSidebar,
  migrateFlatSessionFiles,
  migrateHarnessSessionsToShared,
  sessionRankAt,
  sessionsRoot,
} from '#features/monitor/lib.mjs';
import {
  CHAT_HARNESSES,
  CHAT_PROVIDERS,
  enrichChatSessions,
  harnessForProvider,
  isExternalOwnedHarness,
  normalizeSessionKind,
  providerForHarness,
  resolveChatProvider,
  SESSION_KIND_STANDARD,
} from './providers.mjs';
import './load-builtin-adapters.mjs';

export const KUSA_HARNESS = 'kusa';
export { CHAT_FILE };
/** @deprecated use CHAT_FILE — kept for callers matching legacy `*.chat.json`. */
export const CHAT_SUFFIX = '.chat.json';
export {
  CHAT_HARNESSES,
  CHAT_PROVIDERS,
  harnessForProvider,
  isExternalChatSession,
  normalizeSessionKind,
  providerForHarness,
  resolveChatProvider,
  SESSION_KIND_STANDARD,
} from './providers.mjs';
// Local import is used above; re-export the same helper for callers.
export { isExternalOwnedHarness };

function atomicWriteFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function newId() {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Paths for one chat session under a harness folder (migrates flat files first). */
export function chatSessionFiles(dir, harness, sessionId) {
  const name = typeof harness === 'string' && harness.trim() ? harness.trim() : KUSA_HARNESS;
  return migrateFlatSessionFiles(dir, { harness: name, id: sessionId });
}

/** @deprecated use chatSessionFiles — kept for callers that still assume Kusă. */
function kusaSessionFiles(dir, sessionId) {
  return chatSessionFiles(dir, KUSA_HARNESS, sessionId);
}

/**
 * Resolve a session id (or `harness:id` key) to `{ harness, id }`.
 * Disk layout is shared (`sessions/<id>/`); harness comes from the key prefix
 * when present, otherwise from the lane/chat/config record on disk.
 */
export function resolveSessionRef(dir, sessionIdOrKey) {
  const raw = String(sessionIdOrKey || '').trim();
  if (!raw) return null;
  let harnessHint = null;
  let id = raw;
  for (const harness of CHAT_HARNESSES) {
    const prefix = `${harness}:`;
    if (raw.startsWith(prefix)) {
      harnessHint = harness;
      id = raw.slice(prefix.length);
      break;
    }
  }
  if (!id) return null;
  // Touch migration so a bare id still finds a just-upgraded folder.
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  const files = chatSessionFiles(dir, harnessHint || KUSA_HARNESS, id);
  const chat = existsSync(files.chat) ? readJsonSafe(files.chat) : null;
  const config = existsSync(files.config) ? readJsonSafe(files.config) : null;
  const lane = existsSync(files.json) ? readJsonSafe(files.json) : null;
  const fromRecord = lane?.harness
    || chat?.harness
    || resolveChatProvider(config?.provider || chat?.provider)?.harness
    || null;
  const harness = harnessHint
    || (CHAT_HARNESSES.includes(fromRecord) ? fromRecord : null)
    || KUSA_HARNESS;
  return { harness, id };
}

/** Absolute path for a session's chat sidecar. */
export function chatFilePath(dir, sessionId, harness = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim() }
    : resolveSessionRef(dir, sessionId);
  if (!ref?.id) return chatSessionFiles(dir, KUSA_HARNESS, '').chat;
  return chatSessionFiles(dir, ref.harness, ref.id).chat;
}

/**
 * Per-session settings sidecar: `.kusa/sessions/<id>/session.json`.
 *
 * A chat owns its composer picks (Mode / Rule / Model), and a chat transcript
 * is the wrong place to keep them: the turn path rewrites the transcript on
 * every step (`persistTurnPrompt`, `persistTurnCompletion`, `saveChatSessions`),
 * so a pick stored inside it only survives as long as the last writer happens
 * to carry it — one writer that rebuilds the record drops the pick and the next
 * refresh reopens the chat on a Settings default. Settings are not turn data,
 * so they get their own file inside the session folder: written only when a
 * pick is made, never touched by a turn write, and hand-editable like any
 * other file here. Flat `<id>.session.json` leftovers (and the short-lived
 * in-folder `<id>.session.json` name) are migrated on read/write.
 */
export const SESSION_CONFIG_FILE = 'session.json';
/** @deprecated use SESSION_CONFIG_FILE — kept for callers matching `*.session.json`. */
export const SESSION_CONFIG_SUFFIX = '.session.json';

/** Absolute path for a session's settings sidecar. */
export function sessionConfigPath(dir, sessionId, harness = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim() }
    : resolveSessionRef(dir, sessionId);
  if (!ref?.id) return chatSessionFiles(dir, KUSA_HARNESS, '').config;
  return chatSessionFiles(dir, ref.harness, ref.id).config;
}

/**
 * Normalize a message. When `dir` + `sessionId` are given, attachment bytes are
 * written into that session's `attachments/` folder and the returned record
 * keeps only the slim pointer (`file`) — chat.json must not grow with every
 * picture. Without a session folder the inline payload is kept (queue / tests).
 */
function normalizeMessage(m, { dir = null, sessionId = '', harness = KUSA_HARNESS, persist = false, hydrate = false } = {}) {
  if (!m || typeof m !== 'object' || typeof m.text !== 'string') return null;
  let attachments = normalizeAttachments(m.attachments);
  if (attachments.length && dir && sessionId && persist) {
    attachments = persistAttachments(dir, sessionId, attachments, harness);
  } else if (attachments.length && dir && sessionId && hydrate) {
    attachments = hydrateAttachments(dir, sessionId, attachments, harness);
  }
  return {
    id: String(m.id || newId()),
    role: m.role === 'assistant' ? 'assistant' : 'user',
    text: String(m.text),
    thinking: typeof m.thinking === 'string' ? m.thinking : '',
    tools: Array.isArray(m.tools) ? m.tools : [],
    parts: Array.isArray(m.parts) ? m.parts : undefined,
    at: Number.isFinite(m.at) ? m.at : Date.now(),
    ...(m.backend != null ? { backend: m.backend } : {}),
    ...(typeof m.turnId === 'string' && m.turnId ? { turnId: m.turnId } : {}),
    ...(m.stopped === true ? { stopped: true } : {}),
    ...(m.steered === true ? { steered: true } : {}),
    ...(m.error === true ? { error: true } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

/**
 * Concise one-line session title derived from a prompt's first meaningful line.
 * Deterministic and local (no model call) so titles work offline and stay
 * stable across reloads — the first user prompt is what names a chat.
 */
export const TITLE_MAX_CHARS = 72;

function titleFromText(raw) {
  if (!raw) return null;
  const stripped = String(raw)
    // Drop fenced code blocks, then inline code and link targets.
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)\n]*\)/g, '$1');
  const line = stripped
    .split(/\r?\n/)
    .map((s) => s.replace(/^[ \t]*(?:#{1,6}|[-*+•>])[ \t]+/, '').trim())
    .find((s) => s.length > 0);
  if (!line) return null;
  const flat = line
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  // Prefer a leading sentence: "Fix the parser. Then add tests" -> "Fix the parser".
  const sentence = flat.match(/^(.{8,}?[.!?])(?:\s|$)/);
  const base = sentence ? sentence[1].trim() : flat;
  if (base.length <= TITLE_MAX_CHARS) return base;
  const cut = base.slice(0, TITLE_MAX_CHARS);
  const boundary = cut.lastIndexOf(' ');
  const clipped = boundary > TITLE_MAX_CHARS * 0.5 ? cut.slice(0, boundary) : cut;
  const trimmed = clipped.replace(/[\s,;:.!?\-–—]+$/, '').trim();
  return trimmed ? `${trimmed}…` : null;
}

/** Title for a transcript: first user message wins; explicit title wins over it. */
export function deriveSessionTitle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((m) => m && m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  return first ? titleFromText(first.text) : null;
}

function clampTitle(raw) {
  if (typeof raw !== 'string') return null;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length <= TITLE_MAX_CHARS ? oneLine : `${oneLine.slice(0, TITLE_MAX_CHARS - 1).trim()}…`;
}

/**
 * A name the model authored for a session (`kusa_name_session`). Clamped exactly
 * like a derived title because the sidebar renders either one through the same
 * box — two different widths would make a renamed row look different.
 */
function normalizeSessionName(raw) {
  const clamped = clampTitle(raw);
  if (!clamped) return null;
  // A name must not end in punctuation, the same trim `titleFromText` does
  // before it appends '…': the model is asked for a plain line, and a stray
  // "—" or "," would otherwise sit in the same box a derived title fills.
  const trimmed = clamped.replace(/[\s,;:.!?\-–—]+$/, '').trim();
  return trimmed || null;
}

/**
 * Per-session composer picks (Mode / Rule / Model), as stored on the session.
 *
 * A chat owns its pickers: the choice survives a refresh for THAT session only,
 * and a session that never picked has no `options` at all — Settings → Kusă
 * agent is what fills it in then. Unknown ids are dropped rather than coerced,
 * so a hand-edited sidecar cannot smuggle a rule the agent does not implement.
 * Allow / Deny are stored as-is: they are sticky, so a refresh reopens the chat
 * on the rule the user chose and nothing re-derives a fallback from a window.
 * The record lives in the settings sidecar (`session.json`), not in the
 * transcript — see `sessionConfigPath`.
 */
function normalizeSessionOptions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : '';
  if (mode === AGENT_MODE_ASK || mode === AGENT_MODE_PLAN || mode === AGENT_MODE_AGENT) {
    out.mode = mode;
  }
  const rules = typeof raw.rules === 'string' ? raw.rules.trim().toLowerCase() : '';
  if (rules && normalizeApprovalMode(rules) === rules) {
    out.rules = rules;
  }
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : '';
  if (model) out.model = model;
  // Which agentEndpoints[] id the Model pick sat under (empty = Default). Kept
  // so a probed-only model still routes to that endpoint after a refresh.
  // Empty string is intentional: writeSessionConfig merges with the prior
  // record, so omitting the key would leave a stale extra-endpoint id in place
  // after the user switched back to Default.
  if (Object.hasOwn(raw, 'endpointId')) {
    out.endpointId = typeof raw.endpointId === 'string' ? raw.endpointId.trim().slice(0, 80) : '';
  }
  const provider = resolveChatProvider(raw.provider);
  if (provider) out.provider = provider.id;
  if (Object.hasOwn(raw, 'kind') || raw.kind) {
    out.kind = normalizeSessionKind(raw.kind);
  }
  // A name the model authored for this chat (kusa_name_session). It lives here,
  // not in the transcript: the turn path rebuilds chat.json on every step, so a
  // name written into it only survives while the last writer happens to carry it
  // — the sidecar is never touched by those writes (same rule as the picks).
  const authoredName = normalizeSessionName(raw.name);
  if (authoredName) out.name = authoredName;
  if (typeof raw.caoSessionName === 'string' && raw.caoSessionName.trim()) {
    out.caoSessionName = raw.caoSessionName.trim().slice(0, 120);
  }
  if (typeof raw.caoTerminalId === 'string' && raw.caoTerminalId.trim()) {
    out.caoTerminalId = raw.caoTerminalId.trim().slice(0, 120);
  }
  if (typeof raw.workflowId === 'string' && raw.workflowId.trim()) {
    out.workflowId = raw.workflowId.trim().slice(0, 200);
  }
  // Opaque CLI resume ids written by provider adapters (Cursor / Copilot).
  for (const key of ['cliSessionId', 'cursorCliSessionId', 'copilotCliSessionId']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) {
      out[key] = raw[key].trim().slice(0, 200);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalize a chat session record for the dashboard UI.
 * @param {object} raw
 * @param {{ dir?: string, persist?: boolean, hydrate?: boolean }} [opts]
 *   When `dir` is set, `persist` writes attachment bytes into that session's
 *   attachments/ folder (for saves) and `hydrate` reloads them (for reads).
 */
export function normalizeChatSession(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id) return null;
  // Only the settings sidecar / explicit `options` object carries picks — never
  // scrape top-level provider/kind onto options or every write invents a sidecar.
  const options = normalizeSessionOptions(raw.options) || null;
  const providerMeta = resolveChatProvider(options?.provider || raw.provider || raw.harness);
  let harness = providerMeta?.harness || KUSA_HARNESS;
  if (typeof raw.key === 'string' && raw.key.includes(':')) {
    const prefix = raw.key.slice(0, raw.key.indexOf(':'));
    if (CHAT_HARNESSES.includes(prefix)) harness = prefix;
  } else if (typeof raw.harness === 'string' && CHAT_HARNESSES.includes(raw.harness)) {
    harness = raw.harness;
  } else if (opts.harness && CHAT_HARNESSES.includes(opts.harness)) {
    harness = opts.harness;
  }
  const key = typeof raw.key === 'string' && raw.key.startsWith(`${harness}:`)
    ? raw.key
    : laneKey(harness, id);
  const provider = providerMeta?.id || providerForHarness(harness);
  const kind = normalizeSessionKind(options?.kind || raw.kind || SESSION_KIND_STANDARD);
  const messageOpts = {
    dir: opts.dir || null,
    sessionId: id,
    harness,
    persist: Boolean(opts.persist),
    hydrate: Boolean(opts.hydrate),
  };
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map((m) => normalizeMessage(m, messageOpts)).filter(Boolean)
    : [];
  // Composer sidecar picks only — provider/kind live on the session record so a
  // brand-new chat does not invent a session.json full of defaults.
  // `external` marks IDE-owned chats (adapter hooks). Kusă-created CLI sessions
  // write false; lane-only externalOwned harness chats hydrate as true.
  const external = raw.external === true;
  const resolvedMeta = providerMeta || resolveChatProvider(provider);
  const trust = resolvedMeta?.workspaceTrust;
  const modelsMeta = resolvedMeta?.models;
  // What names this row in the sidebar. An authored name (the model renamed the
  // session) wins over the transcript: it is not turn data, it lives in the
  // settings sidecar, and a record already carrying `options` was just read
  // through that sidecar — reading it again only happens for a bare record.
  const authoredName = normalizeSessionName(options?.name)
    || (opts.dir ? normalizeSessionName(readSessionConfig(opts.dir, id, harness)?.name) : null);
  return {
    key,
    id,
    harness,
    provider,
    kind,
    external,
    /** True for adapter/CAO providers — BYOK endpoint credentials do not apply. */
    cliBacked: resolvedMeta?.turnBackend === 'cao',
    /** Adapter owns its model catalog (e.g. Cursor `--list-models`). */
    ownsModels: Boolean(resolvedMeta?.ownsModels && modelsMeta?.path),
    modelsPath: modelsMeta?.path ? String(modelsMeta.path) : null,
    /** Workspace gate contributed by the provider adapter (e.g. Cursor trust). */
    workspaceTrust: trust
      ? {
        path: String(trust.path || ''),
        label: String(trust.label || 'Trust workspace'),
        title: String(trust.title || ''),
        summary: String(trust.summary || ''),
      }
      : null,
    title: authoredName || clampTitle(raw.title) || deriveSessionTitle(messages),
    // Live activity (busy/thinking/idle/ended) is separate from user archive.
    // `status === 'archived'` is accepted as a legacy/alias write shape.
    status: raw.status === 'ended' ? 'ended' : 'idle',
    archived: raw.archived === true || raw.status === 'archived',
    archivedAt: Number.isFinite(raw.archivedAt) ? raw.archivedAt : null,
    endedAt: Number.isFinite(raw.endedAt) ? raw.endedAt : null,
    attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    opencodeSessionId: typeof raw.opencodeSessionId === 'string' ? raw.opencodeSessionId : null,
    // The session's own composer picks — null means "never picked, use Settings".
    options: options || null,
    messages,
    live: null,
  };
}

/**
 * Read a session's settings sidecar. Null when it never picked anything, which
 * is different from "picked the default": no file means Settings fills the pick
 * in, so a session that was never opened keeps inheriting Settings.
 */
export function readSessionConfig(dir, sessionId, harness = null) {
  return normalizeSessionOptions(readJsonSafe(sessionConfigPath(dir, sessionId, harness)));
}

/**
 * Merge picks into the settings sidecar and return what is now stored.
 *
 * Only supplied fields change, so a partial pick can never drop the others, and
 * an empty merge writes no file at all — nothing here invents a pick, which is
 * what keeps a turn write from clearing a Rule the user chose.
 */
export function writeSessionConfig(dir, sessionId, over = {}, harness = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim() }
    : resolveSessionRef(dir, sessionId);
  const id = ref?.id || String(sessionId || '').trim();
  const h = ref?.harness || KUSA_HARNESS;
  const merged = normalizeSessionOptions({
    ...(readSessionConfig(dir, id, h) || {}),
    ...(over || {}),
  });
  const path = sessionConfigPath(dir, id, h);
  if (!merged) {
    // Nothing is left to store: a cleared pick (an authored name, a model…) must
    // not linger on disk, or the next read would resurrect it. No file is the
    // "never picked" shape, so dropping the sidecar is the honest end state.
    try {
      unlinkSync(path);
    } catch {
      /* absent already — nothing to clear */
    }
    return null;
  }
  atomicWriteFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/**
 * Name (or rename) a session with an authored title.
 *
 * The name lands in the settings sidecar, never in the transcript — see the
 * note in `normalizeChatSession`: turn writers rebuild chat.json every step and
 * know nothing about names, so an authored name written there would be reset by
 * the next turn write. Pass an empty name to drop the authored name and let the
 * first user prompt title the row again.
 * @returns {{ ok: boolean, name: string|null, previous: string|null, cleared: boolean }}
 */
export function nameChatSession(dir, sessionIdOrKey, name, harness = null) {
  const ref = harness
    ? { harness, id: String(sessionIdOrKey || '').trim() }
    : resolveSessionRef(dir, sessionIdOrKey);
  const id = ref?.id || '';
  if (!id) return { ok: false, error: 'session not found' };
  const h = ref.harness || KUSA_HARNESS;
  const files = chatSessionFiles(dir, h, id);
  // A name only belongs to a session that exists — naming a phantom would write
  // a sidecar nothing owns and leave an orphan folder on disk.
  const known = [files.chat, files.json, files.config].some((p) => existsSync(p));
  if (!known) return { ok: false, error: `no session ${id} to name` };
  const previous = normalizeSessionName(readSessionConfig(dir, id, h)?.name);
  const cleared = !(typeof name === 'string' && String(name).trim());
  const next = cleared ? null : normalizeSessionName(name);
  const options = writeSessionConfig(dir, id, { ...(cleared ? { name: '' } : { name: next }) }, h);
  return {
    ok: Boolean(options?.name) || cleared,
    name: normalizeSessionName(options?.name),
    previous,
    cleared,
    sessionId: id,
    harness: h,
  };
}

/**
 * Persistable shape — drop ephemeral live/busy state.
 * Pass `{ dir }` so attachment bytes are written into attachments/ and the
 * returned messages keep only slim `file` pointers for chat.json.
 */
export function slimChatSession(session, opts = {}) {
  const normalized = normalizeChatSession(session, {
    dir: opts.dir || null,
    persist: Boolean(opts.dir),
  });
  if (!normalized) return null;
  const { live: _live, ...rest } = normalized;
  const status = rest.status === 'ended' ? 'ended' : 'idle';
  const archived = rest.archived === true;
  return {
    ...rest,
    // An end is the only chat event that re-ranks the row (see sessionRankAt),
    // so stamp it once — later saves must not move the session again.
    status,
    endedAt: status === 'ended' ? (rest.endedAt ?? Date.now()) : null,
    archived,
    archivedAt: archived ? (rest.archivedAt ?? Date.now()) : null,
  };
}

/** Rebuild a minimal chat transcript from a monitor lane's prompts. */
export function chatSessionFromLane(lane) {
  if (!lane || !lane.id) return null;
  const harness = CHAT_HARNESSES.includes(lane.harness) ? lane.harness : null;
  if (!harness) return null;
  const messages = [];
  const prompts = Array.isArray(lane.prompts) ? lane.prompts : [];
  // Oldest first so the chat reads top-to-bottom.
  const ordered = [...prompts].sort((a, b) => (a.atWall ?? 0) - (b.atWall ?? 0));
  for (const prompt of ordered) {
    if (!prompt || typeof prompt.text !== 'string') continue;
    messages.push({
      id: `prompt-${prompt.index ?? messages.length}-user`,
      role: 'user',
      text: String(prompt.text),
      thinking: '',
      tools: [],
      at: Number.isFinite(prompt.atWall) ? prompt.atWall : Date.now(),
    });
    if (typeof prompt.response === 'string' && prompt.response) {
      messages.push({
        id: `prompt-${prompt.index ?? messages.length}-assistant`,
        role: 'assistant',
        text: String(prompt.response),
        thinking: '',
        tools: [],
        at: Number.isFinite(prompt.endedAtWall) ? prompt.endedAtWall : (prompt.atWall ?? Date.now()),
      });
    }
  }
  return normalizeChatSession({
    key: lane.key || laneKey(harness, lane.id),
    id: lane.id,
    harness,
    provider: providerForHarness(harness),
    // Lane-only Cursor chats are owned by Cursor UI — Kusă observes them.
    external: isExternalOwnedHarness(harness),
    status: lane.active === false || lane.endedAtWall != null ? 'ended' : 'idle',
    endedAt: Number.isFinite(lane.endedAtWall) ? lane.endedAtWall : null,
    attempts: Number.isFinite(lane.promptToolAttempts) ? lane.promptToolAttempts : 0,
    createdAt: Number.isFinite(lane.startedAtWall) ? lane.startedAtWall : Date.now(),
    // Cursor UI titles land on the lane when the IDE generates/renames them.
    title: typeof lane.title === 'string' ? lane.title : null,
    messages,
  });
}

function listLaneFiles(dir) {
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  const folder = sessionsRoot(dir);
  if (!existsSync(folder)) return [];
  let entries = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = migrateFlatSessionFiles(dir, { harness: KUSA_HARNESS, id: entry.name });
    if (!existsSync(files.json)) continue;
    const raw = readJsonSafe(files.json);
    if (!raw?.id) continue;
    const harness = CHAT_HARNESSES.includes(raw.harness) ? raw.harness : KUSA_HARNESS;
    out.push({ ...raw, harness });
  }
  return out;
}

function listChatFiles(dir) {
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  const folder = sessionsRoot(dir);
  if (!existsSync(folder)) return [];
  let entries = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = migrateFlatSessionFiles(dir, { harness: KUSA_HARNESS, id: entry.name });
    if (!existsSync(files.chat)) continue;
    const raw = readJsonSafe(files.chat);
    const harnessHint = CHAT_HARNESSES.includes(raw?.harness) ? raw.harness : null;
    const session = normalizeChatSession(raw, {
      dir,
      hydrate: true,
      harness: harnessHint || undefined,
    });
    if (session) out.push(session);
  }
  return out;
}

/**
 * When the same session id exists under more than one provider folder (a kusa
 * hook shadow next to a cursor/copilot chat, etc.), pick the row the Agents
 * list should keep. Richer transcripts win; a declared provider that matches
 * the folder beats a shadow; non-kusa folders beat bare kusa copies.
 */
function chatSessionListScore(session) {
  if (!session) return -1;
  let score = 0;
  const msgs = Array.isArray(session.messages) ? session.messages.length : 0;
  score += msgs * 10;
  const providerMeta = resolveChatProvider(session.provider || session.options?.provider);
  if (providerMeta?.harness && providerMeta.harness === session.harness) score += 20;
  if (session.harness && session.harness === providerMeta?.harness) score += 5;
  if (session.harness && session.harness !== KUSA_HARNESS) score += 3;
  if (session.title) score += 1;
  return score;
}

function preferListedChatSession(current, next) {
  if (!current) return next;
  if (!next) return current;
  const curScore = chatSessionListScore(current);
  const nextScore = chatSessionListScore(next);
  if (nextScore !== curScore) return nextScore > curScore ? next : current;
  return sessionRankAt(next) > sessionRankAt(current) ? next : current;
}

/**
 * All provider chats: prefer `chat.json` sidecars; fall back to hydrating from
 * monitor lane prompts when a sidecar is missing (pre-persistence sessions).
 * One row per session id — cross-harness copies of the same id collapse here
 * so the consolidated Agents list never double-loads kusa+cursor twins.
 */
export function listChatSessions(dir) {
  const byId = new Map();
  for (const session of listChatFiles(dir)) {
    if (!session?.id) continue;
    byId.set(session.id, preferListedChatSession(byId.get(session.id), session));
  }
  for (const lane of listLaneFiles(dir)) {
    if (!lane?.id || byId.has(lane.id)) continue;
    // Same gate as monitor buildView: prompt-less Cursor CLI/IDE blips must
    // not appear as empty Agents rows (tools alone ≠ a chat).
    if (!laneListedInSidebar(lane)) continue;
    const hydrated = chatSessionFromLane(lane);
    if (hydrated) byId.set(hydrated.id, hydrated);
  }
  const sessions = [...byId.values()];
  // Overlay each session's own settings. This is what makes a Rule survive a
  // page refresh: the dashboard re-reads the sidecar, and no transcript writer
  // on the turn path can have cleared it.
  for (const session of sessions) {
    const config = readSessionConfig(dir, session.id, session.harness);
    if (config) session.options = config;
  }
  // Adapter enrichers (e.g. Cursor IDE composer titles) overlay provider-specific
  // metadata so the Agents list picks them up on the next /kusa/sessions poll.
  enrichChatSessions(sessions);
  return sessions.sort((a, b) => sessionRankAt(b) - sessionRankAt(a));
}

export function readChatSession(dir, sessionId, harness = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim() }
    : resolveSessionRef(dir, sessionId);
  const id = ref?.id || '';
  if (!id) return null;
  const h = ref.harness || KUSA_HARNESS;
  // The sidecar is the source of truth for picks; a transcript that still
  // carries them (written before the sidecar existed) is used only when no
  // sidecar is there, so an old file cannot shadow a newer pick.
  const config = readSessionConfig(dir, id, h);
  const fromFile = normalizeChatSession(readJsonSafe(chatFilePath(dir, id, h)), {
    dir,
    hydrate: true,
    harness: h,
  });
  if (fromFile) return config ? { ...fromFile, options: { ...fromFile.options, ...config } } : fromFile;
  const lanePath = laneFiles(dir, { harness: h, id }).json;
  const hydrated = chatSessionFromLane(readJsonSafe(lanePath));
  return hydrated && config ? { ...hydrated, options: { ...hydrated.options, ...config } } : hydrated;
}

/**
 * Persist a transcript. Picks are NOT written into it: any the incoming record
 * carries are merged into the settings sidecar instead, so the turn writers
 * (which rebuild this file every step and know nothing about picks) cannot
 * reset a Rule — and a pre-sidecar transcript that still has `options` inside
 * it is migrated out on the first write that touches it.
 *
 * Attachment bytes are written into `<id>/attachments/` and the transcript
 * stores slim pointers only, so chat.json stays readable and the files survive
 * for as long as the session folder does.
 */
export function writeChatSession(dir, session) {
  const slim = slimChatSession(session, { dir });
  if (!slim) {
    const err = new Error('invalid chat session');
    err.code = 'EINVAL';
    throw err;
  }
  const harness = slim.harness || KUSA_HARNESS;
  const stored = readSessionConfig(dir, slim.id, harness);
  const incoming = normalizeSessionOptions(session.options) || {};
  const merged = writeSessionConfig(dir, slim.id, {
    ...(stored || {}),
    ...incoming,
  }, harness);
  const { options: _picks, ...transcript } = slim;
  atomicWriteFile(chatFilePath(dir, slim.id, harness), `${JSON.stringify(transcript, null, 2)}\n`);
  // Keep attachments/ and sub-sessions/ present once the session folder exists.
  ensureSessionDirs(chatSessionFiles(dir, harness, slim.id));
  // Hand back a hydrated view so the dashboard / agent still see dataUrls —
  // the on-disk transcript stays slim.
  const hydrated = normalizeChatSession(transcript, { dir, hydrate: true, harness }) || slim;
  return { ...hydrated, options: merged };
}

/** Create an empty chat + monitor lane (sessionStart hook). */
export function createChatSession(dir, {
  id,
  workspaceRoot = process.cwd(),
  createdAt,
  provider = 'kusa',
  kind = SESSION_KIND_STANDARD,
  workflowId = null,
} = {}) {
  const meta = resolveChatProvider(provider) || CHAT_PROVIDERS.kusa;
  const harness = meta.harness;
  const sessionId = (typeof id === 'string' && id.trim()) ? id.trim() : newId();
  const existing = readChatSession(dir, sessionId, harness);
  if (existing && (existing.messages?.length || existsSync(chatFilePath(dir, sessionId, harness)))) {
    return existing;
  }
  const sessionKind = normalizeSessionKind(kind);
  const createOptions = {
    ...(meta.id !== 'kusa' ? { provider: meta.id } : {}),
    ...(sessionKind !== SESSION_KIND_STANDARD ? { kind: sessionKind } : {}),
    ...(typeof workflowId === 'string' && workflowId.trim()
      ? { workflowId: workflowId.trim(), kind: sessionKind, provider: meta.id }
      : {}),
  };
  const session = writeChatSession(dir, {
    key: laneKey(harness, sessionId),
    id: sessionId,
    harness,
    provider: meta.id,
    kind: sessionKind,
    // Created in Kusă (including Cursor via CLI) — not an external IDE chat.
    external: false,
    status: 'idle',
    attempts: 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    messages: [],
    ...(Object.keys(createOptions).length ? { options: createOptions } : {}),
  });
  const hooks = createKusaHookEmitter({
    dataDir: dir,
    sessionId,
    workspaceRoot,
    harness,
  });
  if (hooks.enabled) hooks.sessionStart();
  return session;
}

/** Upsert one or many chat sessions. Returns the written list. */
export function saveChatSessions(dir, sessions) {
  const list = Array.isArray(sessions) ? sessions : [sessions];
  const written = [];
  for (const item of list) {
    const slim = writeChatSession(dir, item);
    written.push(slim);
  }
  return written;
}

/**
 * Import browser-local sessions (legacy localStorage). Skips ids that already
 * have a richer on-disk transcript.
 */
export function migrateChatSessions(dir, sessions, { workspaceRoot = process.cwd() } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const imported = [];
  const skipped = [];
  for (const raw of list) {
    const incoming = slimChatSession(raw);
    if (!incoming) continue;
    const existing = readChatSession(dir, incoming.id);
    const existingLen = existing?.messages?.length || 0;
    const incomingLen = incoming.messages?.length || 0;
    if (existing && existingLen >= incomingLen && existsSync(chatFilePath(dir, incoming.id))) {
      skipped.push(incoming.id);
      continue;
    }
    writeChatSession(dir, {
      ...incoming,
      // Keep the longer transcript when merging.
      messages: incomingLen >= existingLen ? incoming.messages : existing.messages,
    });
    // Ensure a monitor lane exists for sidebar/delete parity.
    const migrateHarness = incoming.harness || KUSA_HARNESS;
    if (!existsSync(laneFiles(dir, { harness: migrateHarness, id: incoming.id }).json)) {
      const hooks = createKusaHookEmitter({
        dataDir: dir,
        sessionId: incoming.id,
        workspaceRoot,
        harness: migrateHarness,
      });
      if (hooks.enabled) hooks.sessionStart();
    }
    imported.push(incoming.id);
  }
  return { imported, skipped, sessions: listChatSessions(dir) };
}

/**
 * Remove chat transcript, settings, and attachments for the given ids.
 * The monitor lane (and its events) stay so a lane-only row can still hydrate;
 * an explicit session delete goes through `deleteSessions`, which drops the
 * whole folder.
 */
export function deleteChatFiles(dir, sessionIds) {
  const deleted = [];
  for (const raw of sessionIds || []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const ref = resolveSessionRef(dir, id);
    if (!ref?.id) continue;
    const files = chatSessionFiles(dir, ref.harness, ref.id);
    let removed = false;
    for (const path of [files.chat, files.config]) {
      try {
        unlinkSync(path);
        removed = true;
      } catch {
        /* missing is fine */
      }
    }
    // Attachments belong to the chat — drop the folder so files cannot outlive
    // a transcript the user already threw away.
    try {
      rmSync(files.attachments, { recursive: true, force: true });
    } catch {
      /* no attachments folder */
    }
    if (removed) deleted.push(ref.id);
  }
  return deleted;
}
