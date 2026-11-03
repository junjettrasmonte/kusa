/**
 * Composer queue persistence.
 *
 * Held (unparked) prompts and steering live per session in
 * `.kusa/sessions/<stem>/queues.json` — only that chat can flush or send them.
 * Parked prompts live under {@link WORKSPACE_QUEUE_KEY} in the shared
 * `.kusa/queues.json` so any session can resume or send them.
 *
 * Legacy all-session maps in `.kusa/kusa/queues.json` (or a root map) are split
 * on the next load/save: per-session keys move into session folders; only parked
 * rows stay in `.kusa/queues.json`.
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
import { parseSessionKey } from './task-store.mjs';
import { normalizeAttachments } from './attachments.mjs';

export const QUEUES_FILE = 'queues.json';
/** Well-known key for the workspace-shared parked list. */
export const WORKSPACE_QUEUE_KEY = 'kusa:workspace';
/** Legacy harness folder that held the shared parked list before sessions/. */
const LEGACY_SHARED_QUEUES_HARNESS = 'kusa';

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

function deletePath(path) {
  if (!path || !existsSync(path)) return;
  try { unlinkSync(path); } catch { /* ignore */ }
}

/**
 * Absolute path for queue persistence.
 * @param {string} dir data dir
 * @param {string} [sessionKey] `harness:id` for a session file; omit or pass
 *   {@link WORKSPACE_QUEUE_KEY} for the shared parked list (also the legacy
 *   all-session path used during migration).
 */
export function queuesFilePath(dir, sessionKey) {
  if (!dir) return '';
  const key = String(sessionKey || '').trim();
  if (!key || key === WORKSPACE_QUEUE_KEY) {
    return join(dir, QUEUES_FILE);
  }
  const parsed = parseSessionKey(key);
  if (!parsed) return join(dir, QUEUES_FILE);
  const files = migrateFlatSessionFiles(dir, parsed);
  return files.queues;
}

function normalizeOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: '', model: '', approvalMode: '' };
  }
  const out = {
    mode: String(raw.mode || ''),
    model: String(raw.model || ''),
    approvalMode: String(raw.approvalMode || ''),
  };
  // A held prompt carries its files: flushing it later must attach the same
  // ones the user staged when the queue swallowed the Send.
  const attachments = normalizeAttachments(raw.attachments);
  if (attachments.length) out.attachments = attachments;
  return out;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').trim();
  const id = String(raw.id || '').trim();
  if (!text || !id) return null;
  const entry = {
    id,
    text,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    options: normalizeOptions(raw.options),
  };
  if (raw.paused === true) entry.paused = true;
  return entry;
}

function normalizeList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeEntry).filter(Boolean);
}

function entriesEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.id !== right.id || left.text !== right.text || Boolean(left.paused) !== Boolean(right.paused)) {
      return false;
    }
  }
  return true;
}

function writeSessionQueuesFile(path, queued, steering, sessionKey = '') {
  const body = {
    version: 1,
    queued: queued || [],
    steering: steering || [],
  };
  const key = String(sessionKey || '').trim();
  if (key) body.key = key;
  atomicWriteFile(path, `${JSON.stringify(body, null, 2)}\n`);
}

function writeSharedParkedFile(path, parked) {
  atomicWriteFile(path, `${JSON.stringify({
    version: 1,
    queued: parked || [],
  }, null, 2)}\n`);
}

/** Resolve the lane key for a session folder (harness is not in the path). */
function sessionKeyForFolder(sessionFolder, stem) {
  const lane = readJsonSafe(join(sessionFolder, `${stem}.json`));
  if (lane?.key && typeof lane.key === 'string') return lane.key;
  if (lane?.id && lane?.harness) return laneKey(lane.harness, lane.id);

  const chat = readJsonSafe(join(sessionFolder, `${stem}.chat.json`));
  if (chat?.key && typeof chat.key === 'string') return chat.key;
  if (chat?.id && chat?.harness) return laneKey(chat.harness, chat.id);

  const queues = readJsonSafe(join(sessionFolder, QUEUES_FILE));
  if (queues?.key && typeof queues.key === 'string') return queues.key;

  if (lane?.id) return laneKey('kusa', lane.id);
  if (chat?.id) return laneKey('kusa', chat.id);
  return laneKey('kusa', stem);
}

