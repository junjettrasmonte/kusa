/**
 * Extension agent-tool discovery. Scans extensions for a tools.mjs that exports
 * createTools(ctx) returning defs + call, and optional TOOL_GROUP.
 * Broken modules are skipped so one bad extension cannot kill the agent loop.
 * Discovery is async once; turn building uses the warm cache synchronously.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pkgRoot } from '#shared/lib/pkg.mjs';

const EXTENSIONS_ROOT = join(pkgRoot, 'extensions');

/** @type {null | Array<{ id: string, group: string, createTools: Function }>} */
let cachedModules = null;

/** @type {Promise<Array<{ id: string, group: string, createTools: Function }>> | null} */
let loading = null;

/**
 * Convert raw tool defs to OpenAI function schemas.
 * @param {Array<{ name: string, description: string, parameters: object }>} defs
 */
export function extensionToolSchemas(defs = []) {
  return (Array.isArray(defs) ? defs : []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Discover and load extension tool modules (cached after first success).
 * @param {{ force?: boolean }} [opts]
 */
export async function loadExtensionToolModules({ force = false } = {}) {
  if (cachedModules && !force) return cachedModules;
  if (loading && !force) return loading;

  loading = (async () => {
    /** @type {Array<{ id: string, group: string, createTools: Function }>} */
    const modules = [];
    let entries = [];
    try {
      entries = readdirSync(EXTENSIONS_ROOT, { withFileTypes: true });
    } catch {
      cachedModules = modules;
      return modules;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const toolsPath = join(EXTENSIONS_ROOT, id, 'tools.mjs');
      if (!existsSync(toolsPath)) continue;
      try {
        const mod = await import(pathToFileURL(toolsPath).href);
        if (typeof mod?.createTools !== 'function') continue;
        const group = typeof mod.TOOL_GROUP === 'string' && mod.TOOL_GROUP.trim()
          ? mod.TOOL_GROUP.trim()
          : id;
        modules.push({ id, group, createTools: mod.createTools });
      } catch (err) {
        console.warn(`[kusa] extension tools skipped (${id}):`, err?.message || err);
      }
    }

    cachedModules = modules;
    return modules;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/**
 * Synchronously return cached modules (empty until loaded).
 */
export function getCachedExtensionToolModules() {
  return cachedModules || [];
}

/** Reset discovery cache (tests). */
export function resetExtensionToolModules() {
  cachedModules = null;
  loading = null;
}

/**
 * Instantiate every discovered extension toolset for a turn (sync; uses cache).
 * @param {{ dataDir?: string, sessionKey?: string, workspaceRoot?: string }} ctx
 */
export function createMergedExtensionTools(ctx = {}) {
  const modules = getCachedExtensionToolModules();
  /** @type {Array<{ name: string, description: string, parameters: object }>} */
  const defs = [];
  /** @type {Array<{ group: string, defs: object[] }>} */
  const groups = [];
  /** @type {Map<string, Function>} */
  const callers = new Map();

  for (const mod of modules) {
    let bag;
    try {
      bag = mod.createTools(ctx);
    } catch (err) {
      console.warn(`[kusa] extension createTools failed (${mod.id}):`, err?.message || err);
      continue;
    }
    if (!bag || typeof bag !== 'object') continue;
    const bagDefs = Array.isArray(bag.defs) ? bag.defs.filter((d) => d?.name) : [];
    if (!bagDefs.length) continue;
    groups.push({ group: mod.group, defs: bagDefs });
    for (const def of bagDefs) {
      defs.push(def);
      if (typeof bag.call === 'function') {
        callers.set(String(def.name), bag.call.bind(bag));
      }
    }
  }

  async function call(name, args = {}, callId = null) {
    const fn = callers.get(String(name || ''));
    if (!fn) return { ok: false, error: `unknown extension tool: ${name}`, code: 'ENOENT' };
    return fn(name, args, callId);
  }

  return {
    defs,
    groups,
    names: new Set(defs.map((d) => String(d.name))),
    call,
  };
}

/**
 * OpenAI schema groups for the Tools panel / schema listing (sync; uses cache).
 * @param {{ dataDir?: string, sessionKey?: string }} [ctx]
 */
export function extensionToolGroups(ctx = {}) {
  const merged = createMergedExtensionTools(ctx);
  return merged.groups.map((entry) => ({
    group: entry.group,
    schemas: extensionToolSchemas(entry.defs),
  }));
}
