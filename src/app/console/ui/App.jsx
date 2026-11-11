import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DevToolsPanel } from './shared/DevToolsPanel.jsx';
import { HarnessPanel } from './shared/HarnessPanel.jsx';
import { SessionPanel } from './shared/SessionPanel.jsx';
import { SettingsPanel } from './features/settings/SettingsPanel.jsx';
import { UserPanel } from './features/user/UserPanel.jsx';
import { ExtensionPage } from './features/extensions/ExtensionPage.jsx';
import {
  extensionNavEntries,
  getBuiltinExtension,
  isExtensionInstalled,
  resolveDevtoolsSubTabs,
  resolveExtensionNav,
} from './features/extensions/registry.js';
import { RightRail } from './shared/RightRail.jsx';
import { Sidebar, normalizeSessionFilter } from './features/monitor/Sidebar.jsx';
import { basenameOfPath } from './features/explorer/language.js';
import { ConfirmDialog } from './shared/ConfirmDialog.jsx';
import { TrashIcon } from './shared/IconButton.jsx';
import { AtlassianIssueBridge } from '#extensions/atlassian-adapter/ui/AtlassianIssueBridge.jsx';
import { persistJiraTicketToSession } from '#extensions/atlassian-adapter/ui/jiraAttachment.js';

/** Monaco is heavy — load only when a workspace file is opened. */
const EditorWorkbench = lazy(() =>
  import('./features/explorer/EditorWorkbench.jsx').then((mod) => ({ default: mod.EditorWorkbench })),
);

/** Keep the main pane usable if the Monaco chunk fails to load. */
class EditorPaneBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-rose-400">Could not start the code editor.</p>
          <p className="max-w-md text-xs text-gray-500">{this.state.error.message || String(this.state.error)}</p>
          <button
            type="button"
            className="mt-2 rounded-md border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-800"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import {
  CHAT_PROVIDER_GROUPS,
  HARNESS_NAMES,
  HARNESS_SUBTAB_IDS,
  HARNESS_SUBTAB_LABELS,
  isChatSessionKey,
  isKusaKey,
  SESSION_SUBTAB_IDS,
  SESSION_SUBTAB_LABELS,
  sessionLabel,
  sessionRankAt,
  SETTINGS_SUBTAB_IDS,
  SETTINGS_SUBTAB_LABELS,
  TAB_IDS,
} from './shared/lib/format.js';
import { readJsonSet, readLocal, writeJsonSet, writeLocal } from './shared/lib/storage.js';

/** Left editor drawer width (Explorer / Search open files beside the main pane). */
const EDITOR_DRAWER_WIDTH_KEY = 'kusa.editor.drawerWidth';
const EDITOR_DRAWER_DEFAULT_WIDTH = 440;
const EDITOR_DRAWER_MIN_WIDTH = 280;
/** Last Agents / lane selection — restored after refresh so orchestrator chats stick. */
const SELECTED_KEY = 'monitor.selected';

function readEditorDrawerWidth() {
  const raw = Number(readLocal(EDITOR_DRAWER_WIDTH_KEY, String(EDITOR_DRAWER_DEFAULT_WIDTH)));
  return Number.isFinite(raw) && raw >= EDITOR_DRAWER_MIN_WIDTH ? raw : EDITOR_DRAWER_DEFAULT_WIDTH;
}

/** Restore the open session/lane across refresh. Empty / garbage → null. */
function initialSelected() {
  const saved = readLocal(SELECTED_KEY, '');
  return typeof saved === 'string' && saved.includes(':') ? saved : null;
}

/** Core Dev Tools ids plus installed extension nav placements (e.g. CAO). */
const { ids: DEVTOOLS_SUBTAB_IDS, labels: DEVTOOLS_SUBTAB_LABELS } = resolveDevtoolsSubTabs();

/** Prefer Chat when the restored selection is a chat session; otherwise never start on Chat. */
function initialSessionSubTab() {
  const savedTab = readLocal('monitor.tab', 'session');
  if (savedTab === 'plan') return 'prompts';
  const selected = initialSelected();
  if (selected && isChatSessionKey(selected)) return 'chat';
  const initialIds = SESSION_SUBTAB_IDS.filter((id) => id !== 'chat');
  if (initialIds.includes(savedTab)) return savedTab;
  const saved = readLocal('monitor.sessionSubTab', 'prompts');
  return initialIds.includes(saved) ? saved : 'prompts';
}

function initialHarnessSubTab() {
  const savedTab = readLocal('monitor.tab', 'harness');
  if (savedTab === 'skills') return 'skills';
  if (HARNESS_SUBTAB_IDS.includes(savedTab)) return savedTab;
  // Former Monitors rail: tab was `monitors` with its own sub-tab key.
  if (savedTab === 'monitors') {
    const fromMonitors = readLocal('monitor.monitorsSubTab', 'counters');
    if (HARNESS_SUBTAB_IDS.includes(fromMonitors)) return fromMonitors;
  }
  const saved = readLocal('monitor.harnessSubTab', '');
  if (HARNESS_SUBTAB_IDS.includes(saved)) return saved;
  const legacyMonitors = readLocal('monitor.monitorsSubTab', 'counters');
  return HARNESS_SUBTAB_IDS.includes(legacyMonitors) ? legacyMonitors : 'counters';
}

function initialDevtoolsSubTab() {
  const savedTab = readLocal('monitor.tab', 'devtools');
  if (savedTab === 'graft') return 'trail';
  if (DEVTOOLS_SUBTAB_IDS.includes(savedTab)) return savedTab;
  const saved = readLocal('monitor.devtoolsSubTab', 'git');
  if (DEVTOOLS_SUBTAB_IDS.includes(saved)) return saved;
  // Extension catalog selection with a Dev Tools nav placement.
  const extId = readLocal('monitor.activeExtension', '');
  const ext = extId ? getBuiltinExtension(extId) : null;
  if (ext?.nav?.placement === 'devtools' && isExtensionInstalled(ext)) {
    const navId = ext.nav.id || ext.id;
    if (DEVTOOLS_SUBTAB_IDS.includes(navId)) return navId;
  }
  return 'git';
}

/** Restore the last opened built-in extension (catalog highlight). */
function initialActiveExtensionId() {
  const saved = readLocal('monitor.activeExtension', '');
  if (saved && getBuiltinExtension(saved)) return saved;
  const legacySub = readLocal('monitor.devtoolsSubTab', '');
  const legacyTab = readLocal('monitor.tab', '');
  if (legacySub === 'cao' || legacyTab === 'cao') return 'cao';
  return null;
}

/**
 * Open an extension’s info & config page in the main pane.
 * If it declares a Dev Tools nav placement, remember that sub-tab so the rail
 * can return to the same panel later — catalog selection itself owns the main pane.
 */
function openExtension(id, {
  setActiveExtensionId,
  setDevtoolsSubTab,
}) {
  setActiveExtensionId(id);
  const ext = getBuiltinExtension(id);
  const resolved = resolveExtensionNav(ext);
  if (!resolved) return;
  if (resolved.nav.placement === 'devtools') {
    setDevtoolsSubTab(resolved.nav.id || resolved.ext.id);
  }
}

function initialSettingsSubTab() {
  const savedTab = readLocal('monitor.tab', 'settings');
  if (SETTINGS_SUBTAB_IDS.includes(savedTab)) return savedTab;
  const saved = readLocal('monitor.settingsSubTab', 'agent');
  // Auth moved to the Account (user) page — stale 'auth' must not stick.
  // Playback (Follow latest) was removed — session stays until the user picks another.
  // Auth moved to Account; SDK listener settings removed (CLI hooks replace it).
  if (saved === 'auth' || saved === 'playback' || saved === 'sdk') return 'agent';
  return SETTINGS_SUBTAB_IDS.includes(saved) ? saved : 'agent';
}

const CHAT_SESSIONS_KEY = 'monitor.chatSessions';

/** Legacy browser-local chats (pre disk persistence). Cleared after migrate. */
function readLegacyKusaSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((s) => s && typeof s === 'object' && isKusaKey(s.key) && s.id);
  } catch {
    return [];
  }
}

function clearLegacyKusaSessions() {
  try { localStorage.removeItem(CHAT_SESSIONS_KEY); } catch { /* ignore */ }
}

function slimUiChatSession(session) {
  if (!session || !session.id) return null;
  const { live, status, ...rest } = session;
  const archived = session.archived === true;
  return {
    ...rest,
    status: status === 'ended' ? 'ended' : 'idle',
    archived,
    archivedAt: archived
      ? (Number.isFinite(session.archivedAt) ? session.archivedAt : Date.now())
      : null,
  };
}

async function fetchKusaSessions() {
  const res = await fetch('/kusa/agents', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.sessions) ? body.sessions : [];
}

/** Server-owned composer queues (survives refresh; UI mirror starts empty). */
async function fetchKusaQueues() {
  const res = await fetch('/kusa/queue', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (Array.isArray(body?.queues)) return body.queues;
  if (body?.queueKey) return [body];
  return [];
}

function queuesToMap(queues) {
  const next = new Map();
  for (const snap of queues || []) {
    const key = typeof snap?.queueKey === 'string' ? snap.queueKey : '';
    if (!key) continue;
    const queued = Array.isArray(snap.queued) ? snap.queued : [];
    const steering = Array.isArray(snap.steering) ? snap.steering : [];
    if (queued.length || steering.length) next.set(key, { queued, steering });
  }
  return next;
}

/**
 * Per-session held + workspace parked. When this session has no mirror yet,
 * borrow only parked rows from another snapshot — never another chat's held.
 */
function queueForSession(queueByKey, sessionKey) {
  if (!sessionKey) return null;
  const mine = queueByKey.get(sessionKey);
  if (mine) return mine;
  for (const snap of queueByKey.values()) {
    const parked = (snap?.queued || []).filter((entry) => entry?.paused);
    if (parked.length) return { queued: parked, steering: [] };
  }
  return null;
}

/**
 * Merge disk snapshots into local state without clobbering an in-flight chat
 * (busy/thinking + live stream, or a longer local transcript mid-turn).
 * Server overlays `live` onto busy sessions so a refresh can resume the turn.
 */
function mergeKusaSessions(prev, incoming) {
  const prevByKey = new Map((prev || []).map((s) => [s.key, s]));
  const seen = new Set();
  const merged = [];
  for (const next of incoming || []) {
    if (!next?.key) continue;
    seen.add(next.key);
    const cur = prevByKey.get(next.key);
    if (!cur) {
      merged.push(next);
      continue;
    }
    const curBusy = cur.status === 'busy' || cur.status === 'thinking' || cur.live;
    const nextBusy = next.status === 'busy' || next.status === 'thinking' || next.live;
    const localLen = cur.messages?.length || 0;
    const diskLen = next.messages?.length || 0;
    // Mid-turn: keep the longer local transcript. Otherwise prefer disk (the
    // server persists the assistant reply when the turn finishes).
    const messages = curBusy && localLen >= diskLen
      ? (cur.messages || next.messages)
      : (diskLen >= localLen ? next.messages : cur.messages);
    const archived = Boolean(next.archived ?? cur.archived);
    merged.push({
      ...next,
      messages,
      status: curBusy ? cur.status : next.status,
      live: curBusy ? (cur.live || next.live || null) : (nextBusy ? next.live : null),
      archived,
      archivedAt: archived
        ? (next.archivedAt ?? cur.archivedAt ?? null)
        : null,
      opencodeSessionId: cur.opencodeSessionId || next.opencodeSessionId || null,
      attempts: Math.max(cur.attempts || 0, next.attempts || 0),
      turnId: cur.turnId || next.turnId || null,
    });
  }
  // Keep brand-new/in-flight local rows that have not hit disk yet (create race).
  // Do not resurrect rows the user just deleted — those are absent from `incoming`.
  const now = Date.now();
  for (const cur of prev || []) {
    if (seen.has(cur.key)) continue;
    const busy = cur.status === 'busy' || cur.status === 'thinking' || cur.live;
    const newborn = Number.isFinite(cur.createdAt) && (now - cur.createdAt) < 8_000;
    if (busy || newborn) merged.push(cur);
  }
  // Order by the shared session rank: a chat moves only when it starts or ends,
  // never because of mid-turn activity.
  return merged.sort((a, b) => sessionRankAt(b) - sessionRankAt(a));
}

async function persistChatSession(session) {
  const slim = slimUiChatSession(session);
  if (!slim) return null;
  const res = await fetch('/kusa/agents', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ session: slim }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `HTTP ${res.status}`);
  }
  const body = await res.json();
  return body?.sessions?.[0] || slim;
}

function patchKusaSession(setSessions, sessionKey, patchFn) {
  setSessions((prev) => prev.map((s) => (s.key === sessionKey ? patchFn(s) : s)));
}

function emptyLive() {
  return { text: '', thinking: '', tools: [], parts: [] };
}

/** Keep legacy thinking/tools mirrors in sync with the interleaved timeline. */
function mirrorsFromParts(parts) {
  const thinking = (parts || [])
    .filter((p) => p.type === 'thinking' && p.text)
    .map((p) => p.text)
    .join('\n\n');
  const tools = (parts || [])
    .filter((p) => p.type === 'tool' && p.tool)
    .map((p) => p.tool);
  return { thinking, tools };
}

