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

/**
 * Mirror of lib.mjs sessionRankAt — the browser cannot import the node lib.
 * The one ordering key every session list uses: newest rank first, where a rank
 * only moves when a session **starts** or when it **ends**. Mid-session activity
 * (messages, tool calls) never re-ranks a row, so the list cannot jitter.
 */
export function sessionRankAt(session) {
  const started = session?.startedAtWall ?? session?.createdAt ?? 0;
  const ended = session?.endedAtWall ?? session?.endedAt ?? 0;
  return Math.max(Number.isFinite(started) ? started : 0, Number.isFinite(ended) ? ended : 0);
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
  archived: 'archived',
};

export const HARNESS_NAMES = {
  kusa: 'Kusă',
  cursor: 'Cursor',
  'vscode-local': 'VS Code Local',
  'github-copilot': 'GitHub Copilot',
};

/** Provider groups shown in Agents (standard + orchestrated chat sessions). */
export const CHAT_PROVIDER_GROUPS = [
  { id: 'kusa', harness: 'kusa', label: 'Kusă' },
  { id: 'cursor', harness: 'cursor', label: 'Cursor' },
  { id: 'copilot', harness: 'github-copilot', label: 'Copilot' },
];

export const CHAT_HARNESSES = CHAT_PROVIDER_GROUPS.map((g) => g.harness);

/**
 * Harness for HarnessLogo / chat branding: Agent-picker provider wins over a
 * stale kusa: lane key so Cursor/Copilot sessions do not show as Kusă.
 */
export function sessionProviderHarness(sessionOrSpeaker) {
  const providerId = String(
    sessionOrSpeaker?.provider
    || sessionOrSpeaker?.options?.provider
    || '',
  ).trim().toLowerCase();
  if (providerId) {
    const group = CHAT_PROVIDER_GROUPS.find((g) => (
      g.id === providerId
      || g.harness === providerId
      || (providerId === 'github-copilot' && g.id === 'copilot')
    ));
    if (group) return group.harness;
  }
  if (typeof sessionOrSpeaker?.harness === 'string' && sessionOrSpeaker.harness.trim()) {
    return sessionOrSpeaker.harness.trim();
  }
  if (typeof sessionOrSpeaker?.key === 'string' && sessionOrSpeaker.key.includes(':')) {
    return sessionOrSpeaker.key.slice(0, sessionOrSpeaker.key.indexOf(':'));
  }
  if (typeof sessionOrSpeaker?.queueKey === 'string' && sessionOrSpeaker.queueKey.includes(':')) {
    return sessionOrSpeaker.queueKey.slice(0, sessionOrSpeaker.queueKey.indexOf(':'));
  }
  return 'kusa';
}

export const KUSA_HARNESS = 'kusa';

export function isKusaKey(key) {
  return typeof key === 'string' && key.startsWith(`${KUSA_HARNESS}:`);
}

/** True when the key belongs to a chat-capable provider harness. */
export function isChatSessionKey(key) {
  if (typeof key !== 'string' || !key.includes(':')) return false;
  const harness = key.slice(0, key.indexOf(':'));
  return CHAT_HARNESSES.includes(harness);
}

export function harnessFromKey(key) {
  if (typeof key !== 'string' || !key.includes(':')) return null;
  const harness = key.slice(0, key.indexOf(':'));
  return CHAT_HARNESSES.includes(harness) || HARNESS_NAMES[harness] ? harness : null;
}

export function kusaLaneKey(sessionId) {
  return `${KUSA_HARNESS}:${sessionId || 'unknown'}`;
}

export const TAB_IDS = [
  'session',
  'harness',
  'devtools',
  'settings',
  'user',
];

export const TAB_LABELS = {
  session: 'Chat Session',
  harness: 'Harness',
  devtools: 'Developer Tools',
  settings: 'Settings',
  user: 'Account',
};

/** Left-sidebar views switched from the sidebar topbar icons. Each id is one
 * pane: `sidebar-view-<id>` is its tab button, `sidebar-panel-<id>` its panel.
 * `search` is workspace *content* search (GET /grep) with replace — a different
 * question from file-name lookup. Older browsers stored `search-names` for the
 * magnifying-glass icon; that id migrates here. */
export const SIDEBAR_VIEW_IDS = [
  'agents',
  'explorer',
  'search',
  'terminal',
  'extensions',
];

export const SIDEBAR_VIEW_LABELS = {
  agents: 'Agents',
  explorer: 'Explorer',
  search: 'Search',
  terminal: 'Terminal',
  extensions: 'Extensions',
};

/** Views whose id changed shape, mapped from the value an older browser stored.
 * Read back through initialSidebarView so a saved pane survives the rename. */
export const SIDEBAR_VIEW_MIGRATED = {
  'search-names': 'search',
  sessions: 'agents',
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

/**
 * Core sub-views under the Developer Tools rail tab.
 * Installed extensions may append more via `nav.placement: 'devtools'`
 * (see features/extensions/registry.js → resolveDevtoolsSubTabs).
 */
/** Always-on Dev Tools views. `strata` is appended only when the Kusă agent
 * endpoint confirms as Strata (see App.jsx rail subTabs). */
export const DEVTOOLS_SUBTAB_IDS = [
  'git',
  'trail',
];

export const DEVTOOLS_SUBTAB_LABELS = {
  git: 'Git',
  trail: 'Trail',
  strata: 'Strata',
};

/** Sub-views under the Harness rail tab (includes former Monitors views). */
export const HARNESS_SUBTAB_IDS = [
  'counters',
  'tokens',
  'events',
  'warnings',
  'quality',
  'mcp',
  'tools',
  'skills',
  'knowledgebase',
];

export const HARNESS_SUBTAB_LABELS = {
  counters: 'Counters',
  tokens: 'Tokens',
  events: 'Events',
  warnings: 'Warnings',
  quality: 'Quality',
  mcp: 'MCP Server',
  tools: 'Tools',
  skills: 'Skills',
  knowledgebase: 'Knowledgebase',
};

/** Sub-views under the Settings rail tab. Login/auth lives on the Account (user) page. */
export const SETTINGS_SUBTAB_IDS = [
  'agent',
  'workspace',
];

export const SETTINGS_SUBTAB_LABELS = {
  agent: 'Agent',
  workspace: 'Workspace',
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
