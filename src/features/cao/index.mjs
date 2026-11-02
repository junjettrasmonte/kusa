/**
 * AWS CLI Agent Orchestrator (CAO) — status probe and HTTP client for the
 * local cao-server (default http://127.0.0.1:9889).
 *
 * Profiles are the writable "connections": each selects a provider CLI and is
 * managed via CAO's /agents/profiles API. Provider availability itself is
 * read-only from GET /agents/providers.
 */
import { spawnSync } from 'node:child_process';

export const DEFAULT_CAO_BASE_URL = 'http://127.0.0.1:9889';
export const CAO_WEB_UI_URL = 'http://localhost:9889';

/** Known CAO provider ids (CLI agent backends) — match cao-server /agents/providers. */
export const CAO_PROVIDER_IDS = [
  'kiro_cli',
  'claude_code',
  'codex',
  'antigravity_cli',
  'hermes',
  'kimi_cli',
  'mcode',
  'copilot_cli',
  'opencode_cli',
  'omp',
  'cursor_cli',
  'grok_cli',
  'kusa_cli',
];

export const CAO_PROVIDER_LABELS = {
  kiro_cli: 'Kiro CLI',
  claude_code: 'Claude Code',
  codex: 'Codex CLI',
  antigravity_cli: 'Antigravity CLI',
  antigravity: 'Antigravity CLI',
  hermes: 'Hermes',
  kimi_cli: 'Kimi CLI',
  kimi: 'Kimi CLI',
  mcode: 'MiniMax Code',
  minimax: 'MiniMax Code',
  copilot_cli: 'GitHub Copilot CLI',
  copilot: 'GitHub Copilot CLI',
  opencode_cli: 'OpenCode CLI',
  opencode: 'OpenCode CLI',
  omp: 'Oh My Pi (OMP)',
  cursor_cli: 'Cursor CLI',
  cursor: 'Cursor CLI',
  grok_cli: 'Grok Build CLI',
  grok: 'Grok Build CLI',
  kusa_cli: 'Kusa CLI',
};

const CAO_TIMEOUT_MS = 4000;
const CAO_STATUS_CACHE_MS = 2000;
let caoStatusCache = { at: 0, baseUrl: '', value: null };

const CAO_INSTALL_STEPS = [
  'Install uv: https://docs.astral.sh/uv/',
  'Install CAO: uv tool install git+https://github.com/awslabs/cli-agent-orchestrator.git@main --upgrade',
  'Confirm it works: cao --help',
  'Install a supervisor profile: cao install code_supervisor',
  'Start the local server: cao-server',
  'Reload this dashboard (or reopen the CAO tab)',
];

const CAO_SERVER_STEPS = [
  'In a terminal, start the local server and leave it running: cao-server',
  'Confirm health: curl http://127.0.0.1:9889/health',
  'Optional — open the CAO Web UI: http://localhost:9889',
  'Reload this dashboard (or reopen the CAO tab)',
];

export function resolveCaoBaseUrl(env = process.env) {
  const raw = String(env.CAO_BASE_URL || '').trim();
  if (!raw) return DEFAULT_CAO_BASE_URL;
  return raw.replace(/\/+$/, '');
}

export function emptyCaoStatus(error = null) {
  return {
    ok: false,
    checkedAt: Date.now(),
    installed: false,
    version: null,
    serverUp: false,
    baseUrl: DEFAULT_CAO_BASE_URL,
    webUiUrl: CAO_WEB_UI_URL,
    providers: [],
    sessions: [],
    error: error || null,
    steps: [],
  };
}

function runCao(args, cwd = process.cwd()) {
  return spawnSync('cao', args, {
    cwd,
    encoding: 'utf8',
    timeout: CAO_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
}

function probeCaoCli() {
  const help = runCao(['--help']);
  if (help.error && help.error.code === 'ENOENT') {
    return { installed: false, version: null };
  }
  const version = runCao(['--version']);
  const text = `${version.stdout || ''}\n${version.stderr || ''}`.trim()
    || `${help.stdout || ''}`.trim().split('\n')[0]
    || null;
  // `cao --version` prints `cao, version 2.5.4` — pull the semver token.
  const semver = text && text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\b/);
  const parsed = semver
    ? semver[1]
    : (text ? text.replace(/^cao[,\s]+/i, '').split(/\s+/)[0] : null);
  return {
    installed: help.status === 0 || help.status === null || Boolean(text),
    version: parsed,
  };
}

/**
 * Fetch JSON from cao-server. Returns { ok, status, data, error }.
 */
export async function caoFetch(pathname, {
  baseUrl = resolveCaoBaseUrl(),
  method = 'GET',
  body = null,
  timeoutMs = CAO_TIMEOUT_MS,
} = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body != null
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const detail = data?.detail;
      const message = typeof detail === 'string'
        ? detail
        : detail?.message || data?.error || data?.message || `HTTP ${res.status}`;
      return { ok: false, status: res.status, data, error: message };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      error: aborted
        ? `cao-server timed out at ${url}`
        : (err?.message || String(err) || `could not reach ${url}`),
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProviders(raw) {
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      if (typeof entry === 'string') {
        return {
          id: entry,
          label: CAO_PROVIDER_LABELS[entry] || entry,
          available: true,
        };
      }
      if (!entry || typeof entry !== 'object') return null;
      const id = String(entry.id || entry.name || entry.provider || '').trim();
      if (!id) return null;
      return {
        id,
        label: entry.label || CAO_PROVIDER_LABELS[id] || id,
        available: entry.available !== false && entry.installed !== false && entry.ok !== false,
        version: entry.version || null,
        path: entry.path || entry.binary || null,
        error: entry.error || null,
      };
    }).filter(Boolean);
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([id, value]) => {
      if (value === true || value === false) {
        return {
          id,
          label: CAO_PROVIDER_LABELS[id] || id,
          available: value === true,
        };
      }
      if (value && typeof value === 'object') {
        return {
          id,
          label: value.label || CAO_PROVIDER_LABELS[id] || id,
          available: value.available !== false && value.installed !== false && value.ok !== false,
          version: value.version || null,
          path: value.path || value.binary || null,
          error: value.error || null,
        };
      }
      return {
        id,
        label: CAO_PROVIDER_LABELS[id] || id,
        available: Boolean(value),
      };
    });
  }
  return [];
}