function applyThinkingToParts(parts, ev) {
  const next = [...(parts || [])];
  const chunk = typeof ev.text === 'string' ? ev.text : '';
  const delta = typeof ev.delta === 'string' ? ev.delta : '';
  const last = next[next.length - 1];
  if (last?.type === 'thinking') {
    // Same model step — stream sends cumulative `text` for this segment.
    const text = chunk || `${last.text || ''}${delta}`;
    next[next.length - 1] = { type: 'thinking', text };
  } else {
    // After a tool (or at turn start) — open a new Thought container.
    next.push({ type: 'thinking', text: chunk || delta || '' });
  }
  return next;
}

function applyToolToParts(parts, tool, { upsert = true } = {}) {
  const next = [...(parts || [])];
  if (upsert) {
    const idx = next.findIndex((p) => p.type === 'tool' && p.tool?.id === tool.id);
    if (idx >= 0) {
      next[idx] = { type: 'tool', tool: { ...next[idx].tool, ...tool } };
      return next;
    }
  }
  next.push({ type: 'tool', tool });
  return next;
}

/** Insert or refresh a gated-tool Approval section in the interleaved timeline. */
function applyApprovalToParts(parts, approval) {
  const next = [...(parts || [])];
  const idx = next.findIndex((p) => p.type === 'approval' && p.approval?.id === approval.id);
  if (idx >= 0) {
    next[idx] = { type: 'approval', approval: { ...next[idx].approval, ...approval } };
    return next;
  }
  // A NEW approval supersedes the ones still waiting above it. Only the newest
  // gate is the user's turn, so an older open row is a countdown nothing can
  // reach any more — and it is what drags the scroll back up the page. It
  // settles as the answer the user never gave (denied), which folds its
  // container like any other resolved row.
  if (approval?.status === 'pending') {
    for (let i = 0; i < next.length; i += 1) {
      const prev = next[i];
      if (prev.type !== 'approval' || prev.approval?.status !== 'pending') continue;
      next[i] = {
        type: 'approval',
        approval: {
          ...prev.approval,
          status: 'denied',
          superseded: true,
          reason: 'superseded by a newer approval',
        },
      };
    }
  }
  next.push({ type: 'approval', approval });
  return next;
}

/** Insert or refresh a kusa_ask question card in the interleaved timeline. */
function applyAskToParts(parts, ask) {
  const next = [...(parts || [])];
  const idx = next.findIndex((p) => p.type === 'ask' && p.ask?.id === ask.id);
  if (idx >= 0) {
    next[idx] = { type: 'ask', ask: { ...next[idx].ask, ...ask } };
    return next;
  }
  // Same rule as an approval, in the vocabulary of a question: a newer question
  // supersedes the ones still open above it, and a question has no default to
  // fall back on — nobody answered it, so it settles as unanswered.
  if (ask?.status === 'pending') {
    for (let i = 0; i < next.length; i += 1) {
      const prev = next[i];
      if (prev.type !== 'ask' || prev.ask?.status !== 'pending') continue;
      next[i] = {
        type: 'ask',
        ask: {
          ...prev.ask,
          status: 'unanswered',
          superseded: true,
          reason: 'superseded by a newer question',
        },
      };
    }
  }
  next.push({ type: 'ask', ask });
  return next;
}

function cloneLiveParts(parts) {
  return (parts || []).map((p) => {
    if (p.type === 'tool') return { type: 'tool', tool: { ...p.tool } };
    if (p.type === 'approval') return { type: 'approval', approval: { ...p.approval } };
    if (p.type === 'ask') {
      const questions = Array.isArray(p.ask?.questions)
        ? p.ask.questions.map((q) => ({
          ...q,
          options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ ...o })),
        }))
        : p.ask?.questions;
      const answer = p.ask?.answer
        ? {
          ...p.ask.answer,
          ...(Array.isArray(p.ask.answer.answers)
            ? { answers: p.ask.answer.answers.map((row) => ({ ...row })) }
            : {}),
        }
        : p.ask?.answer;
      return {
        type: 'ask',
        ask: {
          ...p.ask,
          options: (Array.isArray(p.ask?.options) ? p.ask.options : []).map((o) => ({ ...o })),
          questions,
          answer,
        },
      };
    }
    return { ...p };
  });
}

async function readSseChat(res, onEvent) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    onEvent({ type: 'done', ...payload });
    return payload;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload = null;
  /** Fallback if the terminal `done` frame is dropped or fails to parse. */
  const streamed = { text: '', thinking: '', tools: [] };

  const ingestBlock = (block) => {
    let eventType = 'message';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    const type = data?.type || eventType;
    if (type === 'content' && typeof data.text === 'string') streamed.text = data.text;
    if (type === 'thinking' && typeof data.text === 'string') streamed.thinking = data.text;
    if (type === 'tool_start' || type === 'tool_result') {
      const tools = [...streamed.tools];
      const idx = tools.findIndex((t) => t.id === data.id);
      const next = {
        id: data.id,
        name: data.name,
        args: data.args,
        result: data.result,
        summary: data.summary,
        ok: data.ok,
        status: type === 'tool_start' ? 'running' : (data.ok === false ? 'error' : 'done'),
      };
      if (idx >= 0) tools[idx] = { ...tools[idx], ...next };
      else tools.push(next);
      streamed.tools = tools;
    }
    onEvent({ ...data, type });
    // A user Stop ends the stream with `stopped` instead of `done` — both are a
    // final frame, and the partial reply comes back in `text` either way.
    // Model/endpoint failures end with `error` the same way: a settled turn
    // that keeps the transcript and paints a styled error card (not a throw).
    if (type === 'done' || type === 'stopped' || type === 'error') finalPayload = data;
  };

  const drain = () => {
    let sep;
    while ((sep = (() => {
      const a = buffer.indexOf('\n\n');
      const b = buffer.indexOf('\r\n\r\n');
      if (a === -1) return b;
      if (b === -1) return a;
      return Math.min(a, b);
    })()) !== -1) {
      const len = buffer.startsWith('\r\n\r\n', sep) ? 4 : 2;
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + len);
      ingestBlock(block);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
  if (buffer.trim()) {
    buffer += '\n\n';
    drain();
  }

  if (finalPayload) return finalPayload;
  // Stream closed without a terminal frame (refresh / network drop). Caller
  // should reattach via GET /kusa/chat/live instead of finalizing a partial.
  return { type: 'incomplete', text: streamed.text, thinking: streamed.thinking, toolTrace: streamed.tools };
}

function newMessageId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function dataUrl() {
  const inDataDir = /\/\.kusa\//.test(decodeURIComponent(location.pathname));
  if (location.protocol === 'file:') {
    return inDataDir ? 'monitor-data.js' : 'data/monitor-data.js';
  }
  return 'monitor-data.js';
}

function readBootstrap() {
  try {
    const el = document.getElementById('monitor-bootstrap');
    const boot = JSON.parse(el?.textContent || 'null');
    if (boot && typeof boot === 'object') return boot;
  } catch { /* no bootstrap */ }
  return null;
}

