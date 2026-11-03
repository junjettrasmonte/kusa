/**
 * Read Cursor UI chat titles from the IDE's global state.vscdb.
 *
 * Cursor stores generated (and renamed) session titles in the
 * `composerHeaders` table as JSON `{ composerId, name, ... }`. Kusă session
 * ids for the cursor harness are the same composer ids, so we can overlay
 * those names onto sidebar rows once Cursor invents them.
 *
 * On WSL the live DB often rejects ordinary `mode=ro` opens (9p I/O); we fall
 * back to `immutable=1`, which skips the WAL but still picks up titles after
 * Cursor checkpoints — good enough for "when they show up".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Keep in sync with chat-store TITLE_MAX_CHARS (avoid importing chat-store). */
const TITLE_MAX_CHARS = 72;
const CACHE_TTL_MS = 2_000;

/** @type {{ key: string, at: number, titles: Map<string, string> } | null} */
let cache = null;
/** @type {string | null | undefined} */
let resolvedDbPath;

function clampTitle(raw) {
  if (typeof raw !== 'string') return null;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  // Cursor's empty / placeholder labels are not useful in the sidebar.
  if (/^new chat$/i.test(oneLine)) return null;
  return oneLine.length <= TITLE_MAX_CHARS
    ? oneLine
    : `${oneLine.slice(0, TITLE_MAX_CHARS - 1).trim()}…`;
}

function windowsPathToWsl(winPath) {
  const cleaned = String(winPath || '').trim().replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(cleaned);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
}

function windowsAppDataDir() {
  const fromEnv = String(process.env.APPDATA || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const result = spawnSync('cmd.exe', ['/c', 'echo %APPDATA%'], {
      encoding: 'utf8',
      timeout: 4_000,
      windowsHide: true,
    });
    const line = String(result.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    return line || '';
  } catch {
    return '';
  }
}

function listWindowsUserCursorDirs() {
  const out = [];
  const usersRoot = '/mnt/c/Users';
  if (!existsSync(usersRoot)) return out;
  let names = [];
  try { names = readdirSync(usersRoot); } catch { return out; }
  for (const name of names) {
    if (name === 'Public' || name === 'Default' || name === 'Default User' || name === 'All Users') {
      continue;
    }
    out.push(join(usersRoot, name, 'AppData', 'Roaming', 'Cursor', 'User'));
  }
  return out;
}

/**
 * Absolute path to Cursor's global `state.vscdb`, or null when not found.
 * @param {{ force?: boolean }} [opts]
 */
export function resolveCursorStateDb(opts = {}) {
  if (!opts.force && resolvedDbPath !== undefined) return resolvedDbPath;

  const override = String(process.env.CURSOR_STATE_VSCDB || '').trim();
  if (override && existsSync(override)) {
    resolvedDbPath = override;
    return resolvedDbPath;
  }

  /** @type {string[]} */
  const candidates = [];
  const pushUser = (userDir) => {
    const path = String(userDir || '').trim();
    if (path) candidates.push(join(path, 'globalStorage', 'state.vscdb'));
  };

  pushUser(process.env.CURSOR_USER_DATA_DIR);
  pushUser(join(homedir(), '.config', 'Cursor', 'User'));
  pushUser(join(homedir(), 'Library', 'Application Support', 'Cursor', 'User'));

  const appData = windowsAppDataDir();
  if (appData) {
    const wsl = windowsPathToWsl(appData);
    if (wsl) pushUser(join(wsl, 'Cursor', 'User'));
    if (platform() === 'win32') pushUser(join(appData, 'Cursor', 'User'));
  }
  for (const dir of listWindowsUserCursorDirs()) pushUser(dir);

  for (const path of candidates) {
    if (existsSync(path)) {
      resolvedDbPath = path;
      return resolvedDbPath;
    }
  }
  resolvedDbPath = null;
  return null;
}

function dbCacheKey(dbPath) {
  let mtime = 0;
  let walMtime = 0;
  try { mtime = statSync(dbPath).mtimeMs || 0; } catch { /* ignore */ }
  try { walMtime = statSync(`${dbPath}-wal`).mtimeMs || 0; } catch { /* ignore */ }
  return `${dbPath}:${mtime}:${walMtime}`;
}

function openCursorDbCandidates(dbPath) {
  // Prefer WAL-aware read; fall back to immutable for WSL 9p / locked mounts.
  // Opening can succeed while the first query still throws (9p I/O), so callers
  // must probe with a real SELECT before accepting a connection.
  return [
    () => new DatabaseSync(dbPath, { readOnly: true }),
    () => new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true }),
  ];
}

function readTitlesFromDb(dbPath) {
  const titles = new Map();
  for (const open of openCursorDbCandidates(dbPath)) {
    let db;
    try {
      db = open();
      // Probe: a successful open is not enough on WSL mounts.
      db.prepare('SELECT 1 AS ok FROM composerHeaders LIMIT 1').get();
    } catch {
      try { db?.close(); } catch { /* ignore */ }
      continue;
    }
    try {
      const rows = db.prepare(
        'SELECT composerId, value FROM composerHeaders',
      ).all();
      for (const row of rows || []) {
        const id = String(row?.composerId || '').trim();
        if (!id) continue;
        let name = '';
        const raw = row?.value;
        if (typeof raw === 'string' && raw.trim()) {
          try {
            const parsed = JSON.parse(raw);
            name = typeof parsed?.name === 'string' ? parsed.name : '';
          } catch { /* ignore */ }
        }
        const title = clampTitle(name);
        if (title) titles.set(id, title);
      }
      return titles;
    } catch {
      /* try next open mode */
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
  return titles;
}

/**
 * Map of composerId → title from Cursor's UI metadata.
 * Cached briefly and invalidated when the DB (or WAL) mtime changes so a
 * freshly generated title shows up on the next sessions poll.
 * @param {{ force?: boolean }} [opts]
 * @returns {Map<string, string>}
 */
export function loadCursorComposerTitles(opts = {}) {
  const dbPath = resolveCursorStateDb(opts);
  if (!dbPath) return new Map();
  const key = dbCacheKey(dbPath);
  const now = Date.now();
  if (
    !opts.force
    && cache
    && cache.key === key
    && (now - cache.at) < CACHE_TTL_MS
  ) {
    return cache.titles;
  }
  const titles = readTitlesFromDb(dbPath);
  cache = { key, at: now, titles };
  return titles;
}

/**
 * @param {string} sessionId
 * @param {{ force?: boolean }} [opts]
 * @returns {string | null}
 */
export function cursorComposerTitle(sessionId, opts = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  return loadCursorComposerTitles(opts).get(id) || null;
}

/**
 * Apply Cursor UI titles onto in-memory session/lane rows (mutates).
 * Cursor name wins whenever present so a generated title replaces the
 * first-prompt snippet once it appears.
 * @param {Iterable<{ id?: string, harness?: string, title?: string | null }>} rows
 * @param {{ force?: boolean }} [opts]
 * @returns {number} how many rows received a Cursor title
 */
export function applyCursorComposerTitles(rows, opts = {}) {
  let titles = null;
  let applied = 0;
  for (const row of rows || []) {
    if (!row || row.harness !== 'cursor' || !row.id) continue;
    if (!titles) titles = loadCursorComposerTitles(opts);
    const title = titles.get(row.id);
    if (!title) continue;
    if (row.title === title) continue;
    row.title = title;
    applied += 1;
  }
  return applied;
}

/** Test helper — drop cached path + titles. */
export function resetCursorComposerTitleCache() {
  cache = null;
  resolvedDbPath = undefined;
}
