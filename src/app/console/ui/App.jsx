import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DevToolsPanel } from './shared/DevToolsPanel.jsx';
import { HarnessPanel } from './shared/HarnessPanel.jsx';
import { MonitorsPanel } from './shared/MonitorsPanel.jsx';
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
import { Sidebar } from './features/monitor/Sidebar.jsx';
import { ConfirmDialog } from './shared/ConfirmDialog.jsx';
import { TrashIcon } from './shared/IconButton.jsx';
import {
  HARNESS_NAMES,
  HARNESS_SUBTAB_IDS,
  HARNESS_SUBTAB_LABELS,
  isChatSessionKey,
  isKusaKey,
  MONITOR_SUBTAB_IDS,
  MONITOR_SUBTAB_LABELS,
  SESSION_SUBTAB_IDS,
  SESSION_SUBTAB_LABELS,
  sessionLabel,
  sessionRankAt,
  SETTINGS_SUBTAB_IDS,
  SETTINGS_SUBTAB_LABELS,
  TAB_IDS,
} from './shared/lib/format.js';
import { readJsonSet, readLocal, writeJsonSet, writeLocal } from './shared/lib/storage.js';

/** Core Dev Tools ids plus installed extension nav placements (e.g. CAO). */
const { ids: DEVTOOLS_SUBTAB_IDS, labels: DEVTOOLS_SUBTAB_LABELS } = resolveDevtoolsSubTabs();

function initialMonitorsSubTab() {
  const savedTab = readLocal('monitor.tab', 'monitors');
  if (MONITOR_SUBTAB_IDS.includes(savedTab)) return savedTab;
  const saved = readLocal('monitor.monitorsSubTab', 'counters');
  return MONITOR_SUBTAB_IDS.includes(saved) ? saved : 'counters';
}

/** Chat is never an initial value — a stale 'chat' must not outlive a non-Kusă session. */
function initialSessionSubTab() {
  const savedTab = readLocal('monitor.tab', 'session');
  if (savedTab === 'plan') return 'prompts';
  const initialIds = SESSION_SUBTAB_IDS.filter((id) => id !== 'chat');
  if (initialIds.includes(savedTab)) return savedTab;
  const saved = readLocal('monitor.sessionSubTab', 'prompts');
  return initialIds.includes(saved) ? saved : 'prompts';
}

function initialHarnessSubTab() {
  const savedTab = readLocal('monitor.tab', 'harness');
  if (savedTab === 'skills') return 'skills';
  if (HARNESS_SUBTAB_IDS.includes(savedTab)) return savedTab;
  const saved = readLocal('monitor.harnessSubTab', 'mcp');
  return HARNESS_SUBTAB_IDS.includes(saved) ? saved : 'mcp';
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
  if (saved === 'auth' || saved === 'playback') return 'agent';
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
  return {
    ...rest,
    status: status === 'ended' ? 'ended' : 'idle',
  };
}

