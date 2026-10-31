/**
 * Kusă MCP state (`.kusa/mcp.json`) and Cursor registration
 * (`.cursor/mcp.json` → per-workspace localhost Streamable HTTP URL).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TOOL_CATALOG, defaultToolFlags } from './catalog.mjs';
import { listAllTools } from './custom-tools.mjs';

/** @deprecated use mcpServerKey(workspaceRoot) — legacy flat key */
export const MCP_SERVER_KEY = 'kusa';

/**
 * Stable URL slug for a workspace: folder name + short path hash so two
 * checkouts named alike get distinct endpoints.
 * e.g. `/home/me/projects/kusa` → `kusa-a1b2c3d4`
 */
export function workspaceMcpSlug(workspaceRoot) {
  const root = resolve(workspaceRoot || process.cwd());
  const base = basename(root)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export function workspaceDisplayName(workspaceRoot) {
  return basename(resolve(workspaceRoot || process.cwd())) || 'workspace';
}

/** Cursor mcpServers key unique to this workspace. */
export function mcpServerKey(workspaceRoot) {
  return `kusa-${workspaceMcpSlug(workspaceRoot)}`;
}

/** Localhost Streamable HTTP path for this workspace. */
export function mcpRpcPath(workspaceRoot) {
  return `/mcp/${workspaceMcpSlug(workspaceRoot)}/rpc`;
}

/** @deprecated use mcpRpcPath(workspaceRoot) */
export const MCP_RPC_PATH = '/mcp/rpc';

const MCP_RPC_PATH_RE = /^\/mcp\/([a-z0-9]+(?:-[a-z0-9]+)*)\/rpc$/;

/** Parse `/mcp/<slug>/rpc` → slug, or null. */
export function parseMcpRpcPath(pathname) {
  const m = String(pathname || '').match(MCP_RPC_PATH_RE);
  return m ? m[1] : null;
}

export function cursorMcpPath(workspaceRoot) {
  return join(resolve(workspaceRoot || process.cwd()), '.cursor', 'mcp.json');
}

export function kusaMcpStatePath(monitorDir) {
  return join(resolve(monitorDir), 'mcp.json');
}

export function mcpEndpointUrl(port = 1424, workspaceRoot = process.cwd()) {
  const p = Number(port) || 1424;
  return `http://127.0.0.1:${p}${mcpRpcPath(workspaceRoot)}`;
}

/** Cursor mcp.json entry for the localhost HTTP endpoint. */
export function kusaServerEntry({
  port = 1424,
  authToken = null,
  workspaceRoot = process.cwd(),
} = {}) {
  const entry = {
    url: mcpEndpointUrl(port, workspaceRoot),
  };
  const token = String(authToken || '').trim();
  if (token) {
    entry.headers = { Authorization: `Bearer ${token}` };
  }
  return entry;
}

/** Legacy stdio entry (still available via `kusa mcp`). */
export function kusaStdioEntry() {
  return {
    command: 'kusa',
    args: ['mcp'],
  };
}

function readJsonSafe(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function generateAuthToken() {
  return randomBytes(24).toString('base64url');
}

export function loadMcpState(monitorDir) {
  const defaults = {
    enabled: false,
    authToken: '',
    tools: defaultToolFlags(),
  };
  const raw = readJsonSafe(kusaMcpStatePath(monitorDir), null);
  if (!raw) return { ...defaults, tools: { ...defaults.tools } };

  const tools = { ...defaults.tools };
  if (raw.tools && typeof raw.tools === 'object') {
    for (const [name, on] of Object.entries(raw.tools)) {
      if (typeof name === 'string' && name) tools[name] = Boolean(on);
    }
  }

  // Migrate: older installs only had tools + cursor registration.
  let enabled = Boolean(raw.enabled);
  if (raw.enabled === undefined) {
    // Infer from cursor mcp.json if present (caller may pass workspace later).
    enabled = false;
  }

  return {
    enabled,
    authToken: typeof raw.authToken === 'string' ? raw.authToken : '',
    tools,
  };
}

export function saveMcpState(monitorDir, patch = {}) {
  const current = loadMcpState(monitorDir);
  const next = {
    enabled: current.enabled,
    authToken: current.authToken,
    tools: { ...current.tools },
  };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.authToken !== undefined) {
    next.authToken = patch.authToken == null ? '' : String(patch.authToken);
  }
  if (patch.tools && typeof patch.tools === 'object') {
    for (const [name, on] of Object.entries(patch.tools)) {
      if (typeof name === 'string' && name) next.tools[name] = Boolean(on);
    }
  }
  writeJson(kusaMcpStatePath(monitorDir), next);
  return next;
}

/** Whether this workspace's kusa MCP is registered in `.cursor/mcp.json`. */
export function isMcpRegistered(workspaceRoot) {
  const path = cursorMcpPath(workspaceRoot);
  const root = readJsonSafe(path, null);
  const servers = root?.mcpServers;
  if (!servers || typeof servers !== 'object') return false;
  const key = mcpServerKey(workspaceRoot);
  return Boolean(servers[key] || servers[MCP_SERVER_KEY]);
}

/**
 * Sync `.cursor/mcp.json` with current enabled state + per-workspace localhost URL.
 */
export function syncCursorMcpRegistration(workspaceRoot, monitorDir, { port = 1424 } = {}) {
  const state = loadMcpState(monitorDir);
  const path = cursorMcpPath(workspaceRoot);
  const root = readJsonSafe(path, {});
  if (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers)) {
    root.mcpServers = {};
  }

  const key = mcpServerKey(workspaceRoot);
  // Drop legacy flat `kusa` key and any stale kusa-<other-slug> from this file.
  delete root.mcpServers[MCP_SERVER_KEY];
  for (const name of Object.keys(root.mcpServers)) {
    if (name.startsWith('kusa-') && name !== key) delete root.mcpServers[name];
  }

  if (state.enabled) {
    root.mcpServers[key] = kusaServerEntry({
      port,
      authToken: state.authToken,
      workspaceRoot,
    });
  } else {
    delete root.mcpServers[key];
  }

  writeJson(path, root);
  return {
    enabled: state.enabled,
    registered: Boolean(root.mcpServers[key]),
    path,
    key,
    entry: state.enabled ? root.mcpServers[key] : null,
  };
}

