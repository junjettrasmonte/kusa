/**
 * Per-session task lists under `.kusa/<harness>/<stem>/tasks.json`.
 *
 * Plan/todo rows from TodoWrite stay tied to the session that wrote them (unlike
 * the workspace-shared prompt queue). Each session folder owns its Task List
 * the same way it owns its chat transcript and attachments, so deleting the
 * session folder drops the list with it.
 *
 * Shape (per file):
 *   { version: 1, updatedAtWall, todos: [...] }
 *
 * Legacy shared `.kusa/kusa/tasks.json` v2 (`{ version: 2, sessions: {…} }`) is
 * split into per-session files on the next load/save, then removed.
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
import { dirname, join } from 'node:path';
import {
  laneKey,
  migrateFlatSessionFiles,
} from '#features/monitor/lib.mjs';

export const TASKS_FILE = 'tasks.json';
/** Harness folder that held the legacy shared tasks.json. */
const LEGACY_TASKS_HARNESS = 'kusa';

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

/** Split `harness:id` → `{ harness, id }`. Null when the key is not usable. */
export function parseSessionKey(sessionKey) {
  const text = String(sessionKey || '').trim();
  const idx = text.indexOf(':');
  if (idx <= 0 || idx >= text.length - 1) return null;
  return {
    harness: text.slice(0, idx),
    id: text.slice(idx + 1),
  };
}

/**
 * Absolute path for one session's task-list file.
 * @param {string} dir data dir
 * @param {string} [sessionKey] `harness:id` — required for the folder layout.
 *   Calling with only `dir` returns the legacy shared path (for migration /
 *   tests that still mention it).
 */
export function tasksFilePath(dir, sessionKey) {
  if (!dir) return '';
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return join(dir, LEGACY_TASKS_HARNESS, TASKS_FILE);
  const files = migrateFlatSessionFiles(dir, parsed);
  return files.tasks;
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

function writeSessionTasksFile(path, entry) {
  atomicWriteFile(path, `${JSON.stringify({
    version: 1,
    updatedAtWall: entry.updatedAtWall ?? Date.now(),
    todos: entry.todos,
  }, null, 2)}\n`);
}

function deletePath(path) {
  if (!path || !existsSync(path)) return;
  try { unlinkSync(path); } catch { /* ignore */ }
}

/**
 * Split the legacy shared `kusa/tasks.json` into per-session files, then remove
 * the shared file. Idempotent.
 */
function migrateLegacySharedTasks(dir) {
  if (!dir) return;
  const legacyPath = join(dir, LEGACY_TASKS_HARNESS, TASKS_FILE);
  if (!existsSync(legacyPath)) return;
  const raw = readJsonSafe(legacyPath);
  if (!raw || typeof raw !== 'object') {
    deletePath(legacyPath);
    return;
  }
  if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
    for (const [key, entry] of Object.entries(raw.sessions)) {
      const normalized = normalizeSessionEntry(entry);
      if (!normalized) continue;
      const path = tasksFilePath(dir, key);
      if (!path || path === legacyPath) continue;
      // Prefer a file already in the session folder (newer layout wins).
      if (existsSync(path)) continue;
      writeSessionTasksFile(path, normalized);
    }
  }
  deletePath(legacyPath);
}

/**
 * Resolve the lane key for a session folder from its lane JSON when present,
 * otherwise from the harness name + folder stem.
 */
function sessionKeyForFolder(harnessName, sessionFolder, stem) {
  const lanePath = join(sessionFolder, `${stem}.json`);
  const lane = readJsonSafe(lanePath);
  if (lane?.key && typeof lane.key === 'string') return lane.key;
  if (lane?.id && lane?.harness) return laneKey(lane.harness, lane.id);
  if (lane?.id) return laneKey(harnessName, lane.id);
  return laneKey(harnessName, stem);
}

/**
 * Load per-session task lists from each session folder.
 * @returns {Record<string, { todos: object[], updatedAtWall: number|null }>}
 */
export function loadTasks(dir) {
  if (!dir) return {};
  migrateLegacySharedTasks(dir);

  /** @type {Record<string, { todos: object[], updatedAtWall: number|null }>} */
  const out = {};
  let harnessEntries = [];
  try {
    harnessEntries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const harnessEntry of harnessEntries) {
    if (!harnessEntry.isDirectory() || harnessEntry.name.startsWith('.')) continue;
    const harnessFolder = join(dir, harnessEntry.name);
    let children = [];
    try {
      children = readdirSync(harnessFolder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const stem = child.name;
      const sessionFolder = join(harnessFolder, stem);
      const path = join(sessionFolder, TASKS_FILE);
      if (!existsSync(path)) continue;
      const raw = readJsonSafe(path);
      const normalized = normalizeSessionEntry(raw);
      if (!normalized) continue;
      const key = sessionKeyForFolder(harnessEntry.name, sessionFolder, stem);
      out[key] = normalized;
    }
  }
  return out;
}

/**
 * Atomically rewrite task lists from a per-session map.
 * Each key lands in that session's folder; keys missing from the map (or empty)
 * drop their file. The return value is the path of the last file written, or
 * null when nothing remains on disk.
 * @param {Record<string, { todos?: object[], updatedAtWall?: number|null }>} sessions
 * @returns {string|null}
 */
export function saveTasks(dir, sessions) {
  if (!dir) return null;
  migrateLegacySharedTasks(dir);

  /** @type {Record<string, { updatedAtWall: number, todos: object[] }>} */
  const desired = {};
  for (const [key, entry] of Object.entries(sessions || {})) {
    const qk = String(key || '').trim();
    if (!qk) continue;
    const normalized = normalizeSessionEntry(entry);
    if (!normalized) continue;
    desired[qk] = {
      updatedAtWall: normalized.updatedAtWall ?? Date.now(),
      todos: normalized.todos,
    };
  }

  const existing = loadTasks(dir);
  const allKeys = new Set([...Object.keys(existing), ...Object.keys(desired)]);
  let lastPath = null;
  for (const key of allKeys) {
    const path = tasksFilePath(dir, key);
    if (!path) continue;
    const entry = desired[key];
    if (!entry) {
      deletePath(path);
      continue;
    }
    writeSessionTasksFile(path, entry);
    lastPath = path;
  }
  return lastPath;
}
