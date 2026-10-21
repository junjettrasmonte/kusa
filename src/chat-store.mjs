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
import { createKusaHookEmitter } from './agent/hooks.mjs';
import { laneFiles, laneKey, sessionFileStem } from './lib.mjs';

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
    attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    opencodeSessionId: typeof raw.opencodeSessionId === 'string' ? raw.opencodeSessionId : null,
    messages,
    live: null,
  };
}

/** Persistable shape — drop ephemeral live/busy state. */
export function slimChatSession(session) {
  const normalized = normalizeChatSession(session);
  if (!normalized) return null;
  const { live: _live, ...rest } = normalized;
  return {
    ...rest,
    status: rest.status === 'ended' ? 'ended' : 'idle',
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
  return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function readChatSession(dir, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const fromFile = normalizeChatSession(readJsonSafe(chatFilePath(dir, id)));
  if (fromFile) return fromFile;
  const lanePath = laneFiles(dir, { harness: KUSA_HARNESS, id }).json;
  return chatSessionFromLane(readJsonSafe(lanePath));
}

export function writeChatSession(dir, session) {
  const slim = slimChatSession(session);
  if (!slim) {
    const err = new Error('invalid chat session');
    err.code = 'EINVAL';
    throw err;
  }
  atomicWriteFile(chatFilePath(dir, slim.id), `${JSON.stringify(slim, null, 2)}\n`);
  return slim;
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
      deleted.push(sessionId);
    } catch {
      // missing is fine
    }
  }
  return deleted;
}