function normalizeSessions(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.sessions)
      ? raw.sessions
      : [];
  return list.map((s) => {
    if (typeof s === 'string') return { name: s, terminals: 0 };
    if (!s || typeof s !== 'object') return null;
    const name = String(s.name || s.session_name || s.id || '').trim();
    if (!name) return null;
    const terminals = Array.isArray(s.terminals)
      ? s.terminals.length
      : Number(s.terminal_count || s.terminals || 0) || 0;
    return { name, terminals, status: s.status || null };
  }).filter(Boolean);
}

function normalizeProfiles(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.profiles)
      ? raw.profiles
      : Array.isArray(raw?.items)
        ? raw.items
        : [];
  return list.map((p) => {
    if (typeof p === 'string') {
      return { name: p, provider: null, source: null, editable: true };
    }
    if (!p || typeof p !== 'object') return null;
    const name = String(p.name || p.id || '').trim();
    if (!name) return null;
    const source = p.source || p.origin || p.store || null;
    const editable = source == null
      || source === 'local'
      || source === 'local_store'
      || source === 'agent-store'
      || p.editable === true
      || p.builtin === false;
    return {
      name,
      provider: p.provider || null,
      model: p.model || null,
      description: p.description || null,
      source,
      editable: p.builtin === true ? false : editable,
      builtin: p.builtin === true,
    };
  }).filter(Boolean);
}

/**
 * Probe cao CLI + cao-server health / providers / sessions.
 */
export async function collectCaoStatus({
  force = false,
  baseUrl = resolveCaoBaseUrl(),
} = {}) {
  const now = Date.now();
  const root = baseUrl.replace(/\/+$/, '');
  if (
    !force
    && caoStatusCache.value
    && caoStatusCache.baseUrl === root
    && now - caoStatusCache.at < CAO_STATUS_CACHE_MS
  ) {
    return caoStatusCache.value;
  }

  const result = emptyCaoStatus();
  result.checkedAt = now;
  result.baseUrl = root;
  result.webUiUrl = root.includes('9889') ? CAO_WEB_UI_URL : root;

  const cli = probeCaoCli();
  result.installed = cli.installed;
  result.version = cli.version;

  if (!cli.installed) {
    result.error = 'CAO CLI not found on PATH';
    result.steps = [...CAO_INSTALL_STEPS];
    caoStatusCache = { at: now, baseUrl: root, value: result };
    return result;
  }

  const health = await caoFetch('/health', { baseUrl: root });
  if (!health.ok) {
    result.serverUp = false;
    result.error = health.error || 'cao-server is not reachable';
    result.steps = [...CAO_SERVER_STEPS];
    caoStatusCache = { at: now, baseUrl: root, value: result };
    return result;
  }

  result.serverUp = true;

  const [providersRes, sessionsRes] = await Promise.all([
    caoFetch('/agents/providers', { baseUrl: root }),
    caoFetch('/sessions', { baseUrl: root }),
  ]);

  if (providersRes.ok) result.providers = normalizeProviders(providersRes.data);
  if (sessionsRes.ok) result.sessions = normalizeSessions(sessionsRes.data);

  result.ok = true;
  result.error = null;
  result.steps = [];
  caoStatusCache = { at: now, baseUrl: root, value: result };
  return result;
}

export async function listCaoProfiles({ baseUrl = resolveCaoBaseUrl() } = {}) {
  const res = await caoFetch('/agents/profiles', { baseUrl });
  if (!res.ok) {
    const err = new Error(res.error || 'Could not list CAO profiles');
    err.status = res.status;
    err.code = res.status === 0 ? 'ECONN' : 'EHTTP';
    throw err;
  }
  return { profiles: normalizeProfiles(res.data) };
}

