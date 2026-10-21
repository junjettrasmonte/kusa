import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DevToolsPanel } from './components/DevToolsPanel.jsx';
import { HarnessPanel } from './components/HarnessPanel.jsx';
import { MonitorsPanel } from './components/MonitorsPanel.jsx';
import { PaneSubTabs } from './components/PaneSubTabs.jsx';
import { SessionPanel } from './components/SessionPanel.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import { RightRail } from './components/RightRail.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import {
  DEVTOOLS_SUBTAB_IDS,
  DEVTOOLS_SUBTAB_LABELS,
  HARNESS_NAMES,
  HARNESS_SUBTAB_IDS,
  HARNESS_SUBTAB_LABELS,
  isKusaKey,
  KUSA_HARNESS,
  MONITOR_SUBTAB_IDS,
  MONITOR_SUBTAB_LABELS,
  SESSION_SUBTAB_IDS,
  SESSION_SUBTAB_LABELS,
  SETTINGS_SUBTAB_IDS,
  SETTINGS_SUBTAB_LABELS,
  TAB_IDS,
} from './lib/format.js';
import { readJsonSet, readLocal, writeJsonSet, writeLocal } from './lib/storage.js';

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
  return DEVTOOLS_SUBTAB_IDS.includes(saved) ? saved : 'git';
}

function initialSettingsSubTab() {
  const savedTab = readLocal('monitor.tab', 'settings');
  if (SETTINGS_SUBTAB_IDS.includes(savedTab)) return savedTab;
  const saved = readLocal('monitor.settingsSubTab', 'agent');
  return SETTINGS_SUBTAB_IDS.includes(saved) ? saved : 'agent';
}

const KUSA_SESSIONS_KEY = 'monitor.kusaSessions';

/** Legacy browser-local chats (pre disk persistence). Cleared after migrate. */
function readLegacyKusaSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(KUSA_SESSIONS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((s) => s && typeof s === 'object' && isKusaKey(s.key) && s.id);
  } catch {
    return [];
  }
}

function clearLegacyKusaSessions() {
  try { localStorage.removeItem(KUSA_SESSIONS_KEY); } catch { /* ignore */ }
}