export default function App() {
  const [data, setData] = useState(readBootstrap);
  const [lastLoadOk, setLastLoadOk] = useState(() => (readBootstrap() ? Date.now() : 0));
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState(initialSelected);
  /** In-flight chat live snapshots — kept in sync when the user resolves an Approval CTA. */
  const liveSnapBySession = useRef(new Map());
  /** Session keys currently attached to a server turn SSE (send or resume). */
  const attachedTurns = useRef(new Set());
  const [tab, setTab] = useState(() => {
    const saved = readLocal('monitor.tab', 'harness');
    // Plan → Chat Session/Prompts; Graft → Developer Tools/Trail;
    // Skills/MCP/Counters/… → Harness; Prompts/Tools → Chat Session;
    // Git/Trail/CAO → Developer Tools. Former `monitors` rail folds into harness.
    if (saved === 'plan') return 'session';
    if (saved === 'graft') return 'devtools';
    if (saved === 'monitors') return 'harness';
    // Settings › Auth moved to Account (user avatar below theme).
    if (saved === 'auth' || readLocal('monitor.settingsSubTab', '') === 'auth') return 'user';
    if (SESSION_SUBTAB_IDS.includes(saved)) return 'session';
    if (DEVTOOLS_SUBTAB_IDS.includes(saved)) return 'devtools';
    if (HARNESS_SUBTAB_IDS.includes(saved)) return 'harness';
    if (SETTINGS_SUBTAB_IDS.includes(saved)) return 'settings';
    if (TAB_IDS.includes(saved)) return saved;
    // Restoring an installed extension whose nav lives under Dev Tools.
    const extId = readLocal('monitor.activeExtension', '');
    const ext = extId ? getBuiltinExtension(extId) : null;
    if (ext?.nav?.placement === 'devtools' && isExtensionInstalled(ext)) return 'devtools';
    return 'harness';
  });
  const [theme, setTheme] = useState(() => {
    const t = document.documentElement.dataset.theme || readLocal('monitor.theme', 'dark');
    return t === 'light' ? 'light' : 'dark';
  });
  const [sessionSubTab, setSessionSubTab] = useState(initialSessionSubTab);
  const [harnessSubTab, setHarnessSubTab] = useState(initialHarnessSubTab);
  const [devtoolsSubTab, setDevtoolsSubTab] = useState(initialDevtoolsSubTab);
  const [settingsSubTab, setSettingsSubTab] = useState(initialSettingsSubTab);
  const [activeExtensionId, setActiveExtensionId] = useState(initialActiveExtensionId);
  /** Open workspace files in a left drawer beside the main pane (Explorer / Search). */
  const [editorTabs, setEditorTabs] = useState([]);
  const [editorActivePath, setEditorActivePath] = useState(null);
  /** Reveal target after opening from Search: { path, line, column }. */
  const [editorReveal, setEditorReveal] = useState(null);
  const [editorDrawerWidth, setEditorDrawerWidth] = useState(readEditorDrawerWidth);
  const mainPaneRef = useRef(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readLocal('monitor.sidebar', 'open') === 'collapsed',
  );
  const [expandedTools, setExpandedTools] = useState(() => readJsonSet('monitor.expandedTools'));
  const [expandedPrompts, setExpandedPrompts] = useState(() => readJsonSet('monitor.expandedPrompts'));
  const [sessionFilter, setSessionFilter] = useState(() => (
    normalizeSessionFilter(readLocal('monitor.sessionFilter', 'all'))
  ));
  const [selectMode, setSelectMode] = useState(false);
  const [checkedKeys, setCheckedKeys] = useState(() => new Set());
  const [deleteBusy, setDeleteBusy] = useState(false);
  /**
   * The delete the user has asked for but not yet confirmed: { keys, error? }.
   * It exists only to be rendered — ConfirmDialog shows it, and the action runs
   * from that dialog's own confirm button (`runDelete`). Nothing is removed
   * while this is set, so the gate is the only thing between a click on the
   * sidebar's trash button and files going away.
   */
  const [pendingDelete, setPendingDelete] = useState(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  // Poll must not clobber Settings while a POST /settings is in flight — the
  // 1s monitor-data snapshot can still be pre-save and would revert endpoint edits.
  const settingsBusyRef = useRef(false);
  settingsBusyRef.current = settingsBusy;
  // Bumped per save so a delayed unlock from an older save cannot clear busy
  // while a newer POST is still holding the guard.
  const settingsSaveGenRef = useRef(0);
  const [chatSessions, setChatSessions] = useState([]);
  /**
   * Composer queue mirror, keyed by session key: { queued, steering }.
   * The monitor server owns the real queue (POST/GET /kusa/queue) so a
   * running turn can drain it; this state only exists to render it.
   */
  const [queueByKey, setQueueByKey] = useState(new Map());
  /** Live Trail/Git readiness from GET /ready (HTTP serve only). */
  const [ready, setReady] = useState(null);
  /** Live CAO / Live Chat readiness for the Dev Tools rail badge. */
  const [devtoolsExtReady, setDevtoolsExtReady] = useState({ cao: null, liveChat: null });
  /** Live Strata probe for Dev Tools rail — tab only appears when `strata: true`. */
  const [strataStatus, setStrataStatus] = useState(/** @type {{ strata?: boolean, loaded?: boolean|null, ok?: boolean, model?: string }|null} */ (null));
  const canDelete = typeof location !== 'undefined' && location.protocol !== 'file:';
  const canPersistSettings = canDelete;
  /**
   * False until the first GET /kusa/agents finishes (or file://, where there
   * is no agents API). The sidebar stays on a loading indicator until then so
   * harness bootstrap rows — which lack parentId / kind — never flash as a
   * flat ungrouped list before chat metadata arrives.
   */
  const [chatSessionsReady, setChatSessionsReady] = useState(() => !canPersistSettings);

  // Load Kusă chats from `.kusa/kusa/*.chat.json` (and migrate legacy localStorage once).
  // Also rehydrate composer queues from the server — they live in memory there and
  // must be pulled after every refresh (the UI mirror starts empty).
  useEffect(() => {
    if (!canPersistSettings) return undefined;
    let cancelled = false;
    (async () => {
      try {
        let sessions = await fetchKusaSessions();
        const legacy = readLegacyKusaSessions();
        if (legacy.length) {
          const res = await fetch('/kusa/agents/migrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ sessions: legacy }),
          });
          if (res.ok) {
            const body = await res.json();
            sessions = Array.isArray(body?.sessions) ? body.sessions : await fetchKusaSessions();
            clearLegacyKusaSessions();
          }
        }
        const queues = await fetchKusaQueues().catch(() => []);
        if (!cancelled) {
          setChatSessions((prev) => mergeKusaSessions(prev, sessions));
          setQueueByKey(queuesToMap(queues));
        }
      } catch {
        // Keep empty list; user can still create once the server is reachable.
      } finally {
        if (!cancelled) setChatSessionsReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [canPersistSettings]);

  // Re-sync from disk whenever monitor data refreshes so new/other-browser chats appear
  // without a full page reload (same cadence as other harness sessions).
  useEffect(() => {
    if (!canPersistSettings || !data?.generatedAtWall) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [sessions, queues] = await Promise.all([
          fetchKusaSessions(),
          fetchKusaQueues().catch(() => null),
        ]);
        if (!cancelled) {
          setChatSessions((prev) => mergeKusaSessions(prev, sessions));
          // Server is the queue owner — adopt its full map when the poll succeeds.
          if (queues) setQueueByKey(queuesToMap(queues));
        }
      } catch { /* ignore transient poll errors */ }
    })();
    return () => { cancelled = true; };
  }, [canPersistSettings, data?.generatedAtWall]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeLocal('monitor.theme', theme);
  }, [theme]);

  // After a refresh (or another tab), reattach SSE to any turn still running
  // on the server. Sessions GET overlays busy + live from the turn job map.
  // Skip keys that sendChatMessage already owns (liveSnap set before busy).
  useEffect(() => {
    if (!canPersistSettings) return;
    for (const session of chatSessions) {
      const busy = session.status === 'busy' || session.status === 'thinking' || session.live;
      if (!busy || !session.key) continue;
      if (attachedTurns.current.has(session.key)) continue;
      if (liveSnapBySession.current.has(session.key)) continue;
      void resumeKusaTurn(session.key);
    }
  }, [canPersistSettings, chatSessions]);

  useEffect(() => {
    // Legacy: files used to take over the main pane via tab === 'editor'.
    // Restore the last rail section so chat (or whatever was open) stays center.
    if (tab === 'editor') {
      const saved = readLocal('monitor.tab', 'session');
      setTab(TAB_IDS.includes(saved) ? saved : 'session');
      return;
    }
    // Former Monitors rail folded into Harness.
    if (tab === 'monitors') {
      setTab('harness');
      return;
    }
    writeLocal('monitor.tab', tab);
  }, [tab]);

  useEffect(() => {
    writeLocal('monitor.sessionSubTab', sessionSubTab);
  }, [sessionSubTab]);

  useEffect(() => {
    writeLocal('monitor.harnessSubTab', harnessSubTab);
  }, [harnessSubTab]);

  useEffect(() => {
    writeLocal('monitor.devtoolsSubTab', devtoolsSubTab);
  }, [devtoolsSubTab]);

  useEffect(() => {
    writeLocal('monitor.activeExtension', activeExtensionId || '');
  }, [activeExtensionId]);

  useEffect(() => {
    writeLocal('monitor.settingsSubTab', settingsSubTab);
  }, [settingsSubTab]);

  useEffect(() => {
    const push = (next) => {
      setData((prev) => {
        if (!next || typeof next !== 'object') return prev;
        // Keep the just-saved / in-flight settings view while busy so Fields
        // keyed on resetKey do not remount from a stale monitor-data payload.
        if (settingsBusyRef.current && prev?.settings) {
          return { ...next, settings: prev.settings };
        }
        return next;
      });
      setLastLoadOk(Date.now());
      setLoadFailed(false);
    };
    window.kusaUpdate = push;
    window.copilotMonitorUpdate = push; // legacy alias for older monitor-data.js
    return () => {
      delete window.kusaUpdate;
      delete window.copilotMonitorUpdate;
    };
  }, []);

  const poll = useCallback(() => {
    const previous = document.getElementById('monitor-data');
    if (previous) previous.remove();
    const script = document.createElement('script');
    script.id = 'monitor-data';
    script.src = `${dataUrl()}?t=${Date.now()}`;
    script.onerror = () => setLoadFailed(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    poll();
    const pollId = setInterval(poll, 1000);
    const tickId = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, [poll]);

  const settings = data?.settings || {};
  const detectTrail = settings.detectTrail !== false;
  const enforceTrail = detectTrail && settings.enforceTrail !== false;
  const detectGit = settings.detectGit !== false;
  const enforceGit = detectGit && settings.enforceGit !== false;

  // On dashboard load (and periodically), check whether Trail and Git are
  // installed/initialized so their tabs can show setup guidance immediately.
  useEffect(() => {
    if (!canDelete) return undefined;
    if (!detectTrail && !detectGit) {
      setReady(null);
      return undefined;
    }
    let cancelled = false;
    async function checkReady() {
      try {
        const res = await fetch('/ready');
        if (!res.ok || cancelled) return;
        const next = await res.json();
        if (cancelled) return;
        setReady({
          checkedAt: next.checkedAt,
          trail: detectTrail ? next.trail : null,
          git: detectGit ? next.git : null,
        });
      } catch {
        /* file-mode / serve down — panels fall back to monitor-data snapshots */
      }
    }
    checkReady();
    const id = setInterval(checkReady, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [canDelete, detectTrail, detectGit]);

  // Dev Tools extension hosts (CAO, Live Chat) — badge the rail when any is down.
  useEffect(() => {
    if (!canDelete) {
      setDevtoolsExtReady({ cao: null, liveChat: null });
      return undefined;
    }
    let cancelled = false;
    async function checkExt() {
      const next = { cao: null, liveChat: null };
      try {
        const res = await fetch('/cao', { headers: { Accept: 'application/json' } });
        if (res.ok) next.cao = await res.json();
      } catch { /* ignore */ }
      try {
        const res = await fetch('/live-chat', { headers: { Accept: 'application/json' } });
        if (res.ok) next.liveChat = await res.json();
      } catch { /* ignore */ }
      if (!cancelled) setDevtoolsExtReady(next);
    }
    checkExt();
    const id = setInterval(checkExt, 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [canDelete]);

  // Strata Dev Tools item — only when the Kusă agent endpoint confirms as Strata.
  useEffect(() => {
    if (!canDelete) {
      setStrataStatus(null);
      return undefined;
    }
    let cancelled = false;
    async function checkStrata() {
      try {
        const res = await fetch('/kusa/strata', { headers: { Accept: 'application/json' } });
        if (!res.ok || cancelled) return;
        const next = await res.json();
        if (cancelled) return;
        setStrataStatus({
          ok: next?.ok !== false && next?.strata === true,
          strata: next?.strata === true,
          loaded: next?.loaded ?? null,
          model: String(next?.model || '').trim(),
          reason: next?.reason || '',
        });
      } catch {
        if (!cancelled) setStrataStatus((prev) => (prev?.strata ? { ...prev, ok: false } : null));
      }
    }
    checkStrata();
    const id = setInterval(checkStrata, 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [canDelete]);

  const trailStatus = detectTrail ? (ready?.trail || data?.trailStatus) : null;
  const gitStatus = detectGit ? (ready?.git || data?.git) : null;
  const devtoolsNav = extensionNavEntries('devtools');
  const caoOnRail = devtoolsNav.some((e) => e.extensionId === 'cao');
  const liveChatOnRail = devtoolsNav.some((e) => e.extensionId === 'live-chat');
  const strataOnRail = strataStatus?.strata === true;
  // Rail badge: any detected Dev Tools host that is not ok (not only when enforced).
  const trailBadge = Boolean(detectTrail && trailStatus && !trailStatus.ok);
  const gitBadge = Boolean(detectGit && gitStatus && !gitStatus.ok);
  const caoBadge = Boolean(caoOnRail && devtoolsExtReady.cao && !devtoolsExtReady.cao.ok);
  const liveChatBadge = Boolean(
    liveChatOnRail && devtoolsExtReady.liveChat && !devtoolsExtReady.liveChat.ok,
  );
  // Strata indicator: down when unreachable or model unloaded (VRAM free).
  const strataBadge = Boolean(
    strataOnRail && (strataStatus?.ok === false || strataStatus?.loaded === false),
  );

  // Leave the Strata tab if the endpoint stops confirming.
  useEffect(() => {
    if (devtoolsSubTab === 'strata' && !strataOnRail) setDevtoolsSubTab('git');
  }, [devtoolsSubTab, strataOnRail]);

  // Which session the console is showing. Always the user's selection —
  // never auto-jumps to `data.focus` while they are looking at a session.
  // Focus is only a seed when nothing is selected yet (first load / after
  // deleting the open session).
  const laneKey = useMemo(() => {
    if (selected) {
      if (isChatSessionKey(selected)) return selected;
      if (data?.lanes?.[selected]) return selected;
    }
    return data?.focus ?? null;
  }, [data, selected]);

  // Keep the open session across refresh (Playback / Follow-latest was removed).
  useEffect(() => {
    writeLocal(SELECTED_KEY, selected || '');
  }, [selected]);

  // A monitor lane pruned off-disk is no longer selectable — clear so we can
  // reseed once. Chat deletes already clear `selected` in runDelete.
  useEffect(() => {
    if (!selected || isChatSessionKey(selected) || !data) return;
    if (!data.lanes?.[selected]) setSelected(null);
  }, [data, selected]);

  // Restored chat key whose session was deleted — drop it so focus can seed.
  useEffect(() => {
    if (!chatSessionsReady || !selected || !isChatSessionKey(selected)) return;
    const id = selected.includes(':') ? selected.slice(selected.indexOf(':') + 1) : '';
    const exists = chatSessions.some((s) => (
      s.key === selected || (id && s.id === id)
    ));
    if (!exists) setSelected(null);
  }, [chatSessionsReady, chatSessions, selected]);

  // Land on the latest session once when nothing is selected, then stick.
  // Wait for agents hydrate when a chat key was restored — otherwise focus
  // (often a Cursor IDE lane) steals the orchestrator chat after refresh.
  useEffect(() => {
    if (selected != null) return;
    if (!chatSessionsReady && initialSelected()) return;
    if (data?.focus) setSelected(data.focus);
  }, [data?.focus, selected, chatSessionsReady]);

  const chatSession = useMemo(() => {
    if (!laneKey || !isChatSessionKey(laneKey)) return null;
    const byKey = chatSessions.find((s) => s.key === laneKey);
    if (byKey) return byKey;
    // Provider switch remounts kusa:<id> → cursor:<id>; keep the open chat by id.
    const id = laneKey.includes(':') ? laneKey.slice(laneKey.indexOf(':') + 1) : '';
    return id ? (chatSessions.find((s) => s.id === id) || null) : null;
  }, [chatSessions, laneKey]);

  // Follow remounted session keys after an Agent-picker provider switch.
  useEffect(() => {
    if (!selected || !chatSession?.key) return;
    if (chatSession.key !== selected) setSelected(chatSession.key);
  }, [chatSession?.key, selected]);

  // Subagents no longer appear in the sidebar — bounce a stale child (or nested
  // escalation) selection up to the top-level orchestrator so the merged
  // transcript is what opens.
  useEffect(() => {
    if (!chatSession) return;
    let parentId = chatSession.parentId || chatSession.options?.parentId;
    if (!parentId) return;
    const seen = new Set();
    let root = chatSessions.find((s) => s.id === parentId) || null;
    while (root) {
      const nextId = root.parentId || root.options?.parentId;
      if (!nextId || seen.has(root.id)) break;
      seen.add(root.id);
      const next = chatSessions.find((s) => s.id === nextId);
      if (!next) break;
      root = next;
    }
    if (root?.key) setSelected(root.key);
  }, [chatSession, chatSessions]);

  // Descendants of the open orchestrated session (assign Subagents + nested
  // escalations under them) — SessionChat stitches them into one group-chat
  // transcript. Empty for standard / non-parent sessions.
  const peerSessions = useMemo(() => {
    if (!chatSession?.id) return [];
    if (chatSession.parentId || chatSession.options?.parentId) return [];
    const rootId = chatSession.id;
    const byParent = new Map();
    for (const s of chatSessions || []) {
      if (!s?.id || s.id === rootId) continue;
      const pid = s.parentId || s.options?.parentId;
      if (!pid) continue;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(s);
    }
    const out = [];
    const walk = (pid) => {
      for (const child of byParent.get(pid) || []) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(rootId);
    return out;
  }, [chatSession, chatSessions]);

  // When a chat session is selected, land on Chat; leave Chat when it isn't.
  // Wait for agents hydrate so a restored selection is not demoted to Prompts
  // for one frame before /kusa/agents returns.
  useEffect(() => {
    if (chatSession) {
      setSessionSubTab('chat');
      return;
    }
    if (!chatSessionsReady) return;
    setSessionSubTab((prev) => (prev === 'chat' ? 'prompts' : prev));
  }, [chatSession?.key, chatSessionsReady]);

  // Session-bound held prompts flush on the *selected* idle session only.
  // Parked (cross-session) rows are skipped until resumed onto this chat.
  useEffect(() => {
    if (!canPersistSettings || !chatSession?.key) return;
    const session = chatSession;
    const busy = session.status === 'busy' || session.status === 'thinking' || session.live;
    if (busy) return;
    const held = queueForSession(queueByKey, session.key)?.queued || [];
    // Parked prompts stay visible but are never auto-sent.
    if (!held.some((entry) => !entry?.paused)) return;
    void (async () => { await flushQueuedMessages(session.key); })();
  }, [canPersistSettings, chatSession, queueByKey]);

  // Kusă chat transcript is under .kusa/kusa/<id>.chat.json; hooks fill data.lanes[kusa:id].
  const lane = laneKey && data?.lanes?.[laneKey] ? data.lanes[laneKey] : null;

  const statusLine = useMemo(() => {
    if (!data) {
      const text = loadFailed
        ? 'No session data yet. Send a prompt in any hooked agent session.'
        : 'Waiting for session data';
      return { className: 'text-gray-500', text, short: '● Offline' };
    }
    if (loadFailed && now - lastLoadOk > 3000) {
      return {
        className: 'text-amber-400',
        text: 'Data file unreadable. Showing the last snapshot.',
        short: '● Stale',
      };
    }
    const seen = data.harnessesSeen?.length ? data.harnessesSeen : [data.harness];
    const harnessLabel = seen.map((h) => HARNESS_NAMES[h] || h).filter(Boolean).join(' · ') || 'no harness';
    const demo = data.origin === 'synthetic-demo' ? ' · demo' : '';
    return {
      className: 'text-emerald-400',
      text: `Connected · ${harnessLabel}${data.origin === 'synthetic-demo' ? ' · synthetic demo data' : ''}`,
      short: `● Connected${demo}`,
    };
  }, [data, loadFailed, lastLoadOk, now]);

  async function saveSettings(patch) {
    if (!canPersistSettings || settingsBusy) return;
    setSettingsBusy(true);
    const saveGen = ++settingsSaveGenRef.current;
    try {
      const res = await fetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const saved = await res.json().catch(() => null);
      if (saved && typeof saved === 'object') {
        setData((prev) => {
          if (!prev) return prev;
          const settings = { ...prev.settings, ...saved };
          delete settings.agentApiKey;
          delete settings.agentApiKeyEnc;
          return { ...prev, settings };
        });
      }
      // Wait out in-flight monitor-data polls under the busy guard. Clearing
      // busy immediately (and kicking poll()) let a pre-save script land and
      // remount endpoint Fields from the stale snapshot.
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    } catch (err) {
      window.alert(`Could not save settings: ${err?.message || err}`);
    } finally {
      if (settingsSaveGenRef.current === saveGen) setSettingsBusy(false);
    }
  }

  function selectLane(key) {
    setActiveExtensionId(null);
    // Subagents are hidden from the sidebar; open the parent instead.
    let nextKey = key;
    if (isChatSessionKey(key)) {
      const row = chatSessions.find((s) => s.key === key);
      const parentId = row?.parentId || row?.options?.parentId;
      if (parentId) {
        const parent = chatSessions.find((s) => s.id === parentId);
        if (parent?.key) nextKey = parent.key;
      }
    }
    setSelected(nextKey);
    if (isChatSessionKey(nextKey) && chatSessions.some((s) => s.key === nextKey)) {
      setSessionSubTab('chat');
      setTab('session');
    }
  }

  /**
   * Open (or focus) a workspace file in the left editor drawer.
   * When a chat session is selected, stay on Chat Session so the screen can
   * split as editor | agent chat | plan drawer (dock Plans to the right).
   * @param {string} path
   * @param {{ line?: number, column?: number }} [opts]
   */
  function openWorkspaceFile(path, opts = {}) {
    const rel = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!rel || rel.endsWith('/')) return;
    const line = Number(opts?.line);
    const column = Number(opts?.column);
    setActiveExtensionId(null);
    setEditorTabs((prev) => (
      prev.some((entry) => entry.path === rel)
        ? prev
        : [...prev, { path: rel, name: basenameOfPath(rel) }]
    ));
    setEditorActivePath(rel);
    setEditorReveal(
      Number.isFinite(line) && line > 0
        ? { path: rel, line, column: Number.isFinite(column) && column > 0 ? column : 1 }
        : null,
    );
    // Prefer the 3-pane layout: keep / restore agent chat in the center column.
    if (chatSession) {
      setSessionSubTab('chat');
      setTab('session');
    } else if (tab === 'editor') {
      const saved = readLocal('monitor.tab', 'session');
      setTab(TAB_IDS.includes(saved) ? saved : 'session');
    }
  }

  function closeEditorTab(path) {
    setEditorTabs((prev) => {
      const idx = prev.findIndex((entry) => entry.path === path);
      const next = prev.filter((entry) => entry.path !== path);
      setEditorActivePath((active) => {
        if (active !== path) return active;
        const neighbor = next[Math.min(Math.max(idx, 0), next.length - 1)] || next[0] || null;
        return neighbor?.path || null;
      });
      return next;
    });
  }

  function beginEditorDrawerResize(event) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startW = editorDrawerWidth;
    const paneW = mainPaneRef.current?.getBoundingClientRect().width || 0;
    const maxW = paneW > 0 ? Math.floor(paneW * 0.6) : 720;
    const onMove = (moveEvent) => {
      const next = Math.min(
        maxW,
        Math.max(EDITOR_DRAWER_MIN_WIDTH, startW + (moveEvent.clientX - startX)),
      );
      setEditorDrawerWidth(next);
      writeLocal(EDITOR_DRAWER_WIDTH_KEY, String(next));
    };
    const onUp = () => {
      handle.releasePointerCapture?.(pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Open a chat Agent by id or session key (Plan drawer planner chip, etc.). */
  function openAgentSession(agentIdOrKey) {
    const raw = String(agentIdOrKey || '').trim();
    if (!raw) return;
    const byKey = chatSessions.find((s) => s.key === raw);
    const byId = chatSessions.find((s) => s.id === raw);
    const row = byKey || byId;
    if (row?.key) {
      selectLane(row.key);
      return;
    }
    // Unknown / not yet listed — try the raw value if it already looks like a key.
    if (isChatSessionKey(raw)) selectLane(raw);
  }

  // Extensions (e.g. Atlassian “Attach to Chat”) ask App to focus a session.
  useEffect(() => {
    function onOpenAgent(event) {
      const sessionKey = String(event?.detail?.sessionKey || '').trim();
      if (sessionKey) openAgentSession(sessionKey);
    }
    window.addEventListener('kusa:open-agent', onOpenAgent);
    return () => window.removeEventListener('kusa:open-agent', onOpenAgent);
    // openAgentSession closes over chatSessions; re-bind when the list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSessions]);

  async function createSession({
    provider = 'kusa',
    kind = 'standard',
    workflowId = null,
    attachments = null,
    draftText = null,
    name = null,
  } = {}) {
    if (!canPersistSettings) {
      window.alert('Chat sessions need the local server (npm run kusa:serve).');
      return null;
    }
    const staged = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    const jiraName = staged.find((row) => row?.kind === 'jira' && row?.issueKey)?.issueKey;
    const sessionName = String(name || jiraName || '').trim() || null;
    let session;
    try {
      const res = await fetch('/kusa/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          provider,
          kind,
          ...(workflowId ? { workflowId } : {}),
          ...(sessionName ? { name: sessionName } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      session = body?.session;
    } catch (err) {
      window.alert(`Could not create session: ${err?.message || err}`);
      return null;
    }
    if (!session?.key) return null;
    // Persist Jira tickets into attachments/ticket.json for tools/workflows,
    // and stage the composer tray (session-lifetime; survives Send + refresh).
    const persisted = [];
    for (const row of staged) {
      if (row?.kind === 'jira' && row?.issueKey) {
        const saved = await persistJiraTicketToSession(session.key, {
          key: row.issueKey,
          summary: row.summary,
          url: row.url,
        });
        persisted.push(saved || row);
      } else {
        persisted.push(row);
      }
    }
    const composerAttachments = persisted.length ? persisted : staged;
    // Stage composer payload before selecting the lane so SessionChat's key
    // effect can pick it up on first mount.
    if (composerAttachments.length) {
      try {
        sessionStorage.setItem(
          `kusa:composer-attachments:${session.key}`,
          JSON.stringify(composerAttachments),
        );
      } catch { /* ignore */ }
    }
    if (draftText) {
      try {
        sessionStorage.setItem(`kusa:composer-pending:${session.key}`, String(draftText));
      } catch { /* ignore */ }
    }
    // Leave Extensions / Dev Tools so SessionChat actually mounts and can
    // consume the staged attachments.
    setActiveExtensionId(null);
    setChatSessions((prev) => [session, ...prev.filter((s) => s.key !== session.key)]);
    setSelected(session.key);
    setSessionSubTab('chat');
    setTab('session');
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      writeLocal('monitor.sidebar', 'open');
    }
    // Seed this session's mirror (empty held + any workspace parked) so parked
    // prompts show up immediately; resume then flush as this chat's first turn.
    try {
      const qRes = await fetch(
        `/kusa/queue?queueKey=${encodeURIComponent(session.key)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (qRes.ok) applyQueueSnapshot(session.key, await qRes.json());
    } catch { /* queueForSession can still show parked from another mirror */ }
    // Belt-and-suspenders: if SessionChat is already mounted for this key,
    // the storage effect alone may miss a same-key remount race.
    if (composerAttachments.length) {
      window.dispatchEvent(new CustomEvent('kusa:composer-attach', {
        detail: { sessionKey: session.key, attachments: composerAttachments },
      }));
    }
    poll();
    return session;
  }

  // Always call the latest createSession from the create-agent listener —
  // HMR / Strict Mode can leave an effect bound to a stale closure that drops
  // workflowId / attachments (and thus never writes ticket.json).
  const createSessionRef = useRef(createSession);
  createSessionRef.current = createSession;

  // Extensions (Atlassian Attach → New Session) create an orchestrated agent
  // and optionally stage composer attachments / draft text.
  useEffect(() => {
    function onCreateAgent(event) {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      void createSessionRef.current({
        provider: detail.provider || 'kusa',
        kind: detail.kind || 'standard',
        workflowId: detail.workflowId || null,
        attachments: Array.isArray(detail.attachments) ? detail.attachments : null,
        draftText: detail.draftText || detail.text || null,
        name: detail.name || null,
      });
    }
    window.addEventListener('kusa:create-agent', onCreateAgent);
    return () => window.removeEventListener('kusa:create-agent', onCreateAgent);
  }, []);

  /**
   * Attach to a running server turn (POST /kusa/chat response or
   * GET /kusa/chat/live after refresh). Finalizes the transcript on done/stop;
   * a dropped stream leaves the session busy so a later attach can resume.
   */
  async function attachChatTurn(sessionKey, res) {
    if (!sessionKey || !res) return;
    if (attachedTurns.current.has(sessionKey)) return;
    attachedTurns.current.add(sessionKey);

    const liveSnap = liveSnapBySession.current.get(sessionKey) || emptyLive();
    liveSnapBySession.current.set(sessionKey, liveSnap);
    /** @type {object[] | null} */
    let turnMessages = null;

    const updateLive = (fn) => {
      const next = fn(liveSnap);
      liveSnap.text = next.text || '';
      liveSnap.parts = Array.isArray(next.parts) ? next.parts : [];
      const mirrors = mirrorsFromParts(liveSnap.parts);
      liveSnap.thinking = mirrors.thinking;
      liveSnap.tools = mirrors.tools;
      patchKusaSession(setChatSessions, sessionKey, (s) => ({
        ...s,
        status: 'busy',
        live: {
          ...liveSnap,
          tools: [...liveSnap.tools],
          parts: cloneLiveParts(liveSnap.parts),
        },
      }));
    };

    try {
      if (!res.ok) {
        if (res.status === 404) {
          // No active turn — clear a stale busy overlay from a finished race.
          patchKusaSession(setChatSessions, sessionKey, (s) => ({
            ...s,
            status: s.status === 'busy' || s.status === 'thinking' ? 'idle' : s.status,
            live: null,
          }));
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      const payload = await readSseChat(res, (ev) => {
        if (ev.type === 'snapshot') {
          const live = ev.live && typeof ev.live === 'object' ? ev.live : emptyLive();
          liveSnap.text = live.text || '';
          liveSnap.parts = Array.isArray(live.parts) ? cloneLiveParts(live.parts) : [];
          const mirrors = mirrorsFromParts(liveSnap.parts);
          liveSnap.thinking = mirrors.thinking || live.thinking || '';
          liveSnap.tools = mirrors.tools.length ? mirrors.tools : (live.tools || []);
          const steered = Array.isArray(ev.steered) ? ev.steered : [];
          const userMessage = ev.userMessage && typeof ev.userMessage.text === 'string'
            ? ev.userMessage
            : null;
          patchKusaSession(setChatSessions, sessionKey, (s) => {
            const messages = [...(s.messages || [])];
            // Opening prompt for this turn (server persists it; refresh may load
            // disk before the client's own PUT, so reinject from the snapshot).
            if (userMessage?.text) {
              const hasPrompt = messages.some((m) => (
                m.role === 'user' && (
                  (userMessage.id && m.id === userMessage.id)
                  || (userMessage.turnId && m.turnId === userMessage.turnId)
                  || (m.text === userMessage.text && !m.steered)
                )
              ));
              if (!hasPrompt) {
                messages.push({
                  id: userMessage.id || newMessageId(),
                  role: 'user',
                  text: String(userMessage.text),
                  at: userMessage.at || Date.now(),
                  turnId: userMessage.turnId || ev.turnId || undefined,
                });
              }
            }
            for (const row of steered) {
              if (!row?.text) continue;
              const exists = messages.some(
                (m) => m.id === row.id
                  || (m.role === 'user' && m.steered && m.text === row.text),
              );
              if (!exists) {
                messages.push({
                  id: row.id || newMessageId(),
                  role: 'user',
                  text: String(row.text),
                  at: row.at || Date.now(),
                  steered: true,
                });
              }
            }
            turnMessages = messages;
            return {
              ...s,
              status: 'busy',
              turnId: ev.turnId || s.turnId || null,
              messages,
              live: {
                ...liveSnap,
                tools: [...liveSnap.tools],
                parts: cloneLiveParts(liveSnap.parts),
              },
            };
          });
          return;
        }
        if (ev.type === 'thinking') {
          updateLive((live) => {
            const parts = applyThinkingToParts(live.parts, ev);
            return { ...live, parts };
          });
        } else if (ev.type === 'content') {
          updateLive((live) => ({
            ...live,
            text: typeof ev.text === 'string' ? ev.text : `${live.text}${ev.delta || ''}`,
          }));
        } else if (ev.type === 'tool_start') {
          updateLive((live) => {
            const tool = {
              id: ev.id,
              name: ev.name,
              args: ev.args,
              status: 'running',
            };
            return { ...live, parts: applyToolToParts(live.parts, tool) };
          });
        } else if (ev.type === 'approval_request') {
          updateLive((live) => {
            const approval = {
              id: ev.id,
              toolId: ev.callId || null,
              name: ev.name,
              args: ev.args,
              summary: ev.summary || '',
              message: ev.message || `Allow ${ev.name} — ${ev.summary || ''}?`,
              status: ev.status || 'pending',
              decision: ev.decision || null,
              timeoutMs: Number(ev.timeoutMs) > 0 ? Number(ev.timeoutMs) : null,
              timeoutStartsAt: Number(ev.timeoutStartsAt) > 0 ? Number(ev.timeoutStartsAt) : null,
              timeoutDecision: ev.timeoutDecision || null,
              timeoutDefaultAllowed: ev.timeoutDefaultAllowed === true,
              autoSettled: ev.autoSettled === true,
              reason: ev.reason || null,
              relayed: ev.relayed === true,
              sourceAgentId: ev.sourceAgentId || null,
              sourceRole: ev.sourceRole || null,
              gatePrompt: typeof ev.gatePrompt === 'string' ? ev.gatePrompt : null,
            };
            return { ...live, parts: applyApprovalToParts(live.parts, approval) };
          });
        } else if (ev.type === 'ask_request') {
          updateLive((live) => {
            const ask = {
              id: ev.id,
              callId: ev.callId || null,
              question: ev.question || '',
              options: Array.isArray(ev.options)
                ? ev.options.map((option, index) => ({
                    index,
                    letter: String(option?.letter || String.fromCharCode(97 + index)),
                    label: String(option?.label ?? ''),
                    detail: String(option?.detail ?? ''),
                  }))
                : [],
              questions: Array.isArray(ev.questions)
                ? ev.questions.map((entry, qIndex) => ({
                    index: qIndex,
                    question: String(entry?.question ?? ''),
                    options: Array.isArray(entry?.options)
                      ? entry.options.map((option, index) => ({
                          index,
                          letter: String(option?.letter || String.fromCharCode(97 + index)),
                          label: String(option?.label ?? ''),
                          detail: String(option?.detail ?? ''),
                        }))
                      : [],
                  }))
                : undefined,
              multi: ev.multi === true || (Array.isArray(ev.questions) && ev.questions.length > 1),
              allowFreeText: ev.allowFreeText !== false,
              status: ev.status || 'pending',
              answer: ev.answer && typeof ev.answer === 'object' ? ev.answer : null,
              timeoutMs: Number(ev.timeoutMs) > 0 ? Number(ev.timeoutMs) : null,
              timeoutStartsAt: Number(ev.timeoutStartsAt) > 0 ? Number(ev.timeoutStartsAt) : null,
              reason: ev.reason || null,
              relayed: ev.relayed === true,
              sourceAgentId: ev.sourceAgentId || null,
              sourceRole: ev.sourceRole || null,
              gatePrompt: typeof ev.gatePrompt === 'string' ? ev.gatePrompt : null,
            };
            return { ...live, parts: applyAskToParts(live.parts, ask) };
          });
        } else if (ev.type === 'interrupted') {
          // Soft-steer: freeze the half-finished assistant bubble into history
          // so the next stream's content events start a fresh live.text, and
          // seal thinking so the re-issue opens a new Thought container.
          const partialText = (typeof ev.text === 'string' && ev.text)
            || liveSnap.text
            || '';
          const partialThinking = (typeof ev.thinking === 'string' && ev.thinking)
            || mirrorsFromParts(liveSnap.parts).thinking
            || liveSnap.thinking
            || '';
          if (partialText.trim() || partialThinking.trim()) {
            const row = {
              id: `partial_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              role: 'assistant',
              text: partialText.trim(),
              thinking: partialThinking.trim(),
              at: Date.now(),
              interrupted: true,
            };
            patchKusaSession(setChatSessions, sessionKey, (s) => {
              const msgs = [...(turnMessages || s.messages || []), row];
              turnMessages = msgs;
              return { ...s, messages: msgs };
            });
          }
          updateLive((live) => {
            const parts = Array.isArray(live.parts) ? [...live.parts] : [];
            if (parts.length && parts[parts.length - 1]?.type === 'thinking') {
              parts.push({ type: 'steer_break' });
            }
            return { ...live, text: '', parts };
          });
        } else if (ev.type === 'steer') {
          const steeredText = typeof ev.text === 'string' ? ev.text : '';
          if (!steeredText) return;
          const row = {
            id: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            text: steeredText,
            at: Date.now(),
            steered: true,
          };
          patchKusaSession(setChatSessions, sessionKey, (s) => {
            const msgs = [...(turnMessages || s.messages || []), row];
            turnMessages = msgs;
            return { ...s, messages: msgs };
          });
        } else if (ev.type === 'tool_result') {
          updateLive((live) => {
            const tool = {
              id: ev.id,
              name: ev.name,
              args: ev.args,
              result: ev.result,
              summary: ev.summary,
              ok: ev.ok !== false,
              status: ev.ok === false ? 'error' : 'done',
            };
            return { ...live, parts: applyToolToParts(live.parts, tool) };
          });
        }
      });

      if (!payload || payload.type === 'incomplete') {
        // Connection dropped; leave busy + live and retry attach shortly.
        setTimeout(() => {
          if (!attachedTurns.current.has(sessionKey)
            && !liveSnapBySession.current.has(sessionKey)) {
            void resumeKusaTurn(sessionKey);
          }
        }, 400);
        return;
      }

      const parts = liveSnap.parts || [];
      let tools = mirrorsFromParts(parts).tools;
      if (Array.isArray(payload?.toolTrace) && payload.toolTrace.length && !tools.length) {
        tools = payload.toolTrace.map((t) => ({
          id: t.id || t.name,
          name: t.name,
          args: t.args,
          result: t.result,
          summary: t.summary,
          ok: t.ok !== false,
          status: t.ok === false ? 'error' : 'done',
        }));
      }

      const rawText = typeof payload?.text === 'string' ? payload.text : '';
      const textOut = (rawText && rawText !== '(empty response)')
        ? rawText
        : (liveSnap.text || rawText || '');
      const thinkingOut = mirrorsFromParts(parts).thinking
        || ((typeof payload?.thinking === 'string' && payload.thinking) ? payload.thinking : '')
        || liveSnap.thinking;

      const turnId = payload?.turnId || null;
      const isError = payload?.type === 'error';
      const errorText = isError
        ? String(payload?.text || payload?.message || textOut || 'kusa chat failed')
        : '';
      const assistantMsg = {
        id: newMessageId(),
        role: 'assistant',
        // Keep any thinking/tools already streamed this turn; the error card
        // replaces only the reply body so a mid-turn failure still shows work.
        text: isError
          ? errorText
          : (textOut || (thinkingOut || tools.length ? '' : '(empty response)')),
        thinking: thinkingOut || '',
        tools,
        parts: parts.length ? parts : undefined,
        at: Date.now(),
        turnId: turnId || undefined,
        backend: payload?.backend || null,
        stopped: payload?.type === 'stopped' ? true : undefined,
        ...(isError ? {
          error: true,
          ...(payload?.code ? { code: String(payload.code) } : {}),
        } : {}),
      };

      setChatSessions((prev) => {
        const next = prev.map((s) => {
          if (s.key !== sessionKey) return s;
          const baseMessages = turnMessages || s.messages || [];
          // Idempotent with server persistTurnCompletion (same turnId).
          let messages;
          const existingIdx = turnId
            ? baseMessages.findIndex((m) => m.role === 'assistant' && m.turnId === turnId)
            : -1;
          if (existingIdx >= 0) {
            messages = baseMessages.slice();
            messages[existingIdx] = {
              ...messages[existingIdx],
              ...assistantMsg,
              id: messages[existingIdx].id,
            };
          } else {
            messages = [...baseMessages, assistantMsg];
          }
          const done = {
            ...s,
            status: 'idle',
            live: null,
            turnId: null,
            opencodeSessionId: payload?.opencodeSessionId || s.opencodeSessionId || null,
            messages,
          };
          // Server already persisted; mirror locally for snappy UI.
          persistChatSession(done).catch(() => {});
          return done;
        });
        return next;
      });
      if (Array.isArray(payload?.queued)) {
        applyQueueSnapshot(sessionKey, {
          queued: payload.queued,
          steering: payload.steering || [],
        });
      }
    } catch (err) {
      // Page refresh / navigation aborts the fetch — do not poison the transcript.
      if (err?.name === 'AbortError') return;
      setChatSessions((prev) => prev.map((s) => {
        if (s.key !== sessionKey) return s;
        const msgs = turnMessages || s.messages || [];
        const done = {
          ...s,
          status: 'idle',
          live: null,
          messages: [
            ...msgs,
            {
              id: newMessageId(),
              role: 'assistant',
              text: String(err?.message || err || 'kusa chat failed'),
              thinking: '',
              tools: [],
              at: Date.now(),
              error: true,
            },
          ],
        };
        persistChatSession(done).catch(() => {});
        return done;
      }));
    } finally {
      attachedTurns.current.delete(sessionKey);
      liveSnapBySession.current.delete(sessionKey);
    }
  }

  /** Resume any busy session whose turn is still running on the server. */
  async function resumeKusaTurn(sessionKey) {
    if (!canPersistSettings || !sessionKey) return;
    if (attachedTurns.current.has(sessionKey)) return;
    try {
      // Pull held/steering prompts for this session before (or while) the live
      // stream attaches — refresh clears the UI mirror otherwise.
      try {
        const qRes = await fetch(
          `/kusa/queue?queueKey=${encodeURIComponent(sessionKey)}`,
          { headers: { Accept: 'application/json' } },
        );
        if (qRes.ok) {
          const snap = await qRes.json();
          applyQueueSnapshot(sessionKey, snap);
        }
      } catch { /* queue restore is best-effort */ }
      const res = await fetch(
        `/kusa/chat/live?queueKey=${encodeURIComponent(sessionKey)}`,
        { headers: { Accept: 'text/event-stream' } },
      );
      await attachChatTurn(sessionKey, res);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // Leave busy state; the next sessions poll may clear or retry.
    }
  }

  /**
   * Send a chat turn. Pass `{ editMessageId }` to rewrite a prior user message
   * (VS Code chat style): drop that message and everything after it, then resend.
   * `attachments` are the files the composer staged for this prompt — they ride
   * with it, so a picture or a text file reaches the model exactly as staged.
   */
  async function sendChatMessage(
    sessionKey,
    text,
    {
      editMessageId = null,
      mode = null,
      model = null,
      endpointId = null,
      approvalMode = null,
      attachments = null,
    } = {},
  ) {
    if (!canPersistSettings) {
      window.alert('Kusă chat needs the local server (npm run kusa:serve).');
      return;
    }

    const session = chatSessions.find((s) => s.key === sessionKey);
    if (!session) return;

    const prior = session.messages || [];
    let kept = prior;
    // OpenCode keeps its own transcript — start a fresh session after rewind.
    let opencodeSessionId = editMessageId ? undefined : (session.opencodeSessionId || undefined);
    if (editMessageId) {
      const idx = prior.findIndex((m) => m.id === editMessageId && m.role === 'user');
      if (idx < 0) return;
      kept = prior.slice(0, idx);
    }

    // A file attached to an earlier prompt stays part of that prompt: the loop
    // re-reads history, so an attachment-only turn must survive here too or the
    // model would see a bare "Attached file" note with no owner.
    const history = kept
      .filter((m) => (
        (m.role === 'user' || m.role === 'assistant')
        // Failed turns stay in the transcript UI but must not re-enter the
        // model as assistant content on the next Send.
        && m.error !== true
        && !/^Agent error:\s*/i.test(String(m.text || ''))
      ))
      .map((m) => ({
        role: m.role,
        text: m.text,
        ...(Array.isArray(m.attachments) && m.attachments.length
          ? { attachments: m.attachments }
          : {}),
      }));
    const sessionId = session.id || '';
    const staged = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    const userMsg = {
      id: editMessageId || newMessageId(),
      role: 'user',
      text,
      ...(staged.length ? { attachments: staged } : {}),
      at: Date.now(),
    };
    const turnMessages = [...kept, userMsg];

    const busySession = {
      ...session,
      status: 'busy',
      live: emptyLive(),
      ...(editMessageId ? { opencodeSessionId: null } : {}),
      messages: turnMessages,
    };
    // Claim the turn before flipping busy so the resume effect does not race
    // GET /kusa/chat/live before POST /kusa/chat registers the job.
    liveSnapBySession.current.set(sessionKey, emptyLive());
    setChatSessions((prev) => prev.map((s) => (s.key === sessionKey ? busySession : s)));
    // Persist the user turn before starting the agent so a refresh mid-flight
    // still sees the prompt (server also writes it on POST /kusa/chat).
    await persistChatSession(busySession).catch(() => {});

    try {
      const res = await fetch('/kusa/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          prompt: text,
          history,
          stream: true,
          opencodeSessionId,
          sessionId,
          sessionStart: history.length === 0,
          title: `Kusă ${sessionId}`.trim(),
          mode,
          model,
          // Which Endpoints card the Model pick sat under — probed-only picks
          // need this or resolveAgentEndpoint falls through to Default.
          endpointId,
          approvalMode,
          // The composer's files for THIS prompt. The server normalises them
          // again (see normalizeAttachments) so a hand-edited record cannot
          // smuggle bytes the browser never read.
          ...(staged.length ? { attachments: staged } : {}),
          queueKey: sessionKey,
          // Same id the client wrote — server persistTurnPrompt stays idempotent.
          promptMessageId: userMsg.id,
        }),
      });
      await attachChatTurn(sessionKey, res);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const assistantMsg = {
        id: newMessageId(),
        role: 'assistant',
        text: String(err?.message || err || 'kusa chat failed'),
        thinking: '',
        tools: [],
        at: Date.now(),
        error: true,
      };
      const errSession = {
        ...busySession,
        status: 'idle',
        live: null,
        messages: [...turnMessages, assistantMsg],
      };
      setChatSessions((prev) => prev.map((s) => (s.key === sessionKey ? errSession : s)));
      persistChatSession(errSession).catch(() => {});
      liveSnapBySession.current.delete(sessionKey);
    }
  }

  /** Resolve a gated-tool pause; agent stays blocked until this POST settles. */
  async function resolveChatApproval(sessionKey, { approvalId, allowed }) {
    if (!approvalId) return;
    const nextStatus = allowed ? 'allowed' : 'denied';
    const markApproval = (parts) => (parts || []).map((p) => {
      if (p.type !== 'approval' || p.approval?.id !== approvalId) return p;
      return {
        type: 'approval',
        approval: { ...p.approval, status: nextStatus },
      };
    });

    const snap = liveSnapBySession.current.get(sessionKey);
    if (snap) snap.parts = markApproval(snap.parts);

    patchKusaSession(setChatSessions, sessionKey, (s) => {
      if (!s?.live?.parts) return s;
      const parts = markApproval(s.live.parts);
      const mirrors = mirrorsFromParts(parts);
      return {
        ...s,
        live: {
          ...s.live,
          parts: cloneLiveParts(parts),
          tools: mirrors.tools,
          thinking: mirrors.thinking,
        },
      };
    });
    const res = await fetch('/kusa/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: approvalId, allowed: allowed === true }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Approval failed (HTTP ${res.status})`);
    }
  }

  /**
   * Answer a kusa_ask question card. The agent stays blocked until this POST
   * settles, exactly like an approval — but there is no rule default here, so
   * the only way a question moves forward is a human clicking option(s) or
   * answering in the message composer (any prompt while open is freeText).
   * Single: optionIndex / optionLabel / freeText. Multi: answers[] (one pick
   * per question) or freeText for the whole card.
   */
  async function resolveChatAsk(sessionKey, {
    askId,
    optionIndex = null,
    optionLabel = null,
    freeText = null,
    answers = null,
  }) {
    if (!askId) return;
    // No optimistic answer — the gate waits indefinitely, and the server
    // decides whether freeText matched an option or is custom. SSE applies
    // the settled ask (status + answer) when createAskGate emits it.
    // sessionKey is kept for call-site symmetry with approvals / onAsk.
    const res = await fetch('/kusa/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: askId,
        ...(optionIndex != null ? { optionIndex } : {}),
        ...(optionLabel ? { optionLabel } : {}),
        ...(freeText ? { freeText } : {}),
        ...(Array.isArray(answers) ? { answers } : {}),
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Answer failed (HTTP ${res.status})`);
    }
  }

  /**
   * Persist the composer's Agent / Mode / Rule / Model picks onto THIS session's
   * record. Pickers belong to a chat, not to the browser: another session keeps
   * its own, and one that never picked keeps following Settings → Kusă agent.
   * Also handles Mode → Orchestrator conversion (kind / workflowId / role /
   * allow*Override). Written straight to disk so a refresh — even mid-turn —
   * reopens the chat with the same pickers.
   */
  async function updateChatSessionOptions(sessionKey, {
    mode = null,
    rules = null,
    model = null,
    endpointId = null,
    provider = null,
    kind = null,
    workflowId = null,
    role = null,
    allowModeOverride = null,
    allowRuleOverride = null,
    allowModelOverride = null,
  } = {}) {
    if (!canPersistSettings || !sessionKey) return;
    const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    const kindId = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
    const patch = {
      ...(mode ? { mode } : {}),
      ...(rules ? { rules } : {}),
      ...(model ? { model } : {}),
      // Allow clearing back to Default when the user picks a Default model.
      ...(endpointId != null ? { endpointId: String(endpointId).trim() } : {}),
      ...(providerId ? { provider: providerId === 'github-copilot' ? 'copilot' : providerId } : {}),
      ...(kindId ? { kind: kindId } : {}),
      ...(allowModeOverride != null ? { allowModeOverride: allowModeOverride === true } : {}),
      ...(allowRuleOverride != null ? { allowRuleOverride: allowRuleOverride === true } : {}),
      ...(allowModelOverride != null ? { allowModelOverride: allowModelOverride === true } : {}),
    };
    // workflowId / role: present (including '') means set-or-clear for Orchestrator take-back.
    const clearWorkflow = workflowId !== null && typeof workflowId === 'string' && !workflowId.trim();
    const clearRole = role !== null && typeof role === 'string' && !role.trim();
    if (typeof workflowId === 'string' && workflowId.trim()) patch.workflowId = workflowId.trim();
    if (typeof role === 'string' && role.trim()) patch.role = role.trim().toLowerCase();
    if (!Object.keys(patch).length && !clearWorkflow && !clearRole && kindId !== 'standard') return;
    const session = chatSessions.find((s) => s.key === sessionKey);
    if (!session) return;
    // Merge with what the record already says: one picker changing must never
    // erase the others, or a refresh would reopen the chat half-picked.
    const options = { ...(session?.options || {}), ...patch };
    if (clearWorkflow || kindId === 'standard') delete options.workflowId;
    if (clearRole || kindId === 'standard') delete options.role;
    if (kindId === 'standard') {
      options.kind = 'standard';
      delete options.allowModeOverride;
      delete options.allowRuleOverride;
      delete options.allowModelOverride;
    }
    const nextProviderRaw = options.provider || session.provider || 'kusa';
    const nextProvider = nextProviderRaw === 'github-copilot' ? 'copilot' : nextProviderRaw;
    const nextKind = options.kind || session.kind || 'standard';
    const providerGroup = CHAT_PROVIDER_GROUPS.find((g) => (
      g.id === nextProvider || g.harness === nextProvider
    ));
    const nextHarness = providerGroup?.harness || session.harness || 'kusa';
    const nextKey = `${nextHarness}:${session.id}`;
    // Adapter/CAO providers don't use BYOK endpoints; Cursor owns its model list.
    const cliBacked = nextProvider === 'cursor' || nextProvider === 'copilot';
    const ownsModels = nextProvider === 'cursor';
    const top = {
      provider: nextProvider,
      kind: nextKind,
      harness: nextHarness,
      key: nextKey,
      // Kusă-initiated provider switches stay owned here (not Cursor UI).
      external: false,
      cliBacked,
      ownsModels,
      modelsPath: ownsModels ? '/adapters/cursor/models' : null,
      workspaceTrust: nextProvider === 'cursor'
        ? (session.workspaceTrust || {
          path: '/adapters/cursor/trust',
          label: 'Trust workspace',
          title: 'Cursor workspace trust required',
          summary: '',
        })
        : null,
    };
    // Allow / Deny are sticky, so the record carries no expiry at all: nothing
    // here can disagree with a live picker about whether a rule is still in
    // effect, and a refresh reopens the chat on the rule the user chose.
    setChatSessions((prev) => prev.map((s) => (
      s.key === sessionKey || s.id === session.id ? { ...s, ...top, options } : s
    )));
    if (selected === sessionKey && nextKey !== sessionKey) setSelected(nextKey);
    try {
      const saved = await persistChatSession({ ...session, ...top, options });
      if (saved?.key) {
        setChatSessions((prev) => prev.map((s) => (
          s.id === session.id
            ? { ...s, ...saved, live: s.live, status: s.status }
            : s
        )));
        if (selected === sessionKey || selected === nextKey) setSelected(saved.key);
      }
    } catch {
      /* the pickers still apply this session; only a refresh could lose them */
    }
  }

  /**
   * Mid-turn composer Mode / Rules. The running loop applies these at its next
   * step boundary (tools + system prompt + approval gate), so a picker change
   * while busy does not wait for the turn to finish.
   */
  async function updateChatTurnOptions(sessionKey, { mode = null, approvalMode = null } = {}) {
    if (!canPersistSettings || !sessionKey) return null;
    try {
      const res = await fetch('/kusa/chat/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          queueKey: sessionKey,
          ...(mode != null ? { mode } : {}),
          ...(approvalMode != null ? { approvalMode } : {}),
        }),
      });
      if (!res.ok) {
        // No active turn (or race after Stop) — the next Send carries the pickers.
        return null;
      }
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  }

  /**
   * Composer queue for a running turn (the server owns it; see POST/GET
   * /kusa/queue). Actions: enqueue = hold it, send = "send now" (steer the
   * running loop — the loop polls it per streamed chunk, so the prompt
   * interrupts the model call in flight), remove = take it out of the queued
   * list, take = claim it so a flush cannot send it twice, edit = rewrite a
   * held prompt's text in place (id + position + options stay), reorder = set
   * held order from `{ ids }`.
   * Every response re-applies the snapshot, so the UI mirror cannot drift.
   */
  async function queueKusaMessage(sessionKey, action, { text = '', id = '', options = null, ids = null } = {}) {
    if (!canPersistSettings || !sessionKey) return null;
    const res = await fetch('/kusa/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        queueKey: sessionKey,
        action,
        text,
        id,
        options,
        ...(Array.isArray(ids) ? { ids } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Queue failed (HTTP ${res.status})`);
    }
    applyQueueSnapshot(sessionKey, body);
    return body;
  }

  const applyQueueSnapshot = (sessionKey, snapshot) => {
    if (!sessionKey) return;
    setQueueByKey((prev) => {
      const next = new Map(prev);
      const queued = Array.isArray(snapshot?.queued) ? snapshot.queued : [];
      const steering = Array.isArray(snapshot?.steering) ? snapshot.steering : [];
      // Parked rows are workspace-shared — refresh them on every other session
      // mirror without replacing that session's held (unparked) prompts.
      const parked = queued.filter((entry) => entry?.paused);
      for (const [key, value] of next) {
        if (key === sessionKey) continue;
        const held = (value?.queued || []).filter((entry) => !entry?.paused);
        const nextQueued = [...held, ...parked];
        const nextSteering = value?.steering || [];
        if (!nextQueued.length && !nextSteering.length) next.delete(key);
        else next.set(key, { queued: nextQueued, steering: nextSteering });
      }
      if (!queued.length && !steering.length) next.delete(sessionKey);
      else next.set(sessionKey, { queued, steering });
      return next;
    });
  };

  /**
   * Composer-facing queue call: never rejects, tells the user what went wrong.
   * "Send now" while idle is not steering (nothing is running to inject into) —
   * claim the prompt and start a normal turn so a new/empty session gets it as
   * its first prompt.
   */
  function queueFromComposer(sessionKey, action, opts = {}) {
    return (async () => {
      try {
        if (action === 'send' && opts?.id) {
          const session = chatSessions.find((s) => s.key === sessionKey);
          const busy = Boolean(
            session
            && (session.status === 'busy' || session.status === 'thinking' || session.live),
          );
          if (!busy) {
            const before = queueForSession(queueByKey, sessionKey);
            const entry = [...(before?.queued || []), ...(before?.steering || [])]
              .find((row) => row?.id === opts.id);
            const body = await queueKusaMessage(sessionKey, 'take', { id: opts.id });
            const text = String(entry?.text || '').trim();
            const options = entry?.options || {};
            const staged = Array.isArray(options.attachments) ? options.attachments : [];
            // A held prompt may be nothing but a picture — it still sends.
            if (!text && !staged.length) return body;
            await sendChatMessage(sessionKey, text, {
              mode: options.mode || null,
              model: options.model || null,
              endpointId: options.endpointId || null,
              approvalMode: options.approvalMode || null,
              // The files the composer staged when the prompt was queued: a
              // flushed prompt must behave exactly as pressing Send then did.
              attachments: options.attachments || null,
            });
            return body;
          }
        }
        return await queueKusaMessage(sessionKey, action, opts);
      } catch (err) {
        window.alert(`Could not change the queue: ${err?.message || err}`);
        return null;
      }
    })();
  }

  /** One flush at a time per session — the flush itself re-enters this path. */
  const flushGuard = useRef(new Set());

  /** Held prompts become normal follow-up turns, in order, once a turn ends. */
  async function flushQueuedMessages(sessionKey) {
    if (!canPersistSettings || !sessionKey) return;
    const guard = flushGuard.current;
    if (guard.has(sessionKey)) return;
    guard.add(sessionKey);
    try {
      let held = [];
      try {
        const res = await fetch(
          `/kusa/queue?queueKey=${encodeURIComponent(sessionKey)}`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok) return;
        const body = await res.json();
        held = Array.isArray(body?.queued) ? body.queued : [];
        // The server is the queue's owner — adopt its view so the UI mirror and
        // this flush can never disagree (or loop forever on a stale mirror).
        applyQueueSnapshot(sessionKey, body);
      } catch {
        return;
      }
      for (const entry of held) {
        const text = String(entry?.text || '');
        const staged = Array.isArray(entry?.options?.attachments)
          ? entry.options.attachments
          : [];
        // A prompt may be nothing but a picture, so "no text" only skips a row
        // that carries neither text nor files.
        if (!text.trim() && !staged.length) continue;
        // A parked prompt is not sent when the run ends — the user decides
        // later (Send now, Resume, or Remove). Skip it WITHOUT claiming it,
        // so a later resume still finds it in the queue.
        if (entry?.paused) continue;
        // Claim first: if another flush already took it, `take` 404s and we stop.
        try {
          await queueKusaMessage(sessionKey, 'take', { id: entry?.id });
        } catch {
          return;
        }
        const options = entry?.options || {};
        await sendChatMessage(sessionKey, text, {
          mode: options.mode || null,
          model: options.model || null,
          endpointId: options.endpointId || null,
          approvalMode: options.approvalMode || null,
          attachments: options.attachments || null,
        });
      }
    } finally {
      guard.delete(sessionKey);
    }
  }

  /**
   * Composer Stop button. POST /kusa/stop aborts this session's running turn
   * through its AbortController — the agent loop checks the signal at every step
   * boundary and cancels the response reader mid-stream, so the run ends at the
   * next safe point and the stream closes with a `stopped` frame carrying
   * whatever was already produced. The snapshot in the response keeps the queue
   * mirror current, so the idle-flush effect above immediately sends the next
   * held prompt: one click stops the current prompt AND loads the next one.
   */
  async function stopChatTurn(sessionKey) {
    if (!canPersistSettings || !sessionKey) return;
    try {
      const res = await fetch('/kusa/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ queueKey: sessionKey }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Stop failed (HTTP ${res.status})`);
      applyQueueSnapshot(sessionKey, body);
    } catch (err) {
      window.alert(`Could not stop the run: ${err?.message || err}`);
    }
  }

  function toggleChecked(keys, forceOn) {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (forceOn === true) next.add(key);
        else if (forceOn === false) next.delete(key);
        else if (next.has(key)) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  /**
   * Toggle the session's archived flag and persist it. Archived rows leave the
   * default Agents list (see matchesFilter) until the Status filter includes
   * Archived — no confirm dialog; the list change is the feedback.
   */
  async function setSessionArchived(sessionKey, archived) {
    if (!sessionKey || !canDelete) return;
    const session = chatSessions.find((s) => s.key === sessionKey);
    if (!session) return;
    // Subagents belong to their parent — archive/unarchive via the parent only.
    if (session.parentId || session.options?.parentId) return;
    const flag = archived === true;
    const archivedAt = flag ? Date.now() : null;
    const rootId = session.id;
    const descendantIds = new Set();
    {
      const byParent = new Map();
      for (const s of chatSessions || []) {
        const pid = s?.parentId || s?.options?.parentId;
        if (!pid || !s?.id) continue;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(s.id);
      }
      const walk = (pid) => {
        for (const id of byParent.get(pid) || []) {
          descendantIds.add(id);
          walk(id);
        }
      };
      walk(rootId);
    }
    const patch = (s) => {
      if (s.key !== sessionKey && !descendantIds.has(s.id)) return s;
      return { ...s, archived: flag, archivedAt };
    };
    const nextSessions = (chatSessions || []).map(patch).filter((s) => (
      s.key === sessionKey || descendantIds.has(s.id)
    ));
    setChatSessions((prev) => prev.map(patch));
    try {
      await Promise.all(nextSessions.map((s) => persistChatSession(s)));
    } catch {
      /* optimistic UI; next poll / refresh restores disk */
    }
  }

  /**
   * Session delete, in two moves. The sidebar's per-row trash button and its
   * bulk "Delete N" button both land here, and this only opens the gate:
   * `pendingDelete` is the request ConfirmDialog shows, and nothing is removed
   * until that dialog's own confirm button calls `runDelete`. A destructive
   * click therefore ends on a button that names the same action, in the same
   * danger tint as the glyph that asked for it, with the affected sessions
   * listed above it — instead of an OK/Cancel strip the user cannot aim at
   * anything. A second request while the gate is open is ignored: the dialog
   * already states exactly what will be deleted, and it covers the page, so the
   * sidebar cannot be re-clicked behind it.
   */
  function deleteKeys(keys) {
    if (deleteBusy || pendingDelete) return;
    // Subagents nest under a parent — only top-level Agents are deletable here.
    const subKeys = new Set(
      (chatSessions || [])
        .filter((s) => s?.parentId || s?.options?.parentId)
        .map((s) => s.key)
        .filter(Boolean),
    );
    const list = [...new Set((keys || []).filter((key) => key && !subKeys.has(key)))];
    if (!list.length) return;

    if (!canDelete) {
      window.alert('Session delete needs the local server (npm run kusa:serve).');
      return;
    }

    setPendingDelete({ keys: list });
  }

  async function runDelete({ force = false } = {}) {
    const list = pendingDelete?.keys || [];
    if (!list.length || deleteBusy) return;
    const chatKeys = list.filter(isChatSessionKey);
    // Force only applies after EPLAN_LOCK — otherwise leave the gate as a
    // normal confirm. Callers that already know plans block can pass force.
    const forceDelete = force === true || pendingDelete?.code === 'EPLAN_LOCK';

    setDeleteBusy(true);
    try {
      const res = await fetch('/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: list, ...(forceDelete ? { force: true } : {}) }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        // Plan still owns this Agent — keep the gate open and switch the
        // confirm button to Force delete (server drops the plan first).
        if (detail?.code === 'EPLAN_LOCK') {
          const plans = Array.isArray(detail.plans) ? detail.plans.filter(Boolean) : [];
          setPendingDelete({
            keys: list,
            code: 'EPLAN_LOCK',
            plans,
            error: detail?.error || 'Delete the plan first',
          });
          return;
        }
        throw new Error(detail?.error || `HTTP ${res.status}`);
      }
      const body = await res.json().catch(() => ({}));
      const deleted = Array.isArray(body?.deleted) ? body.deleted.filter(Boolean) : [];
      const missing = Array.isArray(body?.missing) ? body.missing.filter(Boolean) : [];
      // HTTP 200 with an empty deleted list used to close the dialog while the
      // row came straight back on the next poll (chat key ≠ monitor lane key).
      if (!deleted.length) {
        throw new Error(
          missing.length
            ? `session not found on disk (${missing.join(', ')})`
            : 'session not found on disk',
        );
      }
      const deletedSet = new Set(deleted);
      const deletedChatKeys = chatKeys.filter((key) => deletedSet.has(key));
      // The gate closes only once the files are gone. Partial deletes keep the
      // missing keys in the dialog so the user can see what still failed.
      if (missing.length) {
        setPendingDelete({
          keys: missing,
          error: `Deleted ${deleted.length}, but could not remove: ${missing.join(', ')}`,
        });
      } else {
        setPendingDelete(null);
      }
      if (deletedChatKeys.length) {
        setChatSessions((prev) => prev.filter((s) => !deletedSet.has(s.key)));
        // Drop that session's held + steering mirrors. Keep workspace parked
        // visible on remaining chats (do not leak the deleted chat's held).
        setQueueByKey((prev) => {
          const next = new Map(prev);
          for (const key of deletedChatKeys) {
            const snap = next.get(key);
            next.delete(key);
            const parked = (snap?.queued || []).filter((entry) => entry?.paused);
            if (!parked.length) continue;
            for (const [otherKey, other] of next) {
              const held = (other?.queued || []).filter((entry) => !entry?.paused);
              next.set(otherKey, {
                queued: [...held, ...parked],
                steering: other?.steering || [],
              });
            }
          }
          return next;
        });
      }
      setCheckedKeys((prev) => {
        const next = new Set(prev);
        for (const key of deleted) next.delete(key);
        return next;
      });
      if (deleted.includes(selected) || deleted.includes(laneKey)) {
        setSelected(null);
      }
      poll();
    } catch (err) {
      // Keep the gate open with the reason inside it: the user can retry the
      // same set or walk away from it, instead of losing the request on a
      // hiccup they were never offered a second chance about.
      setPendingDelete({
        keys: list,
        error: `Could not delete session(s): ${err?.message || err}`,
      });
    } finally {
      setDeleteBusy(false);
    }
  }

  function toggleTool(name) {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      writeJsonSet('monitor.expandedTools', next);
      return next;
    });
  }

  function togglePrompt(key, open) {
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      writeJsonSet('monitor.expandedPrompts', next);
      return next;
    });
  }

  const sessionChatFill = Boolean(chatSession) && tab === 'session';
  const editorOpen = editorTabs.length > 0;
  const mainFill = (sessionChatFill || editorOpen) && !activeExtensionId;
  // Atlassian board needs a locked viewport height so the kanban h-scrollbar
  // stays on-screen without scrolling the main pane.
  const atlassianFill = activeExtensionId === 'atlassian-adapter';
  const sessionSubTabIds = chatSession
    ? SESSION_SUBTAB_IDS
    : SESSION_SUBTAB_IDS.filter((id) => id !== 'chat');

  /**
   * Sub-views keyed by the rail icon that owns them. RightRail renders each one
   * as a context menu beside its icon (RailSubmenu), so the pane topbar no
   * longer carries a horizontal strip — and because every icon offers its own
   * menu, clicking a sub-view switches section AND view in one gesture. That is
   * why each `onChange` sets the rail tab too, not just the sub-view.
   *
   * `ids` still honours what is available right now: Chat is only offered while
   * a Kusă session is selected, exactly as the strip used to hide it.
   */
  const railSubTabs = {
    session: {
      ids: sessionSubTabIds,
      labels: SESSION_SUBTAB_LABELS,
      value: sessionSubTab,
      onChange: (next) => {
        setActiveExtensionId(null);
        setSessionSubTab(next);
        setTab('session');
      },
      idPrefix: 'session',
      ariaLabel: 'Chat session views',
    },
    harness: {
      ids: HARNESS_SUBTAB_IDS,
      labels: HARNESS_SUBTAB_LABELS,
      value: harnessSubTab,
      onChange: (next) => {
        setActiveExtensionId(null);
        setHarnessSubTab(next);
        setTab('harness');
      },
      idPrefix: 'harness',
      ariaLabel: 'Harness views',
    },
    devtools: {
      // Strata only joins the menu after the Kusă agent endpoint confirms.
      ids: strataOnRail ? [...DEVTOOLS_SUBTAB_IDS, 'strata'] : DEVTOOLS_SUBTAB_IDS,
      labels: DEVTOOLS_SUBTAB_LABELS,
      value: devtoolsSubTab,
      onChange: (next) => {
        setDevtoolsSubTab(next);
        setTab('devtools');
        const navExt = extensionNavEntries('devtools').find((e) => e.id === next);
        setActiveExtensionId(navExt?.extensionId || null);
      },
      idPrefix: 'devtools',
      ariaLabel: 'Developer tool views',
      itemStatus: {
        ...(detectTrail && trailStatus
          ? {
              trail: {
                tone: trailStatus.ok ? 'ok' : 'down',
                title: trailStatus.ok
                  ? 'Trail is ready'
                  : 'Trail is missing, needs upgrade from Graft, or is not initialized in this workspace',
              },
            }
          : {}),
        ...(detectGit && gitStatus
          ? {
              git: {
                tone: gitStatus.ok ? 'ok' : 'down',
                title: gitStatus.ok
                  ? 'Git is ready'
                  : 'Git is not installed or this workspace is not a git repository',
              },
            }
          : {}),
        ...(caoOnRail && devtoolsExtReady.cao
          ? {
              cao: {
                tone: devtoolsExtReady.cao.ok ? 'ok' : 'down',
                title: devtoolsExtReady.cao.ok
                  ? 'CLI Agent Orchestrator is ready'
                  : 'CLI Agent Orchestrator is not ready (cao CLI missing or cao-server down)',
              },
            }
          : {}),
        ...(liveChatOnRail && devtoolsExtReady.liveChat
          ? {
              'live-chat': {
                tone: devtoolsExtReady.liveChat.ok ? 'ok' : 'down',
                title: devtoolsExtReady.liveChat.ok
                  ? 'Live Chat browser voice ready'
                  : 'Live Chat voice unavailable',
              },
            }
          : {}),
        ...(strataOnRail
          ? {
              strata: {
                tone: strataBadge ? 'down' : 'ok',
                title: strataStatus?.ok === false
                  ? 'Strata endpoint is unreachable'
                  : strataStatus?.loaded === false
                    ? (strataStatus.model
                      ? `Strata ready · ${strataStatus.model} unloaded`
                      : 'Strata ready · model unloaded')
                    : (strataStatus?.model
                      ? `Strata ready · ${strataStatus.model}`
                      : 'Strata endpoint confirmed'),
              },
            }
          : {}),
      },
    },
    settings: {
      ids: SETTINGS_SUBTAB_IDS,
      labels: SETTINGS_SUBTAB_LABELS,
      value: settingsSubTab,
      onChange: (next) => {
        setActiveExtensionId(null);
        setSettingsSubTab(next);
        setTab('settings');
      },
      idPrefix: 'settings',
      ariaLabel: 'Settings views',
    },
  };

  /**
   * The pending delete, phrased for the dialog. Labels come from the same
   * session objects the sidebar lists, so the dialog names the rows the user
   * clicked — a raw `claude-code:…` key would be a confirmation of something
   * they cannot recognise, and the rows themselves sit behind the overlay.
   */
  const deleteDialog = useMemo(() => {
    if (!pendingDelete) return null;
    const keys = pendingDelete.keys;
    const byKey = new Map();
    for (const h of data?.harnesses || []) {
      for (const s of h.sessions || []) byKey.set(s.key, sessionLabel(s));
    }
    for (const s of chatSessions) byKey.set(s.key, sessionLabel(s));
    const labels = keys.map((key) => byKey.get(key) || key);
    const plans = Array.isArray(pendingDelete.plans) ? pendingDelete.plans : [];
    const planLocked = pendingDelete.code === 'EPLAN_LOCK' && plans.length > 0;
    const planLabels = plans.map((p) => `Plan: ${p.name || p.id}`);
    return {
      open: true,
      title: keys.length === 1 ? `Delete ${labels[0]}` : `Delete ${keys.length} sessions`,
      detail: planLocked
        ? (
          plans.length === 1
            ? 'A linked plan still owns this Agent. Force delete removes the plan with the session and cannot be undone.'
            : `${plans.length} linked plans still own these Agents. Force delete removes those plans with the sessions and cannot be undone.`
        )
        : 'This removes their session files, task lists, and per-session settings, and cannot be undone.',
      items: planLocked ? [...labels, ...planLabels] : labels,
      confirmLabel: planLocked
        ? (plans.length === 1 ? 'Force delete' : `Force delete (${plans.length} plans)`)
        : (keys.length === 1 ? 'Delete session' : `Delete ${keys.length} sessions`),
      cancelLabel: keys.length === 1 ? 'Keep it' : 'Keep them',
      error: pendingDelete.error,
    };
  }, [pendingDelete, data, chatSessions]);

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar
        data={data}
        selected={laneKey}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => {
          const next = !sidebarCollapsed;
          setSidebarCollapsed(next);
          writeLocal('monitor.sidebar', next ? 'collapsed' : 'open');
        }}
        onSelectLane={selectLane}
        onNewSession={createSession}
        chatSessions={chatSessions}
        agentsLoading={!chatSessionsReady}
        sessionFilter={sessionFilter}
        onSessionFilterChange={(next) => {
          const normalized = normalizeSessionFilter(next);
          setSessionFilter(normalized);
          writeLocal('monitor.sessionFilter', JSON.stringify(normalized));
        }}
        selectMode={selectMode}
        onSelectModeChange={setSelectMode}
        checkedKeys={checkedKeys}
        onToggleChecked={toggleChecked}
        onClearChecked={() => setCheckedKeys(new Set())}
        onDeleteKeys={deleteKeys}
        onArchiveSession={setSessionArchived}
        canDelete={canDelete && !deleteBusy}
        deleteGate={Boolean(pendingDelete)}
        statusLine={statusLine}
        statusLane={lane}
        statusChatSession={chatSession}
        canPersistExtensions={canDelete}
        activeExtensionId={activeExtensionId}
        onSelectExtension={(id) => {
          openExtension(id, { setActiveExtensionId, setDevtoolsSubTab });
          if (sidebarCollapsed) {
            setSidebarCollapsed(false);
            writeLocal('monitor.sidebar', 'open');
          }
        }}
        onOpenFile={openWorkspaceFile}
      />

      <main
        ref={mainPaneRef}
        className={`min-w-0 flex-1 ${mainFill || editorOpen || atlassianFill ? 'flex overflow-hidden' : 'overflow-y-auto'}`}
      >
        {editorOpen ? (
          <aside
            className="editor-drawer-in relative flex h-full min-h-0 shrink-0 flex-col border-r border-gray-800 bg-gray-950"
            style={{ width: editorDrawerWidth, maxWidth: '60%' }}
            aria-label="Code editor"
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={editorDrawerWidth}
              aria-valuemin={EDITOR_DRAWER_MIN_WIDTH}
              aria-label="Resize editor width"
              title="Drag to resize"
              onPointerDown={beginEditorDrawerResize}
              className="absolute inset-y-0 -right-0.5 z-10 w-2 cursor-ew-resize touch-none hover:bg-emerald-500/25"
            />
            <EditorPaneBoundary>
              <Suspense
                fallback={
                  <div className="flex h-full min-h-0 flex-1 items-center justify-center px-6">
                    <p className="text-xs text-gray-500">Loading editor…</p>
                  </div>
                }
              >
                <EditorWorkbench
                  tabs={editorTabs}
                  activePath={editorActivePath}
                  reveal={editorReveal}
                  theme={theme}
                  onSelectTab={setEditorActivePath}
                  onCloseTab={closeEditorTab}
                  onRevealHandled={() => setEditorReveal(null)}
                />
              </Suspense>
            </EditorPaneBoundary>
          </aside>
        ) : null}
        <div
          id={activeExtensionId ? `extension-panel-${activeExtensionId}` : `panel-${tab}`}
          role="tabpanel"
          aria-labelledby={activeExtensionId ? 'sidebar-view-extensions' : `tab-${tab}`}
          className={
            mainFill
              ? 'flex min-h-0 min-w-0 flex-1 flex-col'
              : atlassianFill
                ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-6 py-4'
                : editorOpen
                  ? 'min-h-0 min-w-0 flex-1 overflow-y-auto space-y-8 px-6 py-4 pb-6'
                  : 'space-y-8 px-6 py-4 pb-6'
          }
        >
          {activeExtensionId ? (
            <ExtensionPage extensionId={activeExtensionId} canPersist={canDelete} />
          ) : (
            <>
              {tab === 'session' && (
                <SessionPanel
                  subTab={sessionSubTab}
                  prompts={lane?.prompts || []}
                  expandedPrompts={expandedPrompts}
                  onTogglePrompt={togglePrompt}
                  lane={lane}
                  toolWarnMs={data?.toolWarnMs ?? 1e12}
                  now={now}
                  expandedTools={expandedTools}
                  onToggleTool={toggleTool}
                  chatSession={chatSession}
                  peerSessions={peerSessions}
                  lanes={data?.lanes || null}
                  chatQueue={queueForSession(queueByKey, chatSession?.key)}
                  onSendMessage={sendChatMessage}
                  onQueueMessage={queueFromComposer}
                  onStopTurn={stopChatTurn}
                  onApproval={resolveChatApproval}
                  onAsk={resolveChatAsk}
                  onTurnOptions={updateChatTurnOptions}
                  onSessionOptions={updateChatSessionOptions}
                  onOpenAgent={openAgentSession}
                  agentDefaults={{
                    mode: 'agent',
                    rules: settings.agentApprovalMode || 'ask-deny',
                    model: settings.agentModel || '',
                    avatar: settings.agentAvatar || '',
                    approvalTimeoutMinutes: settings.agentApprovalTimeoutMinutes ?? 2,
                    allowDenyRevertMinutes: settings.agentAllowDenyRevertMinutes ?? 15,
                    // Fingerprint of every active endpoint so SessionChat reloads
                    // /kusa/models after Settings adds, renames, or re-lists models.
                    modelsRevision: [
                      settings.agentBaseUrl || '',
                      settings.agentModel || '',
                      ...(Array.isArray(settings.agentModels) ? settings.agentModels : []),
                      ...(Array.isArray(settings.agentEndpoints) ? settings.agentEndpoints : []).flatMap((entry) => ([
                        entry?.id || '',
                        entry?.name || '',
                        entry?.baseUrl || '',
                        ...(Array.isArray(entry?.models) ? entry.models : []),
                      ])),
                    ].join('\0'),
                  }}
                />
              )}
              {tab === 'harness' && (
                <HarnessPanel
                  subTab={harnessSubTab}
                  canPersist={canPersistSettings}
                  lane={lane}
                  now={now}
                  tokens={lane?.tokens}
                  tokenTurns={lane?.tokenTurns}
                  recent={lane?.recent}
                  warnings={lane?.warnings}
                  notes={lane?.notes}
                  errors={data?.errors}
                />
              )}
              {tab === 'devtools' && (
                <DevToolsPanel
                  subTab={devtoolsSubTab}
                  trail={lane?.trail}
                  trailStatus={trailStatus}
                  detectTrail={detectTrail}
                  enforceTrail={enforceTrail}
                  canLiveRefreshTrail={canDelete && detectTrail}
                  git={gitStatus}
                  detectGit={detectGit}
                  enforceGit={enforceGit}
                  canLiveRefreshGit={canDelete && detectGit}
                  canLiveRefreshStrata={canDelete}
                  canPersistCao={canDelete}
                />
              )}
              {tab === 'settings' && (
                <SettingsPanel
                  subTab={settingsSubTab}
                  settings={data?.settings}
                  canPersist={canPersistSettings}
                  settingsBusy={settingsBusy}
                  onSettingsChange={saveSettings}
                />
              )}
              {tab === 'user' && (
                <UserPanel
                  settings={data?.settings}
                  canPersist={canPersistSettings}
                  settingsBusy={settingsBusy}
                  onSettingsChange={saveSettings}
                  theme={theme}
                  onThemeChange={setTheme}
                />
              )}
            </>
          )}
        </div>
      </main>

      <RightRail
        // Catalog select owns the main pane — deselect the rail unless we're
        // already on Dev Tools (extension nav placement / rail › CAO).
        tab={activeExtensionId && tab !== 'devtools' ? null : tab}
        onTabChange={(next) => {
          setActiveExtensionId(null);
          setTab(next);
        }}
        subTabs={railSubTabs}
        theme={theme}
        onThemeChange={setTheme}
        userName={data?.settings?.authUsername || ''}
        trailBadge={trailBadge}
        gitBadge={gitBadge}
        caoBadge={caoBadge}
        liveChatBadge={liveChatBadge}
        strataBadge={strataBadge}
      />

      {deleteDialog ? (
        <ConfirmDialog
          {...deleteDialog}
          icon={TrashIcon}
          disabled={deleteBusy}
          onConfirm={() => runDelete()}
          onDismiss={() => setPendingDelete(null)}
        />
      ) : null}

      {isExtensionInstalled(getBuiltinExtension('atlassian-adapter')) ? (
        <AtlassianIssueBridge canPersist={canPersistSettings} />
      ) : null}
    </div>
  );
}
