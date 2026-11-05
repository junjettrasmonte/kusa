/**
 * File-backed run markers + in-process MemorySaver for plan-execute.
 *
 * LangGraph checkpoints stay in MemorySaver for interrupt/resume within a
 * serve process. Under `{dataDir}/workflows/runs/` we also write a small JSON
 * marker so Approve/Continue after a restart can fall back to the direct
 * `continueWorkflowAfterPlanApproval` path when the in-memory thread is gone.
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
import { MemorySaver } from '@langchain/langgraph';

const RUNS_DIR = 'runs';

export function workflowRunsRoot(dataDir) {
  return join(String(dataDir || ''), 'workflows', RUNS_DIR);
}

function safeThreadFileName(threadId) {
  return String(threadId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .slice(0, 200) || 'thread';
}

export function runMarkerPath(dataDir, threadId) {
  return join(workflowRunsRoot(dataDir), `${safeThreadFileName(threadId)}.json`);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * @param {string} dataDir
 * @param {string} threadId
 * @param {object} marker
 */
export function writeRunMarker(dataDir, threadId, marker) {
  if (!dataDir || !threadId) return;
  mkdirSync(workflowRunsRoot(dataDir), { recursive: true });
  atomicWriteJson(runMarkerPath(dataDir, threadId), {
    ...marker,
    threadId: String(threadId),
    updatedAt: Date.now(),
  });
}

/**
 * @param {string} dataDir
 * @param {string} threadId
 * @returns {object | null}
 */
export function readRunMarker(dataDir, threadId) {
  if (!dataDir || !threadId) return null;
  const path = runMarkerPath(dataDir, threadId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dataDir
 * @param {string} threadId
 */
export function deleteRunMarker(dataDir, threadId) {
  if (!dataDir || !threadId) return;
  const path = runMarkerPath(dataDir, threadId);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

/** True when a durable run marker exists (survives serve restart). */
export function hasRunMarker(dataDir, threadId) {
  return Boolean(readRunMarker(dataDir, threadId));
}

/**
 * Per-dataDir MemorySaver cache so interrupt/resume shares one store for
 * the lifetime of the Node process.
 * @type {Map<string, MemorySaver>}
 */
const saversByDataDir = new Map();

/**
 * @param {string} [dataDir]
 * @returns {MemorySaver}
 */
export function getMemorySaver(dataDir = '') {
  const key = String(dataDir || '') || ':memory:';
  let saver = saversByDataDir.get(key);
  if (!saver) {
    saver = new MemorySaver();
    saversByDataDir.set(key, saver);
  }
  return saver;
}

/** Test helper — drop cached savers. */
export function resetMemorySavers() {
  saversByDataDir.clear();
}
