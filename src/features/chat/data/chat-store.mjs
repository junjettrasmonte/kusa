/**
 * Kusă chat transcripts under `.kusa/kusa/<id>.chat.json`.
 *
 * Monitor lanes (hook counters) stay in `<id>.json`; the chat UI reads/writes
 * these sidecars so message history survives across browsers and reloads.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { normalizeAttachments } from './attachments.mjs';
import { createKusaHookEmitter } from '#features/agent/hooks.mjs';
import { AGENT_MODE_ASK, AGENT_MODE_AGENT, AGENT_MODE_PLAN } from '#features/agent/modes.mjs';
import { normalizeApprovalMode } from '#features/agent/approval.mjs';
import { laneFiles, laneKey, sessionFileStem, sessionRankAt } from '#features/monitor/lib.mjs';

export const KUSA_HARNESS = 'kusa';
export const CHAT_SUFFIX = '.chat.json';

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

/** Absolute path for a session's chat sidecar. */
export function chatFilePath(dir, sessionId) {
  const stem = sessionFileStem(sessionId);
  return join(dir, KUSA_HARNESS, `${stem}${CHAT_SUFFIX}`);
}

/**
 * Per-session settings sidecar: `.kusa/kusa/<id>.session.json`.
 *
 * A chat owns its composer picks (Mode / Rule / Model), and a chat transcript
 * is the wrong place to keep them: the turn path rewrites the transcript on
 * every step (`persistTurnPrompt`, `persistTurnCompletion`, `saveChatSessions`),
 * so a pick stored inside it only survives as long as the last writer happens
 * to carry it — one writer that rebuilds the record drops the pick and the next
 * refresh reopens the chat on a Settings default. Settings are not turn data,
 * so they get their own file per session: written only when a pick is made,
 * never touched by a turn write, and hand-editable like any other file here.
 */
export const SESSION_CONFIG_SUFFIX = '.session.json';

/** Absolute path for a session's settings sidecar. */
export function sessionConfigPath(dir, sessionId) {
  const stem = sessionFileStem(sessionId);
  return join(dir, KUSA_HARNESS, `${stem}${SESSION_CONFIG_SUFFIX}`);
}

function normalizeMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.text !== 'string') return null;
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
    ...(normalizeAttachments(m.attachments).length
      ? { attachments: normalizeAttachments(m.attachments) }
      : {}),
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
 * Per-session composer picks (Mode / Rule / Model), as stored on the session.
 *
 * A chat owns its pickers: the choice survives a refresh for THAT session only,
 * and a session that never picked has no `options` at all — Settings → Kusă
 * agent is what fills it in then. Unknown ids are dropped rather than coerced,
 * so a hand-edited sidecar cannot smuggle a rule the agent does not implement.
 * Allow / Deny are stored as-is: they are sticky, so a refresh reopens the chat
 * on the rule the user chose and nothing re-derives a fallback from a window.
 * The record lives in the settings sidecar (`<id>.session.json`), not in the
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
  return Object.keys(out).length ? out : null;
}

/** Normalize a chat session record for the dashboard UI. */
export function normalizeChatSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id) return null;
  const key = typeof raw.key === 'string' && raw.key.startsWith(`${KUSA_HARNESS}:`)
    ? raw.key
    : laneKey(KUSA_HARNESS, id);
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normalizeMessage).filter(Boolean)
    : [];
  return {
    key,
    id,
    title: clampTitle(raw.title) || deriveSessionTitle(messages),
    status: raw.status === 'ended' ? 'ended' : 'idle',
    endedAt: Number.isFinite(raw.endedAt) ? raw.endedAt : null,
    attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    opencodeSessionId: typeof raw.opencodeSessionId === 'string' ? raw.opencodeSessionId : null,
    // The session's own composer picks — null means "never picked, use Settings".
    options: normalizeSessionOptions(raw.options),
    messages,
    live: null,
  };
}

