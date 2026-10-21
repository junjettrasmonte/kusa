/**
 * Per-session task lists under `.kusa/kusa/tasks.json`.
 *
 * Plan/todo rows from TodoWrite stay tied to the session that wrote them (unlike
 * the workspace-shared prompt queue). This sidecar keeps each session's Task
 * List across serve/hook process bounces.
 *
 * Shape (v2):
 *   { version: 2, sessions: { "<harness>:<id>": { updatedAtWall, todos: [...] } } }
 *
 * Legacy v1 `{ todos: [...] }` (workspace-shared) is ignored on load so a bounce
 * does not re-spread those rows onto every chat; the next persist rewrites v2
 * from each lane's own todos.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { KUSA_HARNESS } from './chat-store.mjs';

export const TASKS_FILE = 'tasks.json';

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

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

/** Absolute path for the task-list sidecar. */
export function tasksFilePath(dir) {
  return join(dir, KUSA_HARNESS, TASKS_FILE);
}

function normalizeTodo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 80);
  const content = String(raw.content ?? raw.text ?? raw.title ?? '').trim().slice(0, 500);
  if (!id && !content) return null;
  const status = String(raw.status || 'pending').trim();
  return {
    id: id || content.slice(0, 40),
    content: content || id,
    status: TODO_STATUSES.has(status) ? status : 'pending',
  };
}

function normalizeSessionEntry(raw) {
  const todos = Array.isArray(raw?.todos)
    ? raw.todos.map(normalizeTodo).filter(Boolean)
    : [];
  if (!todos.length) return null;
  return {
    todos,
    updatedAtWall: Number.isFinite(raw?.updatedAtWall) ? raw.updatedAtWall : null,
  };
}

/**
 * Load per-session task lists.
 * @returns {Record<string, { todos: object[], updatedAtWall: number|null }>}
 */
export function loadTasks(dir) {
  if (!dir) return {};
  const raw = readJsonSafe(tasksFilePath(dir));
  if (!raw || typeof raw !== 'object') return {};

  // v2: per-session map
  if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
    /** @type {Record<string, { todos: object[], updatedAtWall: number|null }>} */
    const out = {};
    for (const [key, entry] of Object.entries(raw.sessions)) {
      const qk = String(key || '').trim();
      if (!qk) continue;
      const normalized = normalizeSessionEntry(entry);
      if (normalized) out[qk] = normalized;
    }
    return out;
  }

  // v1 workspace-shared list — do not re-apply across sessions.
  return {};
}

/**
 * Atomically rewrite the task sidecar from a per-session map.
 * Empty state removes the file.
 * @param {Record<string, { todos?: object[], updatedAtWall?: number|null }>} sessions
 * @returns {string|null}
 */
export function saveTasks(dir, sessions) {
  if (!dir) return null;
  const path = tasksFilePath(dir);
  /** @type {Record<string, { updatedAtWall: number, todos: object[] }>} */
  const bodySessions = {};
  for (const [key, entry] of Object.entries(sessions || {})) {
    const qk = String(key || '').trim();
    if (!qk) continue;
    const normalized = normalizeSessionEntry(entry);
    if (!normalized) continue;
    bodySessions[qk] = {
      updatedAtWall: normalized.updatedAtWall ?? Date.now(),
      todos: normalized.todos,
    };
  }
  if (!Object.keys(bodySessions).length) {
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
    return null;
  }
  atomicWriteFile(path, `${JSON.stringify({ version: 2, sessions: bodySessions }, null, 2)}\n`);
  return path;
}
