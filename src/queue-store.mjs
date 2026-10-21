/**
 * Composer queue persistence under `.kusa/kusa/queues.json`.
 *
 * Held (unparked) prompts are per-session — only the chat that queued them
 * can flush or send them. Parked prompts live under {@link WORKSPACE_QUEUE_KEY}
 * so any session can resume or send them. Steering ("send now") stays
 * per-session because it is tied to that session's running turn.
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

export const QUEUES_FILE = 'queues.json';
/** Well-known key for the workspace-shared parked list. */
export const WORKSPACE_QUEUE_KEY = 'kusa:workspace';

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

/** Absolute path for the shared queue sidecar. */
export function queuesFilePath(dir) {
  return join(dir, KUSA_HARNESS, QUEUES_FILE);
}

function normalizeOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: '', model: '', approvalMode: '' };
  }
  return {
    mode: String(raw.mode || ''),
    model: String(raw.model || ''),
    approvalMode: String(raw.approvalMode || ''),
  };
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

function mapToObject(map) {
  /** @type {Record<string, unknown[]>} */
  const out = {};
  for (const [key, list] of map) {
    if (!key || !Array.isArray(list) || !list.length) continue;
    out[key] = list;
  }
  return out;
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

/**
 * Load queues from disk into Maps.
 *
 * - Steering is folded into that session's held list on boot (turn jobs are not
 *   persisted).
 * - {@link WORKSPACE_QUEUE_KEY} keeps only parked entries. Unpaused leftovers
 *   from the old shared-held model are parked so they remain claimable from
 *   any session.
 * - Per-session keys keep unparked held prompts session-bound.
 *
 * @returns {{ queued: Map<string, object[]>, steering: Map<string, object[]> }}
 */
export function loadQueues(dir) {
  const queued = new Map();
  const steering = new Map();
  if (!dir) return { queued, steering };

  const raw = readJsonSafe(queuesFilePath(dir));
  const queuedObj = raw?.queued && typeof raw.queued === 'object' && !Array.isArray(raw.queued)
    ? raw.queued
    : {};
  const steeringObj = raw?.steering && typeof raw.steering === 'object' && !Array.isArray(raw.steering)
    ? raw.steering
    : {};

  for (const [key, list] of Object.entries(queuedObj)) {
    const qk = String(key || '').trim();
    if (!qk) continue;
    const entries = normalizeList(list);
    if (entries.length) queued.set(qk, entries);
  }

  let dirty = false;
  for (const [key, list] of Object.entries(steeringObj)) {
    const qk = String(key || '').trim();
    if (!qk) continue;
    const entries = normalizeList(list);
    if (!entries.length) continue;
    // Fold into that session's held — steering dies with the process.
    const held = queued.get(qk) || [];
    held.push(...entries.map((entry) => {
      const next = { ...entry };
      delete next.paused;
      return next;
    }));
    queued.set(qk, held);
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
 * Atomically rewrite the queue sidecar from the in-memory Maps.
 * Empty state removes the file so a fresh dataDir stays clean.
 */
export function saveQueues(dir, queuedMessages, steeringMessages) {
  if (!dir) return null;
  const path = queuesFilePath(dir);
  const queued = mapToObject(queuedMessages instanceof Map ? queuedMessages : new Map());
  const steering = mapToObject(steeringMessages instanceof Map ? steeringMessages : new Map());
  const empty = !Object.keys(queued).length && !Object.keys(steering).length;
  if (empty) {
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
    return null;
  }
  const body = {
    version: 1,
    queued,
    steering,
  };
  atomicWriteFile(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}
