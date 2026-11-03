/**
 * Per-session task lists under `.kusa/sessions/<stem>/tasks.json`.
 *
 * Plan/todo rows from TodoWrite stay tied to the session that wrote them (held
 * prompts sit beside them in `queues.json`; parked prompts stay workspace-shared).
 * Each session folder owns its Task List the same way it owns its chat transcript
 * and attachments, so deleting the session folder drops the list with it.
 *
 * Shape (per file):
 *   { version: 1, updatedAtWall, todos: [...] }
 *
 * Legacy shared `.kusa/kusa/tasks.json` (or `.kusa/tasks.json`) v2
 * (`{ version: 2, sessions: {…} }`) is split into per-session files on the next
 * load/save, then removed.
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
  migrateHarnessSessionsToShared,
  sessionsRoot,
} from '#features/monitor/lib.mjs';

export const TASKS_FILE = 'tasks.json';
/** Legacy harness folder that held the shared tasks.json before sessions/. */
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
  if (!parsed) return join(dir, TASKS_FILE);
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

function writeSessionTasksFile(path, entry, sessionKey = '') {
  const body = {
    version: 1,
    updatedAtWall: entry.updatedAtWall ?? Date.now(),
    todos: entry.todos,
  };
  // Shared sessions/ folder has no harness in the path — keep the lane key here
  // so a tasks-only folder still reloads under the right harness:id.
  const key = String(sessionKey || entry.key || '').trim();
  if (key) body.key = key;
  atomicWriteFile(path, `${JSON.stringify(body, null, 2)}\n`);
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
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  const sharedPath = join(dir, TASKS_FILE);
  const legacyPath = join(dir, LEGACY_TASKS_HARNESS, TASKS_FILE);
  for (const path of [sharedPath, legacyPath]) {
    if (!existsSync(path)) continue;
    const raw = readJsonSafe(path);
    if (!raw || typeof raw !== 'object') {
      deletePath(path);
      continue;
    }
    if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
      for (const [key, entry] of Object.entries(raw.sessions)) {
        const normalized = normalizeSessionEntry(entry);
        if (!normalized) continue;
        const sessionPath = tasksFilePath(dir, key);
        if (!sessionPath || sessionPath === path || sessionPath === sharedPath) continue;
        if (existsSync(sessionPath)) continue;
        writeSessionTasksFile(sessionPath, normalized, key);
      }
    }
    deletePath(path);
  }
}

/**
 * Resolve the lane key for a session folder. Prefer an explicit key on the lane,
 * chat, or tasks sidecar — the shared `sessions/` tree no longer encodes harness
 * in the path.
 */
function sessionKeyForFolder(sessionFolder, stem) {
  const lane = readJsonSafe(join(sessionFolder, 'lane.json'))
    || readJsonSafe(join(sessionFolder, `${stem}.json`));
  if (lane?.key && typeof lane.key === 'string') return lane.key;
  if (lane?.id && lane?.harness) return laneKey(lane.harness, lane.id);

  const chat = readJsonSafe(join(sessionFolder, 'chat.json'))
    || readJsonSafe(join(sessionFolder, `${stem}.chat.json`));
  if (chat?.key && typeof chat.key === 'string') return chat.key;
  if (chat?.id && chat?.harness) return laneKey(chat.harness, chat.id);

  const tasks = readJsonSafe(join(sessionFolder, TASKS_FILE));
  if (tasks?.key && typeof tasks.key === 'string') return tasks.key;

  if (lane?.id) return laneKey('kusa', lane.id);
  if (chat?.id) return laneKey('kusa', chat.id);
  return laneKey('kusa', stem);
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
  const root = sessionsRoot(dir);
  let children = [];
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const stem = child.name;
    const sessionFolder = join(root, stem);
    const path = join(sessionFolder, TASKS_FILE);
    if (!existsSync(path)) continue;
    const raw = readJsonSafe(path);
    const normalized = normalizeSessionEntry(raw);
    if (!normalized) continue;
    const key = sessionKeyForFolder(sessionFolder, stem);
    out[key] = normalized;
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
    writeSessionTasksFile(path, entry, key);
    lastPath = path;
  }
  return lastPath;
}