export async function readCaoProfileSource(name, { baseUrl = resolveCaoBaseUrl() } = {}) {
  const key = String(name || '').trim();
  if (!key) {
    const err = new Error('profile name is required');
    err.code = 'EINVAL';
    throw err;
  }
  const res = await caoFetch(`/agents/profiles/${encodeURIComponent(key)}/source`, { baseUrl });
  if (!res.ok) {
    // Fall back to resolved profile if /source is gated or missing.
    const fallback = await caoFetch(`/agents/profiles/${encodeURIComponent(key)}`, { baseUrl });
    if (!fallback.ok) {
      const err = new Error(res.error || fallback.error || 'Could not read profile');
      err.status = res.status || fallback.status;
      err.code = 'EHTTP';
      throw err;
    }
    return {
      name: key,
      content: typeof fallback.data?.content === 'string'
        ? fallback.data.content
        : buildProfileDocument({
          name: key,
          provider: fallback.data?.provider || 'claude_code',
          model: fallback.data?.model || '',
          description: fallback.data?.description || '',
          body: fallback.data?.prompt || fallback.data?.body || '',
        }),
      profile: fallback.data,
    };
  }
  const content = typeof res.data === 'string'
    ? res.data
    : (res.data?.content || res.data?.source || res.data?.document || '');
  return { name: key, content: String(content || ''), profile: res.data };
}

export async function createCaoProfile({ name, content }, { baseUrl = resolveCaoBaseUrl() } = {}) {
  const key = String(name || '').trim();
  const doc = String(content || '');
  if (!key || !doc) {
    const err = new Error('name and content are required');
    err.code = 'EINVAL';
    throw err;
  }
  const res = await caoFetch('/agents/profiles', {
    baseUrl,
    method: 'POST',
    body: { name: key, content: doc },
  });
  if (!res.ok) {
    const err = new Error(res.error || 'Could not create profile');
    err.status = res.status;
    err.code = res.status === 409 ? 'EEXIST' : res.status === 400 ? 'EINVAL' : 'EHTTP';
    err.data = res.data;
    throw err;
  }
  return res.data || { name: key };
}

export async function updateCaoProfile(name, { content }, { baseUrl = resolveCaoBaseUrl() } = {}) {
  const key = String(name || '').trim();
  const doc = String(content || '');
  if (!key || !doc) {
    const err = new Error('name and content are required');
    err.code = 'EINVAL';
    throw err;
  }
  const res = await caoFetch(`/agents/profiles/${encodeURIComponent(key)}`, {
    baseUrl,
    method: 'PUT',
    body: { name: key, content: doc },
  });
  if (!res.ok) {
    const err = new Error(res.error || 'Could not update profile');
    err.status = res.status;
    err.code = res.status === 404 ? 'ENOENT' : res.status === 400 ? 'EINVAL' : 'EHTTP';
    err.data = res.data;
    throw err;
  }
  return res.data || { name: key };
}

export async function deleteCaoProfile(name, { baseUrl = resolveCaoBaseUrl() } = {}) {
  const key = String(name || '').trim();
  if (!key) {
    const err = new Error('profile name is required');
    err.code = 'EINVAL';
    throw err;
  }
  const res = await caoFetch(`/agents/profiles/${encodeURIComponent(key)}`, {
    baseUrl,
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = new Error(res.error || 'Could not delete profile');
    err.status = res.status;
    err.code = res.status === 404 ? 'ENOENT' : 'EHTTP';
    err.data = res.data;
    throw err;
  }
  return res.data || { ok: true, name: key };
}

/**
 * Build a minimal CAO agent-profile Markdown document.
 */
export function buildProfileDocument({
  name,
  provider = 'claude_code',
  model = '',
  description = '',
  body = '',
} = {}) {
  const key = String(name || '').trim();
  const lines = ['---', `name: ${yamlScalar(key)}`, `provider: ${yamlScalar(provider)}`];
  if (String(model || '').trim()) lines.push(`model: ${yamlScalar(String(model).trim())}`);
  if (String(description || '').trim()) {
    lines.push(`description: ${yamlScalar(String(description).trim())}`);
  }
  lines.push('---', '', String(body || '').replace(/^\n+/, ''));
  if (!lines[lines.length - 1].endsWith('\n') && body) {
    /* keep as-is */
  }
  return `${lines.join('\n').replace(/\n*$/, '\n')}`;
}

/**
 * Best-effort frontmatter parse for the connections editor (not a full YAML parser).
 */
export function parseProfileDocument(content) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      name: '',
      provider: 'claude_code',
      model: '',
      description: '',
      body: text,
    };
  }
  const front = match[1];
  const body = match[2] || '';
  const fields = {};
  for (const line of front.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = unquoteYaml(m[2].trim());
  }
  return {
    name: fields.name || '',
    provider: fields.provider || 'claude_code',
    model: fields.model || '',
    description: fields.description || '',
    body: body.replace(/^\n/, ''),
  };
}

function yamlScalar(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  if (/^[\w./@+-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function unquoteYaml(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value.startsWith("'")
        ? `"${value.slice(1, -1).replace(/"/g, '\\"')}"`
        : value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}