function slimKusaSession(session) {
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
  return merged.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

async function persistKusaSession(session) {
  const slim = slimKusaSession(session);
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
    if (type === 'done' || type === 'stopped') finalPayload = data;
    if (type === 'error') {
      throw new Error(data.message || 'kusa chat failed');
    }
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
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState(null);
  /** In-flight chat live snapshots — kept in sync when the user resolves an Approval CTA. */
  const liveSnapBySession = useRef(new Map());
  /** Session keys currently attached to a server turn SSE (send or resume). */
  const attachedTurns = useRef(new Set());
  const [tab, setTab] = useState(() => {
    const saved = readLocal('monitor.tab', 'monitors');
    // Plan → Chat Session/Prompts; Graft → Developer Tools/Trail;
    // Skills/MCP → Harness; Counters/… → Monitors; Prompts/Tools → Chat Session;
    // Git/Trail → Developer Tools.
    if (saved === 'plan') return 'session';
    if (saved === 'graft') return 'devtools';
    if (MONITOR_SUBTAB_IDS.includes(saved)) return 'monitors';
    if (SESSION_SUBTAB_IDS.includes(saved)) return 'session';
    if (DEVTOOLS_SUBTAB_IDS.includes(saved)) return 'devtools';
    if (HARNESS_SUBTAB_IDS.includes(saved)) return 'harness';
    if (SETTINGS_SUBTAB_IDS.includes(saved)) return 'settings';
    return TAB_IDS.includes(saved) ? saved : 'monitors';
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readLocal('monitor.sidebar', 'open') === 'collapsed',
  );
  const [collapsedHarnesses, setCollapsedHarnesses] = useState(() => new Set());
  const [expandedTools, setExpandedTools] = useState(() => readJsonSet('monitor.expandedTools'));
  const [expandedPrompts, setExpandedPrompts] = useState(() => readJsonSet('monitor.expandedPrompts'));
  const [sessionFilter, setSessionFilter] = useState(() => {
    const saved = readLocal('monitor.sessionFilter', 'all');
    return saved === 'active' || saved === 'closed' ? saved : 'all';
  });
  const [selectMode, setSelectMode] = useState(false);
  const [checkedKeys, setCheckedKeys] = useState(() => new Set());
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [kusaSessions, setKusaSessions] = useState([]);
  /**
   * Composer queue mirror, keyed by session key: { queued, steering }.
   * The monitor server owns the real queue (POST/GET /kusa/queue) so a
   * running turn can drain it; this state only exists to render it.
   */
  const [queueByKey, setQueueByKey] = useState(new Map());
  /** Live Trail/Git readiness from GET /ready (HTTP serve only). */
  const [ready, setReady] = useState(null);
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
          setKusaSessions((prev) => mergeKusaSessions(prev, sessions));
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
          setKusaSessions((prev) => mergeKusaSessions(prev, sessions));
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
  // Skip keys that sendKusaMessage already owns (liveSnap set before busy).
  useEffect(() => {
    if (!canPersistSettings) return;
    for (const session of kusaSessions) {
      const busy = session.status === 'busy' || session.status === 'thinking' || session.live;
      if (!busy || !session.key) continue;
      if (attachedTurns.current.has(session.key)) continue;
      if (liveSnapBySession.current.has(session.key)) continue;
      void resumeKusaTurn(session.key);
    }
  }, [canPersistSettings, kusaSessions]);

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

  const trailStatus = detectTrail ? (ready?.trail || data?.trailStatus) : null;
  const gitStatus = detectGit ? (ready?.git || data?.git) : null;
  const trailBadge = enforceTrail && trailStatus && !trailStatus.ok;
  const gitBadge = enforceGit && gitStatus && !gitStatus.ok;

  const laneKey = useMemo(() => {
    if (selected && isKusaKey(selected) && kusaSessions.some((s) => s.key === selected)) {
      return selected;
    }
    if (!data) return null;
    if (follow || !selected || isKusaKey(selected) || !data.lanes[selected]) return data.focus;
    return selected;
  }, [data, follow, selected, kusaSessions]);

  const kusaSession = useMemo(
    () => (laneKey && isKusaKey(laneKey)
      ? kusaSessions.find((s) => s.key === laneKey) || null
      : null),
    [kusaSessions, laneKey],
  );

  // When a Kusă session is selected, land on Chat; leave Chat when it isn't.
  useEffect(() => {
    if (kusaSession) {
      setSessionSubTab('chat');
      return;
    }
    setSessionSubTab((prev) => (prev === 'chat' ? 'prompts' : prev));
  }, [kusaSession?.key]);

  // Session-bound held prompts flush on the *selected* idle session only.
  // Parked (cross-session) rows are skipped until resumed onto this chat.
  useEffect(() => {
    if (!canPersistSettings || !kusaSession?.key) return;
    const session = kusaSession;
    const busy = session.status === 'busy' || session.status === 'thinking' || session.live;
    if (busy) return;
    const held = queueForSession(queueByKey, session.key)?.queued || [];
    // Parked prompts stay visible but are never auto-sent.
    if (!held.some((entry) => !entry?.paused)) return;
    void (async () => { await flushQueuedMessages(session.key); })();
  }, [canPersistSettings, kusaSession, queueByKey]);

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

  function toggleHarness(name) {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      writeLocal('monitor.sidebar', 'open');
      setCollapsedHarnesses((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      return;
    }
    setCollapsedHarnesses((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectLane(key) {
    setSelected(key);
    setFollow(!isKusaKey(key) && key === data?.focus);
    if (isKusaKey(key)) {
      setSessionSubTab('chat');
      setTab('session');
    }
  }

  async function createKusaSession() {
    if (!canPersistSettings) {
      window.alert('Kusă chat needs the local server (npm run kusa:serve).');
      return;
    }
    let session;
    try {
      const res = await fetch('/kusa/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      session = body?.session;
    } catch (err) {
      window.alert(`Could not create Kusă session: ${err?.message || err}`);
      return;
    }
    if (!session?.key) return;
    setKusaSessions((prev) => [session, ...prev.filter((s) => s.key !== session.key)]);
    setSelected(session.key);
    setFollow(false);
    setSessionSubTab('chat');
    setTab('session');
    setCollapsedHarnesses((prev) => {
      const next = new Set(prev);
      next.delete(KUSA_HARNESS);
      return next;
    });
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
  async function attachKusaTurn(sessionKey, res) {
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
      patchKusaSession(setKusaSessions, sessionKey, (s) => ({
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
          patchKusaSession(setKusaSessions, sessionKey, (s) => ({
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
          patchKusaSession(setKusaSessions, sessionKey, (s) => {
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
          patchKusaSession(setKusaSessions, sessionKey, (s) => {
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
      const assistantMsg = {
        id: newMessageId(),
        role: 'assistant',
        text: textOut || (thinkingOut || tools.length ? '' : '(empty response)'),
        thinking: thinkingOut || '',
        tools,
        parts: parts.length ? parts : undefined,
        at: Date.now(),
        turnId: turnId || undefined,
        backend: payload?.backend || null,
        stopped: payload?.type === 'stopped' ? true : undefined,
      };

      setKusaSessions((prev) => {
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
          persistKusaSession(done).catch(() => {});
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
      setKusaSessions((prev) => prev.map((s) => {
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
              text: `Agent error: ${err?.message || err}`,
              thinking: '',
              tools: [],
              at: Date.now(),
            },
          ],
        };
        persistKusaSession(done).catch(() => {});
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
      await attachKusaTurn(sessionKey, res);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // Leave busy state; the next sessions poll may clear or retry.
    }
  }

  /**
   * Send a chat turn. Pass `{ editMessageId }` to rewrite a prior user message
   * (VS Code chat style): drop that message and everything after it, then resend.
   */
  async function sendKusaMessage(
    sessionKey,
    text,
    { editMessageId = null, mode = null, model = null, approvalMode = null } = {},
  ) {
    if (!canPersistSettings) {
      window.alert('Kusă chat needs the local server (npm run kusa:serve).');
      return;
    }

    const session = kusaSessions.find((s) => s.key === sessionKey);
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

    const history = kept
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, text: m.text }));
    const sessionId = session.id || '';
    const userMsg = {
      id: editMessageId || newMessageId(),
      role: 'user',
      text,
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
    setKusaSessions((prev) => prev.map((s) => (s.key === sessionKey ? busySession : s)));
    // Persist the user turn before starting the agent so a refresh mid-flight
    // still sees the prompt (server also writes it on POST /kusa/chat).
    await persistKusaSession(busySession).catch(() => {});

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
          approvalMode,
          queueKey: sessionKey,
          // Same id the client wrote — server persistTurnPrompt stays idempotent.
          promptMessageId: userMsg.id,
        }),
      });
      await attachKusaTurn(sessionKey, res);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const assistantMsg = {
        id: newMessageId(),
        role: 'assistant',
        text: `Agent error: ${err?.message || err}`,
        thinking: '',
        tools: [],
        at: Date.now(),
      };
      const errSession = {
        ...busySession,
        status: 'idle',
        live: null,
        messages: [...turnMessages, assistantMsg],
      };
      setKusaSessions((prev) => prev.map((s) => (s.key === sessionKey ? errSession : s)));
      persistKusaSession(errSession).catch(() => {});
      liveSnapBySession.current.delete(sessionKey);
    }
  }

  /** Resolve a gated-tool pause; agent stays blocked until this POST settles. */
  async function resolveKusaApproval(sessionKey, { approvalId, allowed }) {
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

    patchKusaSession(setKusaSessions, sessionKey, (s) => {
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
  async function resolveKusaAsk(sessionKey, { askId, optionIndex = null, optionLabel = null, freeText = null }) {
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

    patchKusaSession(setKusaSessions, sessionKey, (s) => {
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
   * Mid-turn composer Mode / Rules. The running loop applies these at its next
   * step boundary (tools + system prompt + approval gate), so a picker change
   * while busy does not wait for the turn to finish.
   */
  async function updateKusaTurnOptions(sessionKey, { mode = null, approvalMode = null } = {}) {
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
   * running loop), remove = take it out of the queued list, take = claim it so
   * a flush cannot send it twice, edit = rewrite a held prompt's text in place
   * (id + position + options stay), reorder = set held order from `{ ids }`.
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
          const session = kusaSessions.find((s) => s.key === sessionKey);
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
            if (!text) return body;
            const options = entry?.options || {};
            await sendKusaMessage(sessionKey, text, {
              mode: options.mode || null,
              model: options.model || null,
              approvalMode: options.approvalMode || null,
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
        if (!text) continue;
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
        await sendKusaMessage(sessionKey, text, {
          mode: options.mode || null,
          model: options.model || null,
          approvalMode: options.approvalMode || null,
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
  async function stopKusaTurn(sessionKey) {
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

  async function deleteKeys(keys) {
    const list = [...new Set((keys || []).filter(Boolean))];
    if (!list.length || deleteBusy) return;

    if (!canDelete) {
      window.alert('Session delete needs the local server (npm run kusa:serve).');
      return;
    }

    const label = list.length === 1
      ? `Delete session ${list[0]}?`
      : `Delete ${list.length} sessions?`;
    if (!window.confirm(`${label}\n\nThis removes their session files and cannot be undone.`)) {
      return;
    }

    const kusaKeys = list.filter(isKusaKey);

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
      if (kusaKeys.length) {
        setKusaSessions((prev) => prev.filter((s) => !kusaKeys.includes(s.key)));
        // Drop that session's held + steering mirrors. Keep workspace parked
        // visible on remaining chats (do not leak the deleted chat's held).
        setQueueByKey((prev) => {
          const next = new Map(prev);
          for (const key of kusaKeys) {
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
        for (const key of list) next.delete(key);
        return next;
      });
      if (list.includes(selected) || list.includes(laneKey)) {
        setSelected(null);
        setFollow(true);
      }
      poll();
    } catch (err) {
      window.alert(`Could not delete session(s): ${err?.message || err}`);
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

  const sessionChatFill = Boolean(kusaSession) && tab === 'session';
  const sessionSubTabIds = kusaSession
    ? SESSION_SUBTAB_IDS
    : SESSION_SUBTAB_IDS.filter((id) => id !== 'chat');

  const paneTabs = (() => {
    if (tab === 'monitors') {
      return {
        ids: MONITOR_SUBTAB_IDS,
        labels: MONITOR_SUBTAB_LABELS,
        value: monitorsSubTab,
        onChange: setMonitorsSubTab,
        idPrefix: 'monitors',
        ariaLabel: 'Monitor views',
      };
    }
    if (tab === 'session') {
      return {
        ids: sessionSubTabIds,
        labels: SESSION_SUBTAB_LABELS,
        value: sessionSubTab,
        onChange: setSessionSubTab,
        idPrefix: 'session',
        ariaLabel: 'Chat session views',
      };
    }
    if (tab === 'harness') {
      return {
        ids: HARNESS_SUBTAB_IDS,
        labels: HARNESS_SUBTAB_LABELS,
        value: harnessSubTab,
        onChange: setHarnessSubTab,
        idPrefix: 'harness',
        ariaLabel: 'Harness views',
      };
    }
    if (tab === 'devtools') {
      return {
        ids: DEVTOOLS_SUBTAB_IDS,
        labels: DEVTOOLS_SUBTAB_LABELS,
        value: devtoolsSubTab,
        onChange: setDevtoolsSubTab,
        idPrefix: 'devtools',
        ariaLabel: 'Developer tool views',
      };
    }
    if (tab === 'settings') {
      return {
        ids: SETTINGS_SUBTAB_IDS,
        labels: SETTINGS_SUBTAB_LABELS,
        value: settingsSubTab,
        onChange: setSettingsSubTab,
        idPrefix: 'settings',
        ariaLabel: 'Settings views',
      };
    }
    return null;
  })();

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
        collapsedHarnesses={collapsedHarnesses}
        onToggleHarness={toggleHarness}
        onSelectLane={selectLane}
        onNewKusaSession={createKusaSession}
        kusaSessions={kusaSessions}
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
        statusLine={statusLine}
        statusLane={lane}
        statusKusaSession={kusaSession}
      />

      <main className={`min-w-0 flex-1 ${sessionChatFill ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-stretch gap-3 border-b border-gray-800 bg-gray-950/90 px-4 backdrop-blur">
          {paneTabs ? <PaneSubTabs {...paneTabs} /> : <div className="flex-1" />}
        </header>

        <div
          id={`panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className={
            sessionChatFill
              ? 'flex min-h-0 flex-1 flex-col'
              : 'space-y-8 px-6 py-4 pb-6'
          }
        >
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
              kusaSession={kusaSession}
              kusaQueue={queueForSession(queueByKey, kusaSession?.key)}
              onSendKusaMessage={sendKusaMessage}
              onQueueKusaMessage={queueFromComposer}
              onStopKusaTurn={stopKusaTurn}
              onKusaApproval={resolveKusaApproval}
              onKusaAsk={resolveKusaAsk}
              onKusaTurnOptions={updateKusaTurnOptions}
              agentDefaults={{
                mode: 'agent',
                rules: settings.agentApprovalMode || 'ask-deny',
                model: settings.agentModel || '',
                approvalTimeoutMinutes: settings.agentApprovalTimeoutMinutes ?? 2,
                allowDenyRevertMinutes: settings.agentAllowDenyRevertMinutes ?? 15,
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
            />
          )}
          {tab === 'settings' && (
            <SettingsPanel
              subTab={settingsSubTab}
              follow={follow}
              onFollowChange={(checked) => {
                setFollow(checked);
                if (checked && data) setSelected(data.focus);
              }}
              settings={data?.settings}
              sdkListener={data?.sdkListener}
              canPersist={canPersistSettings}
              settingsBusy={settingsBusy}
              onSettingsChange={saveSettings}
            />
          )}
        </div>
      </main>

      <RightRail
        tab={tab}
        onTabChange={setTab}
        theme={theme}
        onThemeChange={setTheme}
        trailBadge={trailBadge}
        gitBadge={gitBadge}
      />
    </div>
  );
}
