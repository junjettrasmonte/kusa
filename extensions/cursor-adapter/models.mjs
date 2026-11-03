/**
 * Cursor Agent model catalog — `agent --list-models`.
 *
 * Labels often encode the context window ("… 1M …"); parameterized ids may
 * also carry `[context=1m,…]`. Both feed the SessionChat ContextRing limit.
 */
import { spawnSync } from 'node:child_process';
import { cliAgentEnv } from '#features/chat/data/cli-agent-env.mjs';
import { resolveCursorAgentBinary } from './cli-trust.mjs';

const DEFAULT_CONTEXT = 128_000;
const CACHE_TTL_MS = 60_000;

/** @type {{ at: number, models: ReturnType<typeof parseListModelsOutput> } | null} */
let cache = null;

/**
 * @param {string} text
 * @returns {number | null}
 */
export function parseContextTokenLimit(text) {
  const raw = String(text || '');
  // Bracket overrides: [context=1m] / [context=200k]
  const bracket = raw.match(/\[(?:[^\]]*[,;\s])?context\s*=\s*([0-9.]+)\s*([km])?\b/i);
  if (bracket) {
    const n = Number(bracket[1]);
    if (Number.isFinite(n) && n > 0) {
      const unit = (bracket[2] || '').toLowerCase();
      if (unit === 'm') return Math.round(n * 1_000_000);
      if (unit === 'k') return Math.round(n * 1_000);
      return Math.round(n);
    }
  }
  // Label / id shorthand: "1M", "200k", "128K"
  const bare = raw.match(/(?:^|[^a-z0-9])([0-9]+(?:\.[0-9]+)?)\s*([km])(?:\b|(?=[^a-z0-9]))/i);
  if (bare) {
    const n = Number(bare[1]);
    if (Number.isFinite(n) && n > 0) {
      const unit = bare[2].toLowerCase();
      if (unit === 'm') return Math.round(n * 1_000_000);
      if (unit === 'k') return Math.round(n * 1_000);
    }
  }
  return null;
}

/**
 * @param {string} stdout
 * @returns {Array<{ id: string, label: string, contextTokens: number }>}
 */
export function parseListModelsOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  /** @type {Array<{ id: string, label: string, contextTokens: number }>} */
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^available models$/i.test(trimmed)) continue;
    // `id - Label` (label may contain " - ")
    const m = trimmed.match(/^([a-z0-9][\w./:@+-]*(?:\[[^\]]+\])?)\s+-\s+(.+)$/i);
    if (!m) continue;
    const id = m[1].trim();
    const label = m[2].trim();
    if (!id) continue;
    const fromText = parseContextTokenLimit(id) ?? parseContextTokenLimit(label);
    out.push({
      id,
      label: label || id,
      contextTokens: fromText || DEFAULT_CONTEXT,
    });
  }
  return out;
}

/**
 * @param {{ force?: boolean, timeoutMs?: number }} [opts]
 */
export function listCursorModels(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache && (now - cache.at) < CACHE_TTL_MS) {
    return {
      ok: true,
      installed: true,
      default: cache.models[0]?.id || 'auto',
      models: cache.models,
      error: null,
    };
  }

  const resolved = resolveCursorAgentBinary();
  if (!resolved) {
    return {
      ok: false,
      installed: false,
      default: 'auto',
      models: [],
      error: 'Cursor Agent CLI not found (install from https://cursor.com/cli)',
    };
  }

  let result;
  try {
    result = spawnSync(resolved.binary, ['--list-models'], {
      encoding: 'utf8',
      env: cliAgentEnv(),
      timeout: Math.max(5_000, opts.timeoutMs || 45_000),
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      installed: true,
      default: 'auto',
      models: [],
      error: err?.message || String(err),
    };
  }

  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.error?.code === 'ENOENT') {
    return {
      ok: false,
      installed: false,
      default: 'auto',
      models: [],
      error: 'Cursor Agent CLI not found on PATH',
    };
  }
  if (result.status !== 0 && !stdout.trim()) {
    return {
      ok: false,
      installed: true,
      default: 'auto',
      models: [],
      error: (stderr || result.error?.message || `list-models exited ${result.status}`).trim().slice(0, 500),
    };
  }

  const models = parseListModelsOutput(stdout);
  if (!models.length) {
    return {
      ok: false,
      installed: true,
      default: 'auto',
      models: [],
      error: (stderr || 'No models returned by Cursor Agent').trim().slice(0, 500),
    };
  }

  cache = { at: now, models };
  const hasAuto = models.some((m) => m.id === 'auto');
  return {
    ok: true,
    installed: true,
    default: hasAuto ? 'auto' : models[0].id,
    models,
    error: null,
  };
}

export function resetCursorModelsCache() {
  cache = null;
}