/**
 * Enable/disable the localhost MCP endpoint and sync Cursor registration.
 * When enabling with no auth token, generates one.
 */
export function setMcpEnabled(workspaceRoot, monitorDir, enabled, { port = 1424, authToken } = {}) {
  const patch = { enabled: Boolean(enabled) };
  if (authToken !== undefined) patch.authToken = authToken;

  let state = saveMcpState(monitorDir, patch);
  if (state.enabled && !String(state.authToken || '').trim()) {
    state = saveMcpState(monitorDir, { authToken: generateAuthToken() });
  }
  if (!state.enabled) {
    // keep token for next enable
  }

  const synced = syncCursorMcpRegistration(workspaceRoot, monitorDir, { port });
  return { ...synced, authToken: state.authToken };
}

/** @deprecated use setMcpEnabled — kept for older tests/callers */
export function setMcpRegistered(workspaceRoot, enabled, opts = {}) {
  const monitorDir = opts.monitorDir || join(resolve(workspaceRoot || process.cwd()), '.kusa');
  mkdirSync(monitorDir, { recursive: true });
  return setMcpEnabled(workspaceRoot, monitorDir, enabled, opts);
}

export function getMcpStatus(workspaceRoot, monitorDir, { port = 1424 } = {}) {
  const state = loadMcpState(monitorDir);
  const registered = isMcpRegistered(workspaceRoot);
  const slug = workspaceMcpSlug(workspaceRoot);
  const rpcPath = mcpRpcPath(workspaceRoot);
  const endpoint = mcpEndpointUrl(port, workspaceRoot);
  const key = mcpServerKey(workspaceRoot);
  const entry = state.enabled
    ? kusaServerEntry({ port, authToken: state.authToken, workspaceRoot })
    : null;
  return {
    enabled: state.enabled,
    registered: state.enabled && registered,
    path: cursorMcpPath(workspaceRoot),
    workspace: workspaceDisplayName(workspaceRoot),
    workspaceRoot: resolve(workspaceRoot || process.cwd()),
    slug,
    serverKey: key,
    endpoint,
    host: '127.0.0.1',
    port: Number(port) || 1424,
    rpcPath,
    entry,
    authConfigured: Boolean(String(state.authToken || '').trim()),
    authToken: state.authToken || '',
    authRequired: Boolean(String(state.authToken || '').trim()),
    tools: listAllTools(monitorDir, state.tools).tools,
    note: state.enabled
      ? `Localhost MCP for “${workspaceDisplayName(workspaceRoot)}” is live while kusa serve runs. Path includes the project slug so each repo has its own endpoint.`
      : 'Turn on to expose a per-project localhost Streamable HTTP MCP endpoint and register it in `.cursor/mcp.json`.',
  };
}
