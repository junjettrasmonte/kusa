/**
 * Workspace file content for the console editor (GET/PUT /file).
 * Paths stay under workspaceRoot via the same sandbox as agent file tools.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveWorkspacePath } from '#features/agent/files.mjs';
import { bumpWorkspaceTreeRev } from '#features/explorer/tree-rev.mjs';

/** Match agent read/write caps so the console cannot open what tools refuse. */
export const MAX_FILE_READ_BYTES = 512 * 1024;
export const MAX_FILE_WRITE_BYTES = 1024 * 1024;

/**
 * Read one UTF-8 workspace file for the editor.
 * @param {string} workspaceRoot
 * @param {string} inputPath workspace-relative path
 * @returns {{ ok: true, path: string, bytes: number, content: string }
 *   | { ok: false, error: string, code?: string }}
 */
export function readWorkspaceFile(workspaceRoot, inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw || raw === '.') {
    return { ok: false, error: 'path is required', code: 'EINVAL' };
  }

  let target;
  try {
    target = resolveWorkspacePath(workspaceRoot, raw);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || 'EPERM' };
  }

  if (!existsSync(target.abs)) {
    return { ok: false, error: `not found: ${target.rel}`, code: 'ENOENT' };
  }

  let st;
  try {
    st = statSync(target.abs);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || 'EIO' };
  }
  if (!st.isFile()) {
    return { ok: false, error: `not a file: ${target.rel}`, code: 'EISDIR' };
  }
  if (st.size > MAX_FILE_READ_BYTES) {
    return {
      ok: false,
      error: `file too large (${st.size} bytes; max ${MAX_FILE_READ_BYTES})`,
      code: 'ELARGE',
    };
  }

  let buf;
  try {
    buf = readFileSync(target.abs);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || 'EIO' };
  }
  if (buf.includes(0)) {
    return { ok: false, error: `binary file: ${target.rel}`, code: 'EBINARY' };
  }

  return {
    ok: true,
    path: target.rel,
    bytes: buf.length,
    content: buf.toString('utf8'),
  };
}

/**
 * Create or overwrite one UTF-8 workspace file from the editor.
 * @param {string} workspaceRoot
 * @param {string} inputPath
 * @param {string} contents
 */
export function writeWorkspaceFile(workspaceRoot, inputPath, contents) {
  const raw = String(inputPath || '').trim();
  if (!raw || raw === '.') {
    return { ok: false, error: 'path is required', code: 'EINVAL' };
  }
  const text = contents == null ? '' : String(contents);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_FILE_WRITE_BYTES) {
    return {
      ok: false,
      error: `contents too large (${bytes} bytes; max ${MAX_FILE_WRITE_BYTES})`,
      code: 'ELARGE',
    };
  }

  let target;
  try {
    target = resolveWorkspacePath(workspaceRoot, raw);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || 'EPERM' };
  }

  const created = !existsSync(target.abs);
  if (!created) {
    let st;
    try {
      st = statSync(target.abs);
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EIO' };
    }
    if (!st.isFile()) {
      return { ok: false, error: `not a file: ${target.rel}`, code: 'EISDIR' };
    }
  }

  try {
    mkdirSync(dirname(target.abs), { recursive: true });
    writeFileSync(target.abs, text, 'utf8');
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || 'EIO' };
  }

  // Overwrites leave the tree shape alone; new paths need an Explorer refresh.
  if (created) bumpWorkspaceTreeRev('create');

  return { ok: true, path: target.rel, bytes, created };
}