/**
 * Split a legacy all-session `kusa/queues.json` (or root `queues.json` map) into
 * per-session files, rewrite the shared file with parked rows only. Idempotent.
 */
function migrateLegacySharedQueues(dir) {
  if (!dir) return;
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  const sharedPath = join(dir, QUEUES_FILE);
  const legacyPath = join(dir, LEGACY_SHARED_QUEUES_HARNESS, QUEUES_FILE);
  const candidates = [sharedPath, legacyPath].filter((path, index, all) => (
    existsSync(path) && all.indexOf(path) === index
  ));
  for (const path of candidates) {
    const raw = readJsonSafe(path);
    if (!raw || typeof raw !== 'object') {
      if (path !== sharedPath) deletePath(path);
      continue;
    }

    const queuedObj = raw.queued && typeof raw.queued === 'object' && !Array.isArray(raw.queued)
      ? raw.queued
      : null;
    // Already the parked-only shape (`queued` is an array) — hoist to root if needed.
    if (!queuedObj) {
      if (path !== sharedPath && Array.isArray(raw.queued) && raw.queued.length && !existsSync(sharedPath)) {
        try { renameSync(path, sharedPath); } catch { /* ignore */ }
      } else if (path !== sharedPath && (!Array.isArray(raw.queued) || !raw.queued.length)) {
        deletePath(path);
      }
      continue;
    }

    const steeringObj = raw.steering && typeof raw.steering === 'object' && !Array.isArray(raw.steering)
      ? raw.steering
      : {};

    let parked = normalizeList(queuedObj[WORKSPACE_QUEUE_KEY]);
    for (const [key, list] of Object.entries(queuedObj)) {
      const qk = String(key || '').trim();
      if (!qk || qk === WORKSPACE_QUEUE_KEY) continue;
      const entries = normalizeList(list);
      const steering = normalizeList(steeringObj[qk]);
      if (!entries.length && !steering.length) continue;
      const sessionPath = queuesFilePath(dir, qk);
      if (!sessionPath || sessionPath === path || sessionPath === sharedPath) continue;
      if (existsSync(sessionPath)) continue;
      writeSessionQueuesFile(sessionPath, entries, steering, qk);
    }

    parked = parked.map((entry) => (entry?.paused ? entry : { ...entry, paused: true }));
    if (parked.length) writeSharedParkedFile(sharedPath, parked);
    else deletePath(sharedPath);
    if (path !== sharedPath) deletePath(path);
  }
}

/**
 * Load queues from disk into Maps.
 *
 * - Per-session files hold that chat's held + steering.
 * - Shared `queues.json` holds parked rows only.
 * - Steering is folded into that session's held list on boot (turn jobs are not
 *   persisted).
 * - {@link WORKSPACE_QUEUE_KEY} keeps only parked entries.
 *
 * @returns {{ queued: Map<string, object[]>, steering: Map<string, object[]> }}
 */
export function loadQueues(dir) {
  const queued = new Map();
  const steering = new Map();
  if (!dir) return { queued, steering };

  migrateLegacySharedQueues(dir);

  const root = sessionsRoot(dir);
  let children = [];
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch {
    children = [];
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const stem = child.name;
    const sessionFolder = join(root, stem);
    const path = join(sessionFolder, QUEUES_FILE);
    if (!existsSync(path)) continue;
    const raw = readJsonSafe(path);
    const held = normalizeList(raw?.queued);
    const steer = normalizeList(raw?.steering);
    if (!held.length && !steer.length) continue;
    const key = sessionKeyForFolder(sessionFolder, stem);
    if (held.length) queued.set(key, held);
    if (steer.length) steering.set(key, steer);
  }

  // Shared parked list (array shape after migration).
  const sharedPath = queuesFilePath(dir);
  const sharedRaw = readJsonSafe(sharedPath);
  if (sharedRaw) {
    let parked = [];
    if (Array.isArray(sharedRaw.queued)) {
      parked = normalizeList(sharedRaw.queued);
    } else if (sharedRaw.queued && typeof sharedRaw.queued === 'object') {
      // Race: another process wrote a legacy map; take workspace rows only.
      parked = normalizeList(sharedRaw.queued[WORKSPACE_QUEUE_KEY]);
    }
    if (parked.length) queued.set(WORKSPACE_QUEUE_KEY, parked);
  }

  let dirty = false;
  for (const [qk, list] of [...steering.entries()]) {
    const entries = normalizeList(list);
    if (!entries.length) {
      steering.delete(qk);
      continue;
    }
    // Fold into that session's held — steering dies with the process.
    const held = queued.get(qk) || [];
    held.push(...entries.map((entry) => {
      const next = { ...entry };
      delete next.paused;
      return next;
    }));
    queued.set(qk, held);
    steering.delete(qk);
    dirty = true;
  }

  // Workspace key is parked-only. Legacy unpaused rows there were the old
  // shared held list — park them so a cold boot does not invent a session owner.
  const workspace = queued.get(WORKSPACE_QUEUE_KEY) || [];
  if (workspace.length) {
    const parked = workspace.map((entry) => (
      entry?.paused ? entry : { ...entry, paused: true }
    ));
    if (!entriesEqual(workspace, parked)) {
      queued.set(WORKSPACE_QUEUE_KEY, parked);
      dirty = true;
    }
  }

  // Rewrite immediately so a second boot does not fold steering twice.
  if (dirty) {
    try {
      saveQueues(dir, queued, steering);
    } catch {
      /* ignore — in-memory view is still correct for this process */
    }
  }

  return { queued, steering };
}