/**
 * Read a session's settings sidecar. Null when it never picked anything, which
 * is different from "picked the default": no file means Settings fills the pick
 * in, so a session that was never opened keeps inheriting Settings.
 */
export function readSessionConfig(dir, sessionId) {
  return normalizeSessionOptions(readJsonSafe(sessionConfigPath(dir, sessionId)));
}

/**
 * Merge picks into the settings sidecar and return what is now stored.
 *
 * Only supplied fields change, so a partial pick can never drop the others, and
 * an empty merge writes no file at all — nothing here invents a pick, which is
 * what keeps a turn write from clearing a Rule the user chose.
 */
export function writeSessionConfig(dir, sessionId, over = {}) {
  const merged = normalizeSessionOptions({
    ...(readSessionConfig(dir, sessionId) || {}),
    ...(over || {}),
  });
  if (!merged) return null;
  atomicWriteFile(sessionConfigPath(dir, sessionId), `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/** Persistable shape — drop ephemeral live/busy state. */
export function slimChatSession(session) {
  const normalized = normalizeChatSession(session);
  if (!normalized) return null;
  const { live: _live, ...rest } = normalized;
  const status = rest.status === 'ended' ? 'ended' : 'idle';
  return {
    ...rest,
    // An end is the only chat event that re-ranks the row (see sessionRankAt),
    // so stamp it once — later saves must not move the session again.
    status,
    endedAt: status === 'ended' ? (rest.endedAt ?? Date.now()) : null,
  };
}

/** Rebuild a minimal chat transcript from a monitor lane's prompts. */
export function chatSessionFromLane(lane) {
  if (!lane || lane.harness !== KUSA_HARNESS || !lane.id) return null;
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
    key: lane.key || laneKey(KUSA_HARNESS, lane.id),
    id: lane.id,
    status: lane.active === false || lane.endedAtWall != null ? 'ended' : 'idle',
    endedAt: Number.isFinite(lane.endedAtWall) ? lane.endedAtWall : null,
    attempts: Number.isFinite(lane.promptToolAttempts) ? lane.promptToolAttempts : 0,
    createdAt: Number.isFinite(lane.startedAtWall) ? lane.startedAtWall : Date.now(),
    messages,
  });
}

function listLaneFiles(dir) {
  const folder = join(dir, KUSA_HARNESS);
  if (!existsSync(folder)) return [];
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith(CHAT_SUFFIX)) continue;
    // Settings belong to a session, not to a lane: a sidecar must never be
    // read as one, or a chat that only picked a Rule would show up as a lane
    // with no prompts.
    if (name.endsWith(SESSION_CONFIG_SUFFIX)) continue;
    if (/\.(corrupt|legacy)\.json$/.test(name)) continue;
    if (name.endsWith('.events.jsonl')) continue;
    const path = join(folder, name);
    const raw = readJsonSafe(path);
    if (!raw || raw.harness && raw.harness !== KUSA_HARNESS) continue;
    if (!raw.id) continue;
    out.push(raw);
  }
  return out;
}

function listChatFiles(dir) {
  const folder = join(dir, KUSA_HARNESS);
  if (!existsSync(folder)) return [];
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(CHAT_SUFFIX)) continue;
    const path = join(folder, name);
    const session = normalizeChatSession(readJsonSafe(path));
    if (session) out.push(session);
  }
  return out;
}

/**
 * All Kusă chats: prefer `.chat.json` sidecars; fall back to hydrating from
 * monitor lane prompts when a sidecar is missing (pre-persistence sessions).
 */
export function listChatSessions(dir) {
  const fromChat = listChatFiles(dir);
  const byId = new Map(fromChat.map((s) => [s.id, s]));
  for (const lane of listLaneFiles(dir)) {
    if (byId.has(lane.id)) continue;
    const hydrated = chatSessionFromLane(lane);
    if (hydrated) byId.set(hydrated.id, hydrated);
  }
  const sessions = [...byId.values()];
  // Overlay each session's own settings. This is what makes a Rule survive a
  // page refresh: the dashboard re-reads the sidecar, and no transcript writer
  // on the turn path can have cleared it.
  for (const session of sessions) {
    const config = readSessionConfig(dir, session.id);
    if (config) session.options = config;
  }
  return sessions.sort((a, b) => sessionRankAt(b) - sessionRankAt(a));
}

export function readChatSession(dir, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  // The sidecar is the source of truth for picks; a transcript that still
  // carries them (written before the sidecar existed) is used only when no
  // sidecar is there, so an old file cannot shadow a newer pick.
  const config = readSessionConfig(dir, id);
  const fromFile = normalizeChatSession(readJsonSafe(chatFilePath(dir, id)));
  if (fromFile) return config ? { ...fromFile, options: config } : fromFile;
  const lanePath = laneFiles(dir, { harness: KUSA_HARNESS, id }).json;
  const hydrated = chatSessionFromLane(readJsonSafe(lanePath));
  return hydrated && config ? { ...hydrated, options: config } : hydrated;
}

/**
 * Persist a transcript. Picks are NOT written into it: any the incoming record
 * carries are merged into the settings sidecar instead, so the turn writers
 * (which rebuild this file every step and know nothing about picks) cannot
 * reset a Rule — and a pre-sidecar transcript that still has `options` inside
 * it is migrated out on the first write that touches it.
 */
export function writeChatSession(dir, session) {
  const slim = slimChatSession(session);
  if (!slim) {
    const err = new Error('invalid chat session');
    err.code = 'EINVAL';
    throw err;
  }
  const stored = readSessionConfig(dir, slim.id);
  const merged = writeSessionConfig(dir, slim.id, {
    ...(stored || {}),
    ...(normalizeSessionOptions(session.options) || {}),
  });
  const { options: _picks, ...transcript } = slim;
  atomicWriteFile(chatFilePath(dir, slim.id), `${JSON.stringify(transcript, null, 2)}\n`);
  // The record handed back is the dashboard's view: transcript + the session's
  // effective settings, whatever the sidecar says now.
  return { ...slim, options: merged };
}

/** Create an empty chat + monitor lane (sessionStart hook). */
export function createChatSession(dir, { id, workspaceRoot = process.cwd(), createdAt } = {}) {
  const sessionId = (typeof id === 'string' && id.trim()) ? id.trim() : newId();
  const existing = readChatSession(dir, sessionId);
  if (existing && (existing.messages?.length || existsSync(chatFilePath(dir, sessionId)))) {
    return existing;
  }
  const session = writeChatSession(dir, {
    key: laneKey(KUSA_HARNESS, sessionId),
    id: sessionId,
    status: 'idle',
    attempts: 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    messages: [],
  });
  const hooks = createKusaHookEmitter({
    dataDir: dir,
    sessionId,
    workspaceRoot,
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
    if (!existsSync(laneFiles(dir, { harness: KUSA_HARNESS, id: incoming.id }).json)) {
      const hooks = createKusaHookEmitter({
        dataDir: dir,
        sessionId: incoming.id,
        workspaceRoot,
      });
      if (hooks.enabled) hooks.sessionStart();
    }
    imported.push(incoming.id);
  }
  return { imported, skipped, sessions: listChatSessions(dir) };
}

/** Remove chat sidecars for the given session ids (best-effort). */
export function deleteChatFiles(dir, sessionIds) {
  const deleted = [];
  for (const raw of sessionIds || []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    // Accept either bare id or `kusa:id`.
    const sessionId = id.startsWith(`${KUSA_HARNESS}:`) ? id.slice(KUSA_HARNESS.length + 1) : id;
    const path = chatFilePath(dir, sessionId);
    try {
      unlinkSync(path);
      // A deleted chat drops its settings too, so the id cannot be reused with
      // a Rule the user picked in a chat they already threw away.
      try {
        unlinkSync(sessionConfigPath(dir, sessionId));
      } catch {
        /* no sidecar was ever written */
      }
      deleted.push(sessionId);
    } catch {
      // missing is fine
    }
  }
  return deleted;
}
