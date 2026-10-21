export function fmt(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) return sign + Math.round(abs) + ' ms';
  const s = abs / 1000;
  if (s < 60) return sign + s.toFixed(1) + ' s';
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return sign + m + ' min ' + rem + ' s';
  const h = Math.floor(m / 60);
  return sign + h + ' h ' + (m - h * 60) + ' min';
}

export function clock(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}

export function stamp(ms) {
  if (ms == null) return '—';
  try { return new Date(ms).toISOString(); } catch { return '—'; }
}

export function shortId(id) {
  if (!id) return 'unknown';
  return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
}

/**
 * Mirror of chat-store.mjs#titleFromText — the browser derives titles locally so
 * the sidebar labels a chat the moment its first prompt is sent, before the
 * server round-trip returns the persisted title.
 */
const TITLE_MAX_CHARS = 72;

function titleFromText(raw) {
  if (!raw) return null;
  const stripped = String(raw)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)\n]*\)/g, '$1');
  const line = stripped
    .split(/\r?\n/)
    .map((s) => s.replace(/^[ \t]*(?:#{1,6}|[-*+•>])[ \t]+/, '').trim())
    .find((s) => s.length > 0);
  if (!line) return null;
  const flat = line
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  const sentence = flat.match(/^(.{8,}?[.!?])(?:\s|$)/);
  const base = sentence ? sentence[1].trim() : flat;
  if (base.length <= TITLE_MAX_CHARS) return base;
  const cut = base.slice(0, TITLE_MAX_CHARS);
  const boundary = cut.lastIndexOf(' ');
  const clipped = boundary > TITLE_MAX_CHARS * 0.5 ? cut.slice(0, boundary) : cut;
  const trimmed = clipped.replace(/[\s,;:.!?\-–—]+$/, '').trim();
  return trimmed ? `${trimmed}…` : null;
}

export function sessionTitle(session) {
  if (!session) return null;
  if (typeof session.title === 'string' && session.title.trim()) {
    const oneLine = session.title.replace(/\s+/g, ' ').trim();
    return oneLine.length <= TITLE_MAX_CHARS ? oneLine : `${oneLine.slice(0, TITLE_MAX_CHARS - 1).trim()}…`;
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const first = messages.find((m) => m && m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  return first ? titleFromText(first.text) : null;
}

/** Sidebar label for a session: its title when known, else the short id. */
export function sessionLabel(session) {
  const title = sessionTitle(session);
  if (title) return title;
  return shortId(session?.id);
}

export function num(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

export const STATUS_TEXT = {
  busy: 'tool running',
  thinking: 'prompt open',
  idle: 'idle',
  ended: 'ended',
};

export const HARNESS_NAMES = {
  kusa: 'Kusă',
  cursor: 'Cursor',
  'vscode-local': 'VS Code Local',
  'github-copilot': 'GitHub Copilot',
};

export const KUSA_HARNESS = 'kusa';

export function isKusaKey(key) {
  return typeof key === 'string' && key.startsWith(`${KUSA_HARNESS}:`);
}

export function kusaLaneKey(sessionId) {
  return `${KUSA_HARNESS}:${sessionId || 'unknown'}`;
}

export const TAB_IDS = [
  'monitors',
  'session',
  'harness',
  'devtools',
  'settings',
];

export const TAB_LABELS = {
  monitors: 'Monitors',
  session: 'Chat Session',
  harness: 'Harness',
  devtools: 'Developer Tools',
  settings: 'Settings',
};

/** Left-sidebar views switched from the sidebar topbar icons. */
export const SIDEBAR_VIEW_IDS = [
  'explorer',
  'sessions',
  'search',
  'extensions',
];

export const SIDEBAR_VIEW_LABELS = {
  sessions: 'Agents',
  explorer: 'Explorer',
  search: 'Search',
  extensions: 'Extensions',
};

/** Sub-views under the Monitors rail tab (main pane topbar tabs). */
export const MONITOR_SUBTAB_IDS = [
  'counters',
  'tokens',
  'events',
  'warnings',
  'quality',
];

export const MONITOR_SUBTAB_LABELS = {
  counters: 'Counters',
  tokens: 'Tokens',
  events: 'Events',
  warnings: 'Warnings',
  quality: 'Quality',
};

/** Sub-views under the Chat Session rail tab. */
export const SESSION_SUBTAB_IDS = [
  'chat',
  'prompts',
  'tools',
];

export const SESSION_SUBTAB_LABELS = {
  chat: 'Kusă Chat',
  prompts: 'Prompt History',
  tools: 'Tool Call Viewer',
};

/** Sub-views under the Developer Tools rail tab. */
export const DEVTOOLS_SUBTAB_IDS = [
  'git',
  'trail',
];

export const DEVTOOLS_SUBTAB_LABELS = {
  git: 'Git',
  trail: 'Trail',
};

/** Sub-views under the Harness rail tab. */
export const HARNESS_SUBTAB_IDS = [
  'mcp',
  'tools',
  'skills',
  'knowledgebase',
];

export const HARNESS_SUBTAB_LABELS = {
  mcp: 'MCP Server',
  tools: 'Tools',
  skills: 'Skills',
  knowledgebase: 'Knowledgebase',
};

/** Sub-views under the Settings rail tab. */
export const SETTINGS_SUBTAB_IDS = [
  'agent',
  'playback',
  'workspace',
  'sdk',
];

export const SETTINGS_SUBTAB_LABELS = {
  agent: 'Agent',
  playback: 'Playback',
  workspace: 'Workspace',
  sdk: 'SDK listener',
};

/** Porcelain short codes → short labels for the Git tab. */
export const GIT_CODE_LABEL = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  '?': 'untracked',
  '!': 'ignored',
  T: 'typechange',
};