/**
 * Atomically rewrite queues from the in-memory Maps.
 * Session keys land in that session's folder; parked rows stay in the shared
 * file. Empty lists drop their files so a fresh dataDir stays clean.
 */
export function saveQueues(dir, queuedMessages, steeringMessages) {
  if (!dir) return null;
  migrateLegacySharedQueues(dir);

  const queuedMap = queuedMessages instanceof Map ? queuedMessages : new Map();
  const steeringMap = steeringMessages instanceof Map ? steeringMessages : new Map();

  /** @type {Map<string, { queued: object[], steering: object[] }>} */
  const desired = new Map();
  for (const [key, list] of queuedMap) {
    const qk = String(key || '').trim();
    if (!qk) continue;
    const entries = normalizeList(list);
    if (!entries.length && qk !== WORKSPACE_QUEUE_KEY) continue;
    const prev = desired.get(qk) || { queued: [], steering: [] };
    prev.queued = entries;
    desired.set(qk, prev);
  }
  for (const [key, list] of steeringMap) {
    const qk = String(key || '').trim();
    if (!qk || qk === WORKSPACE_QUEUE_KEY) continue;
    const entries = normalizeList(list);
    if (!entries.length) continue;
    const prev = desired.get(qk) || { queued: [], steering: [] };
    prev.steering = entries;
    desired.set(qk, prev);
  }

  // Drop empty session entries (nothing to keep on disk).
  for (const [qk, entry] of [...desired.entries()]) {
    if (qk === WORKSPACE_QUEUE_KEY) continue;
    if (!entry.queued.length && !entry.steering.length) desired.delete(qk);
  }

  const existing = loadQueuesForSaveScan(dir);
  const allKeys = new Set([...existing, ...desired.keys()]);
  let lastPath = null;

  for (const key of allKeys) {
    const path = queuesFilePath(dir, key);
    if (!path) continue;
    const entry = desired.get(key);
    if (key === WORKSPACE_QUEUE_KEY) {
      const parked = (entry?.queued || []).map((row) => (
        row?.paused ? row : { ...row, paused: true }
      ));
      if (!parked.length) {
        deletePath(path);
        continue;
      }
      writeSharedParkedFile(path, parked);
      lastPath = path;
      continue;
    }
    if (!entry) {
      deletePath(path);
      continue;
    }
    writeSessionQueuesFile(path, entry.queued, entry.steering, key);
    lastPath = path;
  }
  return lastPath;
}

/**
 * Keys that already have a queues.json on disk (session folders + shared parked).
 * Used by save to know which empties to delete without a full normalize pass.
 * @returns {Set<string>}
 */
function loadQueuesForSaveScan(dir) {
  const keys = new Set();
  if (!dir) return keys;
  const sharedPath = queuesFilePath(dir);
  if (existsSync(sharedPath)) keys.add(WORKSPACE_QUEUE_KEY);

  const root = sessionsRoot(dir);
  let children = [];
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch {
    return keys;
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const stem = child.name;
    const sessionFolder = join(root, stem);
    if (!existsSync(join(sessionFolder, QUEUES_FILE))) continue;
    keys.add(sessionKeyForFolder(sessionFolder, stem));
  }
  return keys;
}