async function fetchKusaSessions() {
  const res = await fetch('/kusa/sessions', { headers: { Accept: 'application/json' } });
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
    merged.push({
      ...next,
      messages,
      status: curBusy ? cur.status : next.status,
      live: curBusy ? (cur.live || next.live || null) : (nextBusy ? next.live : null),
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
  const res = await fetch('/kusa/sessions', {
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
      return {
        type: 'ask',
        ask: {
          ...p.ask,
          options: (Array.isArray(p.ask?.options) ? p.ask.options : []).map((o) => ({ ...o })),
          answer: p.ask?.answer ? { ...p.ask.answer } : p.ask?.answer,
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
  const [selected, setSelected] = useState(null);
  /** In-flight chat live snapshots — kept in sync when the user resolves an Approval CTA. */
  const liveSnapBySession = useRef(new Map());
  /** Session keys currently attached to a server turn SSE (send or resume). */
  const attachedTurns = useRef(new Set());
  const [tab, setTab] = useState(() => {
    const saved = readLocal('monitor.tab', 'monitors');
    // Plan → Chat Session/Prompts; Graft → Developer Tools/Trail;
    // Skills/MCP → Harness; Counters/… → Monitors; Prompts/Tools → Chat Session;
    // Git/Trail/CAO → Developer Tools.
    if (saved === 'plan') return 'session';
    if (saved === 'graft') return 'devtools';
    // Settings › Auth moved to Account (user avatar below theme).
    if (saved === 'auth' || readLocal('monitor.settingsSubTab', '') === 'auth') return 'user';
    if (MONITOR_SUBTAB_IDS.includes(saved)) return 'monitors';
    if (SESSION_SUBTAB_IDS.includes(saved)) return 'session';
    if (DEVTOOLS_SUBTAB_IDS.includes(saved)) return 'devtools';
    if (HARNESS_SUBTAB_IDS.includes(saved)) return 'harness';
    if (SETTINGS_SUBTAB_IDS.includes(saved)) return 'settings';
    if (TAB_IDS.includes(saved)) return saved;
    // Restoring an installed extension whose nav lives under Dev Tools.
    const extId = readLocal('monitor.activeExtension', '');
    const ext = extId ? getBuiltinExtension(extId) : null;
    if (ext?.nav?.placement === 'devtools' && isExtensionInstalled(ext)) return 'devtools';
    return 'monitors';
  });
  const [theme, setTheme] = useState(() => {
    const t = document.documentElement.dataset.theme || readLocal('monitor.theme', 'dark');
    return t === 'light' ? 'light' : 'dark';
  });
  const [monitorsSubTab, setMonitorsSubTab] = useState(initialMonitorsSubTab);
  const [sessionSubTab, setSessionSubTab] = useState(initialSessionSubTab);
  const [harnessSubTab, setHarnessSubTab] = useState(initialHarnessSubTab);
  const [devtoolsSubTab, setDevtoolsSubTab] = useState(initialDevtoolsSubTab);
  const [settingsSubTab, setSettingsSubTab] = useState(initialSettingsSubTab);
  const [activeExtensionId, setActiveExtensionId] = useState(initialActiveExtensionId);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readLocal('monitor.sidebar', 'open') === 'collapsed',
  );
  const [expandedTools, setExpandedTools] = useState(() => readJsonSet('monitor.expandedTools'));
  const [expandedPrompts, setExpandedPrompts] = useState(() => readJsonSet('monitor.expandedPrompts'));
  const [sessionFilter, setSessionFilter] = useState(() => {
    const saved = readLocal('monitor.sessionFilter', 'all');
    return saved === 'active' || saved === 'closed' ? saved : 'all';
  });
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
  const canDelete = typeof location !== 'undefined' && location.protocol !== 'file:';
  const canPersistSettings = canDelete;

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
          const res = await fetch('/kusa/sessions/migrate', {
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
    writeLocal('monitor.tab', tab);
  }, [tab]);

  useEffect(() => {
    writeLocal('monitor.monitorsSubTab', monitorsSubTab);
  }, [monitorsSubTab]);

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
      setData(next);
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

  const trailStatus = detectTrail ? (ready?.trail || data?.trailStatus) : null;
  const gitStatus = detectGit ? (ready?.git || data?.git) : null;
  const devtoolsNav = extensionNavEntries('devtools');
  const caoOnRail = devtoolsNav.some((e) => e.extensionId === 'cao');
  const liveChatOnRail = devtoolsNav.some((e) => e.extensionId === 'live-chat');
  // Rail badge: any detected Dev Tools host that is not ok (not only when enforced).
  const trailBadge = Boolean(detectTrail && trailStatus && !trailStatus.ok);
  const gitBadge = Boolean(detectGit && gitStatus && !gitStatus.ok);
  const caoBadge = Boolean(caoOnRail && devtoolsExtReady.cao && !devtoolsExtReady.cao.ok);
  const liveChatBadge = Boolean(
    liveChatOnRail && devtoolsExtReady.liveChat && !devtoolsExtReady.liveChat.ok,
  );

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

  // A monitor lane pruned off-disk is no longer selectable — clear so we can
  // reseed once. Chat deletes already clear `selected` in runDelete.
  useEffect(() => {
    if (!selected || isChatSessionKey(selected) || !data) return;
    if (!data.lanes?.[selected]) setSelected(null);
  }, [data, selected]);

  // Land on the latest session once when nothing is selected, then stick.
  useEffect(() => {
    if (selected != null) return;
    if (data?.focus) setSelected(data.focus);
  }, [data?.focus, selected]);

  const chatSession = useMemo(
    () => (laneKey && isChatSessionKey(laneKey)
      ? chatSessions.find((s) => s.key === laneKey) || null
      : null),
    [chatSessions, laneKey],
  );

  // When a chat session is selected, land on Chat; leave Chat when it isn't.
  useEffect(() => {
    if (chatSession) {
      setSessionSubTab('chat');
      return;
    }
    setSessionSubTab((prev) => (prev === 'chat' ? 'prompts' : prev));
  }, [chatSession?.key]);

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
      poll();
    } catch (err) {
      window.alert(`Could not save settings: ${err?.message || err}`);
    } finally {
      setSettingsBusy(false);
    }
  }

  function selectLane(key) {
    setActiveExtensionId(null);
    setSelected(key);
    if (isChatSessionKey(key) && chatSessions.some((s) => s.key === key)) {
      setSessionSubTab('chat');
      setTab('session');
    }
  }

  async function createSession({ provider = 'kusa', kind = 'standard', workflowId = null } = {}) {
    if (!canPersistSettings) {
      window.alert('Chat sessions need the local server (npm run kusa:serve).');
      return;
    }
    let session;
    try {
      const res = await fetch('/kusa/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          provider,
          kind,
          ...(workflowId ? { workflowId } : {}),
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
      return;
    }
    if (!session?.key) return;
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
    poll();
  }

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
                    label: String(option?.label ?? ''),
                    detail: String(option?.detail ?? ''),
                  }))
                : [],
              allowFreeText: ev.allowFreeText !== false,
              status: ev.status || 'pending',
              answer: ev.answer && typeof ev.answer === 'object' ? ev.answer : null,
              timeoutMs: Number(ev.timeoutMs) > 0 ? Number(ev.timeoutMs) : null,
              timeoutStartsAt: Number(ev.timeoutStartsAt) > 0 ? Number(ev.timeoutStartsAt) : null,
              reason: ev.reason || null,
            };
            return { ...live, parts: applyAskToParts(live.parts, ask) };
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
   * the only way a question moves forward is a human clicking or typing.
   * One of optionIndex / optionLabel / freeText is sent; the server resolves
   * the choice in that order and the gate returns the answer to the model.
   */
  async function resolveChatAsk(sessionKey, { askId, optionIndex = null, optionLabel = null, freeText = null }) {
    if (!askId) return;
    const markAsk = (parts) => (parts || []).map((p) => {
      if (p.type !== 'ask' || p.ask?.id !== askId) return p;
      return {
        type: 'ask',
        ask: {
          ...p.ask,
          status: 'answered',
          answer: {
            selected: Number(optionIndex),
            freeText: String(freeText ?? ''),
          },
        },
      };
    });

    const snap = liveSnapBySession.current.get(sessionKey);
    if (snap) snap.parts = markAsk(snap.parts);

    patchKusaSession(setChatSessions, sessionKey, (s) => {
      if (!s?.live?.parts) return s;
      const parts = markAsk(s.live.parts);
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
    const res = await fetch('/kusa/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: askId,
        ...(optionIndex != null ? { optionIndex } : {}),
        ...(optionLabel ? { optionLabel } : {}),
        ...(freeText ? { freeText } : {}),
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Answer failed (HTTP ${res.status})`);
    }
  }

  /**
   * Persist the composer's Mode / Rule / Model picks onto THIS session's record
   * (`.kusa/kusa/<id>.chat.json`). Pickers belong to a chat, not to the browser:
   * another session keeps its own, and one that never picked keeps following
   * Settings → Kusă agent. Written straight to disk so a refresh — even mid-turn —
   * reopens the chat with the same pickers.
   */
  async function updateChatSessionOptions(sessionKey, {
    mode = null,
    rules = null,
    model = null,
    endpointId = null,
  } = {}) {
    if (!canPersistSettings || !sessionKey) return;
    const patch = {
      ...(mode ? { mode } : {}),
      ...(rules ? { rules } : {}),
      ...(model ? { model } : {}),
      // Allow clearing back to Default when the user picks a Default model.
      ...(endpointId != null ? { endpointId: String(endpointId).trim() } : {}),
    };
    if (!Object.keys(patch).length) return;
    const session = chatSessions.find((s) => s.key === sessionKey);
    if (!session) return;
    // Merge with what the record already says: one picker changing must never
    // erase the others, or a refresh would reopen the chat half-picked.
    const options = { ...(session?.options || {}), ...patch };
    // Allow / Deny are sticky, so the record carries no expiry at all: nothing
    // here can disagree with a live picker about whether a rule is still in
    // effect, and a refresh reopens the chat on the rule the user chose.
    setChatSessions((prev) => prev.map((s) => (s.key === sessionKey ? { ...s, options } : s)));
    try {
      await persistChatSession({ ...session, options });
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
    const list = [...new Set((keys || []).filter(Boolean))];
    if (!list.length) return;

    if (!canDelete) {
      window.alert('Session delete needs the local server (npm run kusa:serve).');
      return;
    }

    setPendingDelete({ keys: list });
  }

  async function runDelete() {
    const list = pendingDelete?.keys || [];
    if (!list.length || deleteBusy) return;
    const chatKeys = list.filter(isChatSessionKey);

    setDeleteBusy(true);
    try {
      const res = await fetch('/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: list }),
      });
      if (!res.ok) {
        const detailText = await res.text().catch(() => '');
        throw new Error(detailText || `HTTP ${res.status}`);
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
    monitors: {
      ids: MONITOR_SUBTAB_IDS,
      labels: MONITOR_SUBTAB_LABELS,
      value: monitorsSubTab,
      onChange: (next) => {
        setActiveExtensionId(null);
        setMonitorsSubTab(next);
        setTab('monitors');
      },
      idPrefix: 'monitors',
      ariaLabel: 'Monitor views',
    },
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
      ids: DEVTOOLS_SUBTAB_IDS,
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
                  ? 'Live Chat bot is ready'
                  : 'Live Chat bot is not ready (not installed or server down)',
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
    return {
      open: true,
      title: keys.length === 1 ? `Delete ${labels[0]}` : `Delete ${keys.length} sessions`,
      detail: 'This removes their session files, task lists, and per-session settings, and cannot be undone.',
      items: labels,
      confirmLabel: keys.length === 1 ? 'Delete session' : `Delete ${keys.length} sessions`,
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
        sessionFilter={sessionFilter}
        onSessionFilterChange={(next) => {
          setSessionFilter(next);
          writeLocal('monitor.sessionFilter', next);
        }}
        selectMode={selectMode}
        onSelectModeChange={setSelectMode}
        checkedKeys={checkedKeys}
        onToggleChecked={toggleChecked}
        onClearChecked={() => setCheckedKeys(new Set())}
        onDeleteKeys={deleteKeys}
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
      />

      <main className={`min-w-0 flex-1 ${sessionChatFill && !activeExtensionId ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
        <div
          id={activeExtensionId ? `extension-panel-${activeExtensionId}` : `panel-${tab}`}
          role="tabpanel"
          aria-labelledby={activeExtensionId ? 'sidebar-view-extensions' : `tab-${tab}`}
          className={
            sessionChatFill && !activeExtensionId
              ? 'flex min-h-0 flex-1 flex-col'
              : 'space-y-8 px-6 py-4 pb-6'
          }
        >
          {activeExtensionId ? (
            <ExtensionPage extensionId={activeExtensionId} canPersist={canDelete} />
          ) : (
            <>
              {tab === 'monitors' && (
                <MonitorsPanel
                  subTab={monitorsSubTab}
                  lane={lane}
                  now={now}
                  sdkListener={data?.sdkListener}
                  tokens={lane?.tokens}
                  tokenTurns={lane?.tokenTurns}
                  recent={lane?.recent}
                  warnings={lane?.warnings}
                  notes={lane?.notes}
                  errors={data?.errors}
                />
              )}
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
                  chatQueue={queueForSession(queueByKey, chatSession?.key)}
                  onSendMessage={sendChatMessage}
                  onQueueMessage={queueFromComposer}
                  onStopTurn={stopChatTurn}
                  onApproval={resolveChatApproval}
                  onAsk={resolveChatAsk}
                  onTurnOptions={updateChatTurnOptions}
                  onSessionOptions={updateChatSessionOptions}
                  agentDefaults={{
                    mode: 'agent',
                    rules: settings.agentApprovalMode || 'ask-deny',
                    model: settings.agentModel || '',
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
                <HarnessPanel subTab={harnessSubTab} canPersist={canPersistSettings} />
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
                  canPersistCao={canDelete}
                />
              )}
              {tab === 'settings' && (
                <SettingsPanel
                  subTab={settingsSubTab}
                  settings={data?.settings}
                  sdkListener={data?.sdkListener}
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
      />

      {deleteDialog ? (
        <ConfirmDialog
          {...deleteDialog}
          icon={TrashIcon}
          disabled={deleteBusy}
          onConfirm={runDelete}
          onDismiss={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
