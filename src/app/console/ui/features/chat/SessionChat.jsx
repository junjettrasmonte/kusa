import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CHAT_PROVIDER_GROUPS, HARNESS_NAMES, shortId } from '#ui/shared/lib/format.js';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import {
  AGENT_MODE_OPTIONS,
  AttachmentPicker,
  ComposerDropdown,
  ComposerOptionsMenu,
  ContextRing,
  DEFAULT_CONTEXT_LIMIT,
  DictateIcon,
  RULE_OPTIONS,
  VoiceIcon,
  ruleOptions,
} from './ComposerControls.jsx';
import {
  ATTACHMENT_LIMITS,
  collectTransferFiles,
  fileToAttachment,
  pickFilesWithOsDialog,
  readClipboardAttachment,
  readClipboardViaPaste,
  stageAttachments,
  transferHasFiles,
} from '#ui/shared/lib/attachments.js';
import { PopupToggle } from './PopupList.jsx';
import {
  estimateContextTokens,
  isCursorTrustError,
  stripMarkdownForSpeech,
  truncate,
} from '#ui/shared/lib/chatText.js';
import { readLocal, writeLocal } from '#ui/shared/lib/storage.js';
import { SetupGuide } from '#ui/shared/SetupGuide.jsx';
import {
  ArrowUpIcon,
  AttachmentsIcon,
  ChevronDownIcon,
  LiveChatIcon,
  PlanIcon,
  QueueIcon,
  StopIcon,
  TaskIcon,
} from './ChatGlyphs.jsx';
import { AttachmentStack } from './AttachmentPanel.jsx';
import { ClippedGrow, lastPendingGate } from './ClippedGrow.jsx';
import { QueueStack } from './QueuePanel.jsx';
import { TaskStack } from './TaskPanel.jsx';
import { PlanStack, useWorkspacePlans } from './PlanPanel.jsx';
import { ChatTurn } from './TranscriptTurns.jsx';
import {
  isOrchestratedChatSession,
  mergeOrchestratedLiveTurns,
  mergeOrchestratedMessages,
  speakerFromSession,
} from './mergeOrchestratedTranscript.js';
import { LiveChatStack } from '#ui/features/live-chat/LiveChatDrawer.jsx';
import { startLiveVoiceSession } from '#ui/features/live-chat/voiceClient.js';

/** Persist drawer dock across reloads — shared by Queue / Tasks / Attachments. */
const DRAWER_DOCK_KEY = 'kusa.chat.drawerDock';
const DRAWER_HEIGHT_KEY = 'kusa.chat.drawerHeight';
const DRAWER_WIDTH_KEY = 'kusa.chat.drawerWidth';
/** Bottom-dock default ≈ summary chrome + former 168px list cap. */
const DRAWER_DEFAULT_HEIGHT = 200;
const DRAWER_DEFAULT_WIDTH = 320;
const DRAWER_MIN_HEIGHT = 120;
const DRAWER_MIN_WIDTH = 200;

function readDrawerSize(key, fallback) {
  const raw = Number(readLocal(key, String(fallback)));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// The composer pickers belong to a chat session, not to the browser: each
// session keeps its own Mode / Rule / Model in its `.chat.json` record (see
// chat-store.mjs normalizeSessionOptions), so switching one chat never moves
// another. A session that never picked has no options — Settings → Kusă agent
// is what fills that in. Allow / Deny are sticky: they hold for the rest of the
// session until the picker is used again, so nothing reverts them on a timer.

// The composer pickers belong to a chat session, not to the browser: each
// session keeps its own Mode / Rule / Model in its `.chat.json` record (see
// chat-store.mjs normalizeSessionOptions), so switching one chat never moves
// another. A session that never picked has no options — Settings → Kusă agent
// is what fills that in. Allow / Deny are sticky: they hold for the rest of the
// session until the picker is used again, so nothing reverts them on a timer.
function initialComposerMode(options, defaults) {
  const saved = options?.mode;
  if (AGENT_MODE_OPTIONS.some((option) => option.id === saved)) return saved;
  return defaults?.mode || 'agent';
}

function initialComposerRule(options, defaults) {
  const saved = options?.rules;
  if (RULE_OPTIONS.some((option) => option.id === saved)) return saved;
  // Allow / Deny are sticky, so a Settings default of Allow means Allow exactly
  // as a composer pick does. Nothing here reverts a rule later — the only way
  // back to Ask is the picker.
  return defaults?.rules || 'ask-deny';
}

function initialComposerModel(options, defaults, { ownsModels = false } = {}) {
  const saved = options?.model;
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  // Adapter catalogs (Cursor) default to Auto — never inherit the BYOK Settings model.
  if (ownsModels) return 'auto';
  return defaults?.model || '';
}

function initialComposerEndpointId(options) {
  const saved = options?.endpointId;
  return typeof saved === 'string' ? saved.trim() : '';
}

// An agent block is height-capped to this share of the transcript panel while
// streaming; past the cap it clips (top/bottom vignette) instead of nesting a
// scrollbar. Show all grows the block into the transcript so only the chat
// panel scrolls. A pending approval stays clipped — the vignette viewport
// scrolls to the ask, and the chat panel scrolls that row on screen.
const AGENT_EXPAND_HEIGHT_RATIO = 0.6;

// Back-read tolerance: while the transcript sits within this many pixels of its
// bottom it still counts as "parked at the newest turn", so auto-scroll keeps
// running and no jump-to-bottom control shows. One wheel tick is ~100px, so
// this only absorbs the sub-pixel drift a programmatic scroll can leave behind.
const BACK_READ_SLOP_PX = 24;

// The queue belongs to the composer, so it must never push the transcript away:
// while the list is on it is height-capped, not item-capped — every queued
// prompt is listed and the stack scrolls inside its own box past this height.
// The toggle hides the whole list rather than thinning it, so auto-collapse
// past the cap switches a long queue off instead of shrinking its rows; the
// toolbar control still shows the count and turns the list back on.
const QUEUE_AUTO_COLLAPSE_AT = 3;

// The Task List is the same control as the queue (see PopupList.jsx) with its
// own caps: task rows are taller than a one-line prompt, so the auto-hide
// threshold is lower and the box is sized for ~5 rows.
const TASK_AUTO_HIDE_AT = 6;

// One beat on the badge when its counters move: long enough to read as a pulse
// the user notices, short enough that the next status update is never lost
// behind it (see .chat-badge-pulse in index.css).
const TASK_BADGE_PULSE_MS = 2000;

// Same beat length on the Prompt Queue badge, but a bounce instead of a pulse
// (see .chat-badge-bounce in index.css): a prompt arriving in the queue, or a
// held prompt being handed to the chat, is a discrete object MOVING, so the
// chip hops once rather than swelling.
const PROMPT_BADGE_BOUNCE_MS = 2000;

// What the composer says while a paste-from-clipboard request waits for the
// user's gesture: the browser cannot read a clipboard nobody pasted, and the
// window closes itself if the gesture never comes (see readClipboardViaPaste).
const PASTE_REQUEST_NOTE =
  'paste it now — Ctrl+V into the box, anywhere on this page; the browser reads the clipboard off that paste, with no permission prompt';

// Heading for the endpoint the Settings fields describe. The server names its
// group the same way (DEFAULT_ENDPOINT_LABEL in the agent loop), so a fallback
// list — a chat opened before the server answered, or one with no models — still
// reads as that endpoint rather than an unnamed one.
const DEFAULT_MODEL_GROUP = 'Default';

/**
 * First-party Kusă chat surface — transcript styled like VS Code chat:
 * shimmering thinking header, progressive collapsible tool rows, then reply.
 */
export function SessionChat({
  session,
  peerSessions = null,
  queued = null,
  tasks = null,
  onSend,
  onQueue,
  onStop = null,
  onApproval,
  onAsk = null,
  onTurnOptions = null,
  onSessionOptions = null,
  agentDefaults = null,
}) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  // Files staged for THIS draft — not for the session, and not for the model
  // yet: they ride on the message the moment it is sent, and they stay until
  // then, because "I attached this" is a promise about the prompt being typed
  // now. The records are the plain {name,kind,size,...} shape both sides of
  // the wire agree on (see ui/shared/lib/attachments.js), so they survive
  // React state, the POST body and the chat sidecar unchanged.
  const [attachments, setAttachments] = useState([]);
  // Why the last Add Files / Paste From Clipboard did not add what the user
  // expected: the caps, a cancelled dialog, an empty clipboard. Shown on the
  // Attachments drawer summary, and never invented — '' means nothing to say.
  const [attachNote, setAttachNote] = useState('');
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  // 60% of the live transcript panel height, measured (not a CSS %) so the cap
  // tracks the real container even when the sidebar or window resizes.
  const [agentMaxHeight, setAgentMaxHeight] = useState(null);
  // Back-read mode: on once the user has scrolled up out of the newest turn.
  // While it is on the transcript stops pinning itself back to the bottom —
  // that would drag the exchange they are re-reading away — and the floating
  // jump-to-bottom control in the panel takes over instead. Pressing it, or
  // scrolling back down, turns it off and auto-scroll resumes.
  const [backReading, setBackReading] = useState(false);
  // Composer pickers (VS Code Copilot style): Ask/Plan/Agent, approval rules,
  // model. They belong to THIS session — seeded from its own record, with
  // Settings filling in only when nothing has been picked yet. Allow / Deny are
  // sticky: the pick holds until the Rules picker is used again.
  const sessionOptions = session?.options || null;
  // Adapter/CAO providers (Cursor, Copilot, …) — BYOK endpoint credentials do
  // not apply. Some adapters (Cursor) still own their own model catalog.
  const cliBacked = Boolean(session?.cliBacked);
  const ownsModels = Boolean(session?.ownsModels && session?.modelsPath);
  const showModelPicker = ownsModels || !cliBacked;
  // Workspace gate from the provider adapter (e.g. Cursor trust).
  const workspaceTrust = session?.workspaceTrust || null;
  const hasWorkspaceTrust = Boolean(workspaceTrust?.path);
  // IDE-hooked sessions are observe-only — Kusă cannot prompt into the same
  // chat, so the composer stays disabled with a notice.
  const externalOwned = session?.external === true;
  // Subagents are driven by their parent (kusa_assign / plan workflow) — the
  // human message box stays locked so prompts only come from orchestration.
  const isSubagent = Boolean(session?.parentId || session?.options?.parentId);
  const composerLocked = externalOwned || isSubagent;
  // Some CLIs block until the workspace is trusted once.
  const [trustNeeded, setTrustNeeded] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustNote, setTrustNote] = useState('');
  // After a successful Trust click, hide the banner even if older error rows
  // in the transcript still mention trust — those rows stay for history.
  const [trustGranted, setTrustGranted] = useState(false);
  const [agentMode, setAgentMode] = useState(() => initialComposerMode(sessionOptions, agentDefaults));
  const [approvalRules, setApprovalRules] = useState(() => initialComposerRule(sessionOptions, agentDefaults));
  const [modelChoice, setModelChoice] = useState(() => initialComposerModel(
    sessionOptions,
    agentDefaults,
    { ownsModels: Boolean(session?.ownsModels && session?.modelsPath) },
  ));
  // Which Endpoints card the Model pick sat under (agentEndpoints[].id). Empty
  // means Default. Kept beside the model id so a probed-only Google / proxy
  // pick still routes there after refresh — resolveAgentEndpoint needs it.
  // Adapter-owned catalogs never use endpoint routing.
  const [endpointChoice, setEndpointChoice] = useState(() => (
    session?.ownsModels ? '' : initialComposerEndpointId(sessionOptions)
  ));
  const [models, setModels] = useState([]);
  // Which backend the configured endpoint runs ('opencode' | 'native' | '').
  // OpenCode takes a prompt string, so it never receives an image part — the
  // composer says so on the chip rather than letting the picture vanish.
  const [modelBackend, setModelBackend] = useState('');
  const approvalTimeoutMinutes = Math.min(
    60,
    Math.max(1, Math.floor(Number(agentDefaults?.approvalTimeoutMinutes) || 2)),
  );
  // Queue, Task List, Plans, Attachments, and Live Chat share one slot above the
  // composer (tab-style): only one drawer is open at a time. Off hides the
  // panel only — the server still holds queued prompts / tasks, staged files
  // stay on the draft, and an open voice session keeps running when the Live
  // Chat drawer is closed.
  const [queueExpanded, setQueueExpanded] = useState(true);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [plansExpanded, setPlansExpanded] = useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  const [liveChatExpanded, setLiveChatExpanded] = useState(false);
  const workspacePlans = useWorkspacePlans({ enabled: !externalOwned });
  // Live voice (browser-native): phase tracks mic/session lifecycle. handle holds stop().
  const [voicePhase, setVoicePhase] = useState('idle');
  const [voiceError, setVoiceError] = useState('');
  const [liveChatUp, setLiveChatUp] = useState(true);
  const [interimTranscript, setInterimTranscript] = useState('');
  // Optimistic voice rows (STT preview). Durable turns live in the chat store.
  const [voiceMessages, setVoiceMessages] = useState([]);
  const voiceHandleRef = useRef(null);
  /** True after a voice STT turn until we finish speaking the Kusă reply. */
  const voiceExpectSpeakRef = useRef(false);
  const lastSpokenAssistantIdRef = useRef('');
  /** How much of the live/final Kusă reply has already been sent to TTS. */
  const spokenReplyLenRef = useRef(0);
  const busyRef = useRef(false);
  const sessionKeyRef = useRef(session?.key || '');
  const onSendRef = useRef(onSend);
  const onQueueRef = useRef(onQueue);
  const composerOptionsRef = useRef(/** @type {Record<string, string>} */ ({}));
  onSendRef.current = onSend;
  onQueueRef.current = onQueue;
  sessionKeyRef.current = session?.key || '';
  // Shared dock for all three drawers: bottom (above the composer) or right
  // (flush left of the right rail). One icon on every open drawer toggles it.
  const [drawerDock, setDrawerDock] = useState(() => (
    readLocal(DRAWER_DOCK_KEY, 'bottom') === 'right' ? 'right' : 'bottom'
  ));
  // Shared size for the open dock — height when bottom, width when right —
  // capped at half the chat shell (measured below).
  const [drawerHeight, setDrawerHeight] = useState(() => (
    readDrawerSize(DRAWER_HEIGHT_KEY, DRAWER_DEFAULT_HEIGHT)
  ));
  const [drawerWidth, setDrawerWidth] = useState(() => (
    readDrawerSize(DRAWER_WIDTH_KEY, DRAWER_DEFAULT_WIDTH)
  ));
  const shellRef = useRef(null);
  const [shellSize, setShellSize] = useState({ w: 0, h: 0 });

  function toggleDrawerDock() {
    setDrawerDock((current) => {
      const next = current === 'right' ? 'bottom' : 'right';
      writeLocal(DRAWER_DOCK_KEY, next);
      return next;
    });
  }

  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setShellSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxDrawerHeight = shellSize.h > 0 ? Math.floor(shellSize.h / 2) : 480;
  const maxDrawerWidth = shellSize.w > 0 ? Math.floor(shellSize.w / 2) : 480;
  const heightPx = Math.min(Math.max(drawerHeight, DRAWER_MIN_HEIGHT), maxDrawerHeight);
  const widthPx = Math.min(Math.max(drawerWidth, DRAWER_MIN_WIDTH), maxDrawerWidth);

  function beginDrawerResize(axis, event) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startH = heightPx;
    const startW = widthPx;
    const onMove = (moveEvent) => {
      if (axis === 'height') {
        // Handle sits on the top edge: drag up grows the drawer.
        const next = Math.min(
          maxDrawerHeight,
          Math.max(DRAWER_MIN_HEIGHT, startH + (startY - moveEvent.clientY)),
        );
        setDrawerHeight(next);
        writeLocal(DRAWER_HEIGHT_KEY, String(next));
      } else {
        // Handle sits on the left edge: drag left grows the drawer.
        const next = Math.min(
          maxDrawerWidth,
          Math.max(DRAWER_MIN_WIDTH, startW + (startX - moveEvent.clientX)),
        );
        setDrawerWidth(next);
        writeLocal(DRAWER_WIDTH_KEY, String(next));
      }
    };
    const onUp = () => {
      handle.releasePointerCapture?.(pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  const peers = useMemo(
    () => (Array.isArray(peerSessions) ? peerSessions.filter(Boolean) : []),
    [peerSessions],
  );
  const orchestrated = isOrchestratedChatSession(session);
  const baseMessages = useMemo(() => {
    if (!orchestrated) {
      const rows = session?.messages || [];
      const speaker = speakerFromSession(session);
      return speaker
        ? rows.map((msg) => (msg?.speaker ? msg : { ...msg, speaker, _queueKey: session?.key }))
        : rows;
    }
    return mergeOrchestratedMessages(session, peers);
  }, [orchestrated, session, peers]);
  // Drop greeting voice rows once the same text lands in the persisted transcript.
  const messages = useMemo(() => {
    if (!voiceMessages.length) return baseMessages;
    const seen = new Set(
      baseMessages
        .filter((m) => typeof m.text === 'string')
        .map((m) => `${m.role}:${m.text.trim()}`),
    );
    const extra = voiceMessages.filter((m) => !seen.has(`${m.role}:${m.text.trim()}`));
    return extra.length ? [...baseMessages, ...extra] : baseMessages;
  }, [baseMessages, voiceMessages]);
  const peerBusy = peers.some((p) => p?.status === 'busy' || p?.status === 'thinking' || p?.live);
  const busy = session?.status === 'busy' || session?.status === 'thinking' || (orchestrated && peerBusy);
  // Composer Stop / voice only track THIS session's own turn — peer busy must
  // not lock the human out of prompting the orchestrator.
  const selfBusy = session?.status === 'busy' || session?.status === 'thinking';
  busyRef.current = selfBusy;
  const live = session?.live;
  const liveTurns = useMemo(() => {
    if (!orchestrated) return null;
    return mergeOrchestratedLiveTurns(session, peers);
  }, [orchestrated, session, peers]);
  const trustFromMessages = useMemo(
    () => messages.some((m) => isCursorTrustError(m)),
    [messages],
  );
  const showWorkspaceTrust = hasWorkspaceTrust
    && !trustGranted
    && (trustNeeded || trustFromMessages);

  useEffect(() => {
    if (!hasWorkspaceTrust || !workspaceTrust?.path) {
      setTrustNeeded(false);
      setTrustNote('');
      setTrustGranted(false);
      return undefined;
    }
    setTrustGranted(false);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(workspaceTrust.path, { headers: { Accept: 'application/json' } });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setTrustNeeded(Boolean(data?.needsTrust));
        if (!data?.installed && data?.error) setTrustNote(String(data.error));
        else if (!data?.needsTrust) setTrustNote('');
      } catch (err) {
        if (!cancelled) setTrustNote(err?.message || 'Could not check workspace trust');
      }
    })();
    return () => { cancelled = true; };
  }, [hasWorkspaceTrust, workspaceTrust?.path, session?.key]);

  async function grantWorkspaceTrust() {
    if (trustBusy || !workspaceTrust?.path) return;
    setTrustBusy(true);
    setTrustNote('');
    try {
      const res = await fetch(workspaceTrust.path, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setTrustNeeded(true);
        setTrustGranted(false);
        setTrustNote(data?.error || `Trust failed (HTTP ${res.status})`);
        return;
      }
      setTrustNeeded(false);
      setTrustGranted(true);
      setTrustNote('Workspace trusted — send again to continue.');
    } catch (err) {
      setTrustNeeded(true);
      setTrustGranted(false);
      setTrustNote(err?.message || 'Trust request failed');
    } finally {
      setTrustBusy(false);
    }
  }
  const liveToolKey = (live?.tools || []).map((t) => `${t.id}:${t.status}`).join('|');
  const partsFingerprint = (parts) => (parts || [])
    .map((p) => {
      if (p.type === 'thinking') return `t:${(p.text || '').length}`;
      if (p.type === 'approval') return `a:${p.approval?.id}:${p.approval?.status}`;
      // Asks must carry their own token like approvals do: without it every
      // question collapses to the tool fallback (`tool:null:null`), so a new
      // ask or an answered one leaves this key unchanged and the scroll /
      // vignette effects never re-run for it.
      if (p.type === 'ask') return `q:${p.ask?.id}:${p.ask?.status}`;
      return `tool:${p.tool?.id}:${p.tool?.status}`;
    })
    .join('|');
  const livePartsKey = [
    partsFingerprint(live?.parts),
    ...(liveTurns || []).map((turn) => `${turn.id}:${(turn.text || '').length}:${partsFingerprint(turn.parts)}`),
  ].join('/');
  const hasDraft = Boolean(draft.trim());
  // The server owns the real queue (POST/GET /kusa/queue); these two lists are
  // only what it last reported, so the UI can show and act on held prompts.
  const heldQueue = queued?.queued || [];
  const steeringQueue = queued?.steering || [];
  const queueTotal = heldQueue.length + steeringQueue.length;
  // Task List rows come from the plan/todo snapshot the monitor already keeps
  // for this lane — the same {id, content, status} items the Prompts panel
  // renders under "Plan". Nothing is invented here: with no tasks the control
  // is disabled, exactly like the queue control is disabled while the queue is
  // empty.
  const taskItems = (Array.isArray(tasks) ? tasks : []).filter((task) => {
    return Boolean(String(task?.content || '').trim());
  });
  const taskTotal = taskItems.length;
  const taskDone = taskItems.filter((task) => task?.status === 'completed').length;
  const taskDoing = taskItems.filter((task) => task?.status === 'in_progress').length;
  // The badge carries the counters the user follows, so a change to the list has
  // to be visible on the badge itself, not only in the rows below it. The
  // signature is id + status only: adding a task or moving a status changes it,
  // rewording a task does not, so an edit never reads as progress.
  const taskStatusKey = taskItems
    .map((task) => `${task?.id || ''}:${task?.status || ''}`)
    .join('|');
  // Seeded with the current signature, so opening a chat that already has tasks
  // beats nothing — a list that merely arrived is not a list that changed.
  const [taskPulseKey, setTaskPulseKey] = useState(taskStatusKey);
  // Which of the two beat names to use. Alternating is the only way a CSS
  // animation restarts on a node that already carries one, so a status update
  // inside a running beat replays it instead of being swallowed.
  const [taskBeat, setTaskBeat] = useState(0);
  const [taskPulsing, setTaskPulsing] = useState(false);
  const taskPulseTimer = useRef(0);
  // A prompt may be nothing but a picture, so "there is something to send" is
  // text OR files — the same contract POST /kusa/chat enforces.
  const hasPayload = hasDraft || Boolean(attachments.length);
  // The queue holds prompts the user typed: a row with no words is not a row
  // the queue can list, so only a typed draft may be held.
  // Composer send/queue/stop follow THIS session's turn only. Peer Subagent
  // activity shows in the merged transcript but must not force Queue mode.
  const canQueue = !composerLocked && hasDraft && selfBusy && Boolean(session) && Boolean(onQueue);
  const canSend = !composerLocked && hasPayload && !selfBusy && Boolean(session) && !editingId;
  // Stop stays available for Subagents (halt a runaway assign); only IDE-owned
  // chats block it. The message box itself stays locked via composerLocked.
  const canStop = !externalOwned && selfBusy && Boolean(session) && Boolean(onStop);
  const voiceActive = voicePhase !== 'idle' && voicePhase !== 'error';
  const canStartVoice = !composerLocked
    && Boolean(session)
    && !selfBusy
    && !hasPayload
    && !voiceActive
    && !editingId;

  useEffect(() => {
    // Soft status probe — browser voice does not require a Pipecat bot.
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch('/live-chat', { headers: { Accept: 'application/json' } });
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setLiveChatUp(data?.serverUp !== false && data?.mode !== 'pipecat-required');
      } catch {
        if (!cancelled) setLiveChatUp(true);
      }
    };
    void probe();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    try { voiceHandleRef.current?.stop?.(); } catch { /* ignore */ }
    voiceHandleRef.current = null;
  }, []);

  function openLiveChatDrawer() {
    setLiveChatExpanded(true);
    setQueueExpanded(false);
    setTasksExpanded(false);
    setPlansExpanded(false);
    setAttachmentsExpanded(false);
  }

  function getVoiceLevels(bandCount = 40) {
    return voiceHandleRef.current?.getAudioLevels?.(bandCount) ?? null;
  }

  async function toggleLiveVoice() {
    if (voiceActive) {
      try { voiceHandleRef.current?.stop?.(); } catch { /* ignore */ }
      voiceHandleRef.current = null;
      voiceExpectSpeakRef.current = false;
      spokenReplyLenRef.current = 0;
      setInterimTranscript('');
      setVoicePhase('idle');
      setVoiceError('');
      // Ending voice does not abort an in-flight agent turn.
      return;
    }
    if (!canStartVoice || !session) return;
    openLiveChatDrawer();
    setVoiceError('');
    setInterimTranscript('');
    setVoiceMessages([]);
    voiceExpectSpeakRef.current = false;
    spokenReplyLenRef.current = 0;
    lastSpokenAssistantIdRef.current = '';
    try {
      const handle = await startLiveVoiceSession({
        sessionId: session.id,
        queueKey: session.key,
        model: modelChoice || null,
        endpointId: endpointChoice || null,
        onPhase: (phase, detail) => {
          setVoicePhase(phase);
          if (phase === 'error' && detail) setVoiceError(detail);
        },
        onError: (err) => setVoiceError(err?.message || String(err)),
        onTranscript: ({ role, text, interim }) => {
          const trimmed = String(text || '').trim();
          if (!trimmed) return;
          if (interim) {
            setInterimTranscript(trimmed);
            return;
          }
          setInterimTranscript('');
          const voiceRole = role === 'assistant' ? 'assistant' : 'user';
          setVoiceMessages((prev) => [
            ...prev,
            {
              id: `voice-live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              role: voiceRole,
              text: trimmed,
              at: Date.now(),
              backend: 'browser-voice',
            },
          ]);
          // Final user STT → normal Kusă agent turn (composer pickers).
          if (voiceRole !== 'user') return;
          const key = sessionKeyRef.current;
          if (!key) {
            setVoiceError('Voice transcript missing chat session key');
            return;
          }
          const opts = { ...composerOptionsRef.current };
          voiceExpectSpeakRef.current = true;
          spokenReplyLenRef.current = 0;
          const send = busyRef.current && onQueueRef.current
            ? onQueueRef.current(key, 'enqueue', { text: trimmed, options: opts })
            : onSendRef.current?.(key, trimmed, opts);
          if (send && typeof send.then === 'function') {
            void send.catch((err) => {
              setVoiceError(err?.message || String(err));
            });
          }
        },
        onEnded: () => {
          voiceHandleRef.current = null;
          voiceExpectSpeakRef.current = false;
          spokenReplyLenRef.current = 0;
          setInterimTranscript('');
          setVoicePhase('idle');
        },
      });
      voiceHandleRef.current = handle;
    } catch (err) {
      setVoiceError(err?.message || String(err));
      setVoicePhase('error');
      voiceHandleRef.current = null;
    }
  }

  // A long queue hides itself rather than crowding the composer: past the cap
  // the list is switched off, and the toolbar control (which still shows the
  // count) is one click away from turning it back on.
  useEffect(() => {
    if (queueTotal > QUEUE_AUTO_COLLAPSE_AT) setQueueExpanded(false);
  }, [queueTotal]);

  // A long task list hides itself the same way, at its own cap.
  useEffect(() => {
    if (taskTotal > TASK_AUTO_HIDE_AT) setTasksExpanded(false);
  }, [taskTotal]);

  // A task added or a status moved: beat the badge for exactly one 2s pulse,
  // then let it settle. The countdown belongs to the LATEST change, so a change
  // that lands mid-beat cancels the older countdown and gets its own full 2s —
  // which is also why the timer is not returned as a cleanup: React runs the
  // previous cleanup before this body, and cancelling there would settle the
  // badge the instant it started.
  useEffect(() => {
    if (!taskStatusKey || taskStatusKey === taskPulseKey) return;
    setTaskPulseKey(taskStatusKey);
    setTaskBeat((beat) => beat + 1);
    setTaskPulsing(true);
    if (taskPulseTimer.current) clearTimeout(taskPulseTimer.current);
    taskPulseTimer.current = setTimeout(
      () => setTaskPulsing(false),
      TASK_BADGE_PULSE_MS,
    );
  }, [taskStatusKey, taskPulseKey]);

  const taskPulseClass = taskPulsing
    ? (taskBeat % 2 ? 'chat-badge-pulse-again' : 'chat-badge-pulse')
    : '';

  // The queue chip carries the count of held prompts, so the same kind of beat
  // belongs to it: a prompt added to the queue, or a held prompt handed to the
  // chat, has to be visible on the chip itself, not only in the rows below it.
  // The signature is prompt IDENTITY (sorted, so reordering a held queue by
  // dragging is not an add) plus how many prompts the chat already holds — so
  // adding one changes the first half, sending one changes the second, and
  // rewording or pausing a held prompt changes neither.
  const promptActivityKey = [
    [...heldQueue, ...steeringQueue].map((entry) => String(entry?.id ?? '')).sort().join('|'),
    // Only user turns count as prompts; assistant replies follow them and must
    // not beat the chip a second time for the same exchange.
    messages.filter((message) => message?.role === 'user').map((message) => String(message?.id ?? '')).join('|'),
  ].join('#');
  // Seeded with the current signature, so opening a chat that already has
  // prompts or a held queue beats nothing — arrived, not changed.
  const [promptBounceKey, setPromptBounceKey] = useState(promptActivityKey);
  const [promptBeat, setPromptBeat] = useState(0);
  const [promptBouncing, setPromptBouncing] = useState(false);
  const promptBounceTimer = useRef(0);

  // A prompt added or a prompt sent: bounce the chip for exactly one 2s beat,
  // then let it settle. Mirrors the task beat: the countdown belongs to the
  // LATEST change, so a change landing mid-beat cancels the older countdown and
  // gets its own full 2s — and the timer is deliberately not returned as a
  // cleanup, because React runs the previous cleanup before this body and
  // cancelling there would settle the chip the instant it started.
  useEffect(() => {
    if (promptActivityKey === promptBounceKey) return;
    setPromptBounceKey(promptActivityKey);
    setPromptBeat((beat) => beat + 1);
    setPromptBouncing(true);
    if (promptBounceTimer.current) clearTimeout(promptBounceTimer.current);
    promptBounceTimer.current = setTimeout(
      () => setPromptBouncing(false),
      PROMPT_BADGE_BOUNCE_MS,
    );
  }, [promptActivityKey, promptBounceKey]);

  const promptBounceClass = promptBouncing
    ? (promptBeat % 2 ? 'chat-badge-bounce-again' : 'chat-badge-bounce')
    : '';

  // Allow / Deny are sticky: no countdown, no automatic revert. A pick is a
  // promise about the rest of this session, so the gate keeps reading the same
  // rule until the Rules picker is used again — which is exactly why an Allow
  // rule cannot ask again on the next tool call.
  // A picker the user touched is stamped into THIS session right away — even
  // when it matches the Settings default. Writing only on difference would
  // leave such a pick unrecorded, so a later Settings change (or a refresh)
  // could move a chat the user had deliberately set.
  function selectComposerMode(next) {
    setAgentMode(next);
    commitPick({ mode: next });
  }

  function selectApprovalRule(next) {
    setApprovalRules(next);
    commitPick({ rules: next });
  }

  function selectComposerModel(next) {
    // Look up the live listing so the heading's endpointId rides with the pick —
    // probed-only ids never appear in that endpoint's declared Models list.
    const record = models.find((entry) => entry.id === next);
    const endpointId = record?.endpointId || '';
    setModelChoice(next);
    setEndpointChoice(endpointId);
    commitPick({ model: next, endpointId });
  }

  // Reload whenever Settings changes an endpoint / declared model list — the
  // fingerprint is assembled in App.jsx from agentBaseUrl + agentEndpoints so
  // adding a provider refreshes the picker without a full page reload.
  // Adapter-owned catalogs (Cursor `--list-models`) use session.modelsPath.
  const modelsRevision = agentDefaults?.modelsRevision || '';
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!showModelPicker) {
        setModelBackend('');
        setModels([]);
        return;
      }
      const catalogUrl = ownsModels && session?.modelsPath
        ? session.modelsPath
        : '/kusa/models';
      try {
        const res = await fetch(catalogUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        // GET /kusa/models (or /adapters/<provider>/models) answers ONE GROUP
        // PER CATALOG — BYOK groups by endpoint name; Cursor is a single
        // "Cursor" group. Each entry may carry vision + contextTokens so the
        // composer can warn on images and sync the ContextRing limit.
        const groups = Array.isArray(body?.groups) && body.groups.length
          ? body.groups
          : (Array.isArray(body?.models) ? [{ name: DEFAULT_MODEL_GROUP, models: body.models }] : []);
        const records = groups.flatMap((group) => {
          const name = String(group?.name || '').trim() || DEFAULT_MODEL_GROUP;
          const endpointId = String(group?.endpointId || '').trim();
          return (Array.isArray(group?.models) ? group.models : [])
            .map((entry) => {
              const id = (typeof entry === 'string' ? entry : entry?.id || entry?.model || '')?.trim();
              if (!id) return null;
              const vision = typeof entry === 'object' && typeof entry.vision === 'boolean'
                ? entry.vision
                : null;
              const label = typeof entry === 'object' && typeof entry.label === 'string' && entry.label.trim()
                ? entry.label.trim()
                : id;
              const contextTokens = typeof entry === 'object' && Number.isFinite(Number(entry.contextTokens))
                ? Math.max(1, Math.round(Number(entry.contextTokens)))
                : null;
              return { id, label, vision, contextTokens, group: name, endpointId };
            })
            .filter(Boolean);
        });
        if (cancelled) return;
        const fallback = (ownsModels ? body?.default : null)
          || agentDefaults?.model
          || body?.default
          || '';
        setModelBackend(ownsModels ? 'adapter' : (body?.backend === 'opencode' ? 'opencode' : 'native'));
        setModels(records.length
          ? records
          : (fallback ? [{ id: fallback, label: fallback, vision: null, contextTokens: null, group: DEFAULT_MODEL_GROUP, endpointId: '' }] : []));
      } catch {
        if (cancelled) return;
        setModelBackend('');
        if (ownsModels) {
          setModels([{ id: 'auto', label: 'Auto', vision: null, contextTokens: DEFAULT_CONTEXT_LIMIT, group: 'Cursor', endpointId: '' }]);
          return;
        }
        setModels(agentDefaults?.model
          ? [{ id: agentDefaults.model, label: agentDefaults.model, vision: null, contextTokens: null, group: DEFAULT_MODEL_GROUP, endpointId: '' }]
          : []);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [modelsRevision, agentDefaults?.model, showModelPicker, ownsModels, session?.modelsPath]);

  // A single-model endpoint still gets a picker — it defaults to that model. The
  // group each model came from rides through to the dropdown, which draws a
  // heading per endpoint, and endpointId is what resolveAgentEndpoint uses when
  // the pick is sent (declared Models alone cannot cover probed-only ids).
  const modelOptions = (models.length
    ? models
    : (modelChoice
      ? [{ id: modelChoice, label: modelChoice, vision: null, contextTokens: null, group: DEFAULT_MODEL_GROUP, endpointId: endpointChoice }]
      : []))
    .map((record) => ({
      id: record.id,
      label: record.label || record.id,
      group: record.group || DEFAULT_MODEL_GROUP,
      endpointId: record.endpointId || '',
      contextTokens: record.contextTokens || null,
    }));
  const matchedModel = modelOptions.find((option) => option.id === modelChoice);
  const activeModel = matchedModel?.id || modelOptions[0]?.id || modelChoice;
  const activeContextLimit = matchedModel?.contextTokens
    || models.find((record) => record.id === activeModel)?.contextTokens
    || DEFAULT_CONTEXT_LIMIT;
  // Prefer the live listing's endpoint for this id; fall back to the saved pick
  // so a send before /kusa/models returns still keeps the extra endpoint.
  const activeEndpointId = matchedModel
    ? (matchedModel.endpointId || '')
    : (endpointChoice || modelOptions[0]?.endpointId || '');
  const composerOptions = {
    mode: agentMode,
    approvalMode: approvalRules,
    model: activeModel,
    // Adapter catalogs never route through BYOK endpoints.
    endpointId: ownsModels ? '' : activeEndpointId,
  };
  composerOptionsRef.current = composerOptions;

  // Live voice phase mirrors the agent turn: busy → thinking; TTS owns speaking.
  useEffect(() => {
    if (!voiceActive) return;
    voiceHandleRef.current?.setAgentBusy?.(selfBusy);
  }, [selfBusy, voiceActive]);

  // Speak Kusă reply as it streams (sentence/newline chunks), then flush the tail.
  useEffect(() => {
    if (!voiceActive || !selfBusy || !voiceExpectSpeakRef.current) return;
    const liveText = typeof live?.text === 'string' ? live.text : '';
    if (!liveText) return;

    const already = spokenReplyLenRef.current;
    if (liveText.length <= already) return;
    const chunk = liveText.slice(already);
    // Prefer sentence ends; also split on markdown newlines so headers get spoken.
    const re = /(?:[^.!?\n]+[.!?]+(?:["')\]]+)?|[^\n]+\n+)/g;
    let lastEnd = 0;
    let match;
    while ((match = re.exec(chunk)) !== null) {
      const piece = match[0];
      lastEnd = match.index + piece.length;
      const spoken = stripMarkdownForSpeech(piece);
      if (spoken) voiceHandleRef.current?.speak?.(spoken);
    }
    if (lastEnd > 0) spokenReplyLenRef.current = already + lastEnd;
  }, [voiceActive, selfBusy, live?.text]);

  // Flush unspoken tail when the Kusă turn settles (no fragile STT↔user text match).
  useEffect(() => {
    if (!voiceActive || selfBusy || !voiceExpectSpeakRef.current) return;

    let reply = null;
    for (let i = baseMessages.length - 1; i >= 0; i -= 1) {
      const m = baseMessages[i];
      if (m?.role !== 'assistant') continue;
      if (m.streaming) return;
      const replyText = typeof m.text === 'string' ? m.text.trim() : '';
      if (!replyText) continue;
      if (m.id && m.id === lastSpokenAssistantIdRef.current) {
        voiceExpectSpeakRef.current = false;
        spokenReplyLenRef.current = 0;
        return;
      }
      reply = m;
      break;
    }
    if (!reply) return;

    if (reply.id) lastSpokenAssistantIdRef.current = reply.id;
    const full = String(reply.text || '');
    const already = spokenReplyLenRef.current;
    const unsaid = full.slice(already);
    spokenReplyLenRef.current = 0;
    voiceExpectSpeakRef.current = false;
    const spoken = stripMarkdownForSpeech(unsaid || (already === 0 ? full : ''));
    if (spoken) voiceHandleRef.current?.speak?.(spoken);
  }, [selfBusy, voiceActive, baseMessages]);

  // Whether an image attached to THIS draft can actually reach the model. A
  // text-only endpoint cannot see one, and OpenCode takes a prompt string, so
  // no picture is ever sent as a part there. Unknown capability counts as
  // "may see" — exactly the loop's own rule (supportsVision(model) !== false),
  // so the chip and the request agree.
  const imagesReachModel =
    modelBackend !== 'opencode'
    && models.find((record) => record.id === activeModel)?.vision !== false;

  // A chat owns its pickers, but this component instance is reused when the
  // sidebar moves to another chat — re-seed from THAT session's record so
  // switching chats never carries a pick over. A re-seed is not a pick, so
  // nothing here is written back: only a dropdown the user actually used is.
  const seededKeyRef = useRef('');
  if (session?.key && session.key !== seededKeyRef.current) {
    seededKeyRef.current = session.key;
    const sessionOwnsModels = Boolean(session?.ownsModels && session?.modelsPath);
    setAgentMode(initialComposerMode(sessionOptions, agentDefaults));
    setApprovalRules(initialComposerRule(sessionOptions, agentDefaults));
    setModelChoice(initialComposerModel(sessionOptions, agentDefaults, { ownsModels: sessionOwnsModels }));
    setEndpointChoice(sessionOwnsModels ? '' : initialComposerEndpointId(sessionOptions));
  }

  const onSessionOptionsRef = useRef(onSessionOptions);
  onSessionOptionsRef.current = onSessionOptions;
  // Full current pick with the one field the user just chose: fields absent
  // from `over` keep the live picker state, so the other pickers are untouched
  // and a partial change can never drop them from the record.
  const commitPick = (over = {}) => {
    if (!session?.key || !onSessionOptionsRef.current) return;
    void onSessionOptionsRef.current(session.key, {
      mode: over.mode !== undefined ? over.mode : agentMode,
      rules: over.rules !== undefined ? over.rules : approvalRules,
      model: over.model !== undefined ? over.model : modelChoice,
      endpointId: over.endpointId !== undefined ? over.endpointId : endpointChoice,
    });
  };
  // No blanket write-back. Every pick reaches the record through commitPick, and
  // nothing else moves a rule: with Allow / Deny sticky there is no timer to
  // persist, so a pick can never be stamped over by an automatic revert and a
  // refresh reopens the chat on the rule the user chose.
  // A chat that never picked still carries no options at all, because nothing
  // here invents a pick: Settings → Kusă agent fills that in on every load.
  const rulePickerOptions = useMemo(
    () => ruleOptions({ approvalTimeoutMinutes }),
    [approvalTimeoutMinutes],
  );

  useEffect(() => {
    if (busy) setEditingId(null);
  }, [busy]);

  // While a turn is running, Mode / Rules changes must reach the server so the
  // agent loop can apply them on the very next tool call — not only on the next
  // Send. Idle picker changes stay local until the user sends. Ref keeps the
  // effect off App re-renders (handler identity changes every paint).
  const onTurnOptionsRef = useRef(onTurnOptions);
  onTurnOptionsRef.current = onTurnOptions;
  useEffect(() => {
    if (!busy || !session?.key || !onTurnOptionsRef.current) return;
    void onTurnOptionsRef.current(session.key, {
      mode: agentMode,
      approvalMode: approvalRules,
    });
  }, [busy, session?.key, agentMode, approvalRules]);

  // Where the transcript is parked. Measuring the scroll container is the only
  // honest signal: a native `scroll` listener fires for user scrolling (and for
  // the programmatic scrolls below, which always land where they can be
  // re-measured), while React deps cannot see a hand on the wheel.
  const backReadAt = () => {
    const panel = panelRef.current;
    if (!panel) return false;
    const max = panel.scrollHeight - panel.clientHeight;
    // Nothing to scroll: there is no "up", so the chat is always at the bottom.
    if (max <= BACK_READ_SLOP_PX) return false;
    return panel.scrollTop < max - BACK_READ_SLOP_PX;
  };

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const onScroll = () => setBackReading(backReadAt());
    panel.addEventListener('scroll', onScroll);
    // A new session starts at the newest turn, never mid-scroll.
    setBackReading(false);
    return () => panel.removeEventListener('scroll', onScroll);
  }, [session?.key]);

  // Auto-scroll: pin the newest turn to the bottom of the transcript — but only
  // while the user is reading AT the bottom. Once they scroll up to back-read,
  // nothing may yank them back; the jump-to-bottom control (see the panel
  // markup below) is how they return, and it clears this flag itself.
  useEffect(() => {
    if (backReading) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [backReading, messages.length, session?.key, busy, live?.text, live?.thinking, liveToolKey, livePartsKey]);

  // Declared after the scroll-to-bottom above, so on the frame where a gate
  // appears this one wins: its Allow/Deny (or answer list) must be ON screen and
  // clickable. The live agent block stays in vignette (clipped) while a gate is
  // pending — ClippedGrow scrolls the CTA clear of its bottom fade, and this
  // scroll brings that CTA into the chat panel. The row stays in transcript flow.
  // lastPendingGate, not querySelector: settled gates stay rendered as
  // transcript records and a turn can hold several gates open at once, so the
  // first match is an older row the user has nothing left to click — that is
  // what made the scroll jump back up the page instead of serving the live one.
  useEffect(() => {
    const row = lastPendingGate(document);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [livePartsKey]);

  useEffect(() => {
    setDraft('');
    setEditingId(null);
    // Files belong to a draft, and a different session is a different draft —
    // a picture staged while reading one chat must never ride into the next.
    setAttachments([]);
    setAttachNote('');
    inputRef.current?.focus();
  }, [session?.key]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 200)}px`;
  }, [draft]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => {
      const height = el.getBoundingClientRect().height;
      setAgentMaxHeight(height > 0 ? Math.round(height * AGENT_EXPAND_HEIGHT_RATIO) : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [session?.key]);

  /**
   * Merge freshly-read attachment records into the draft and open the
   * Attachments drawer. Shared by the paperclip menu, composer paste, and
   * composer drop so the three paths cannot disagree about caps or notes.
   */
  function commitStaged(added, emptyNote = '') {
    const already = added.filter((attachment) =>
      attachments.some((held) => held?.name === attachment.name && held?.size === attachment.size),
    );
    const { list, rejected } = stageAttachments(attachments, added);
    setAttachments(list);
    setAttachNote(
      rejected.length
        ? `not added — this message holds ${ATTACHMENT_LIMITS.files} files at most`
        : already.length && !rejected.length && already.length === added.length
          ? 'already on this message — it is attached once'
          : emptyNote,
    );
    if (list.length) {
      setAttachmentsExpanded(true);
      setQueueExpanded(false);
      setTasksExpanded(false);
    }
  }

  /** Turn dropped/pasted File objects into staged attachment records. */
  async function stageFiles(files) {
    const added = [];
    for (const file of files || []) {
      const attachment = await fileToAttachment(file);
      if (attachment) added.push(attachment);
    }
    if (!added.length) return;
    commitStaged(added);
  }

  /**
   * One paperclip action, run the moment the user clicks it. The file chooser
   * is the operating system's own (showOpenFilePicker where the browser has it,
   * a file <input> where it does not) and the user answers it at their own
   * pace, so this runs async: the composer never blocks, and the Attachments
   * drawer opens when the dialog answers. Nothing is invented here — a file
   * the browser cannot read keeps its name and a note saying so, a cancelled
   * dialog adds nothing, and an over-budget pick is refused rather than
   * half-attached.
   */
  function attachRequested(action) {
    const run = async () => {
      const added = [];
      let note = '';
      try {
        if (action === 'files') {
          for (const file of await pickFilesWithOsDialog(ATTACHMENT_LIMITS.files)) {
            const attachment = await fileToAttachment(file);
            if (attachment) added.push(attachment);
          }
        } else {
          let pasted = await readClipboardAttachment();
          if (!pasted) {
            // No clipboard.read, or the permission is off — Firefox and Safari
            // have no such API at all. The paste event hands the same clipboard
            // over with no prompt, but only while the user is pasting, so say
            // so BEFORE the window opens: the note is the instruction.
            setAttachNote(PASTE_REQUEST_NOTE);
            pasted = await readClipboardViaPaste();
          }
          if (pasted) {
            added.push(pasted);
          } else {
            note = 'the clipboard holds no image or text to take — a normal paste types into the composer instead';
          }
        }
      } catch {
        // A chooser the browser cannot open is simply no attachment: what the
        // user already staged stays on the message.
      }
      commitStaged(added, note);
    };
    void run();
  }

  /**
   * Paste into the composer: files/images become attachments; plain text
   * types into the box as usual. Same rule as a drop onto the message box.
   */
  function onComposerPaste(event) {
    const transfer = event.clipboardData;
    if (!transferHasFiles(transfer)) return;
    event.preventDefault();
    void stageFiles(collectTransferFiles(transfer));
  }

  function onComposerDragOver(event) {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    try {
      event.dataTransfer.dropEffect = 'copy';
    } catch {
      /* some browsers reject dropEffect writes */
    }
  }

  function onComposerDrop(event) {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    void stageFiles(collectTransferFiles(event.dataTransfer));
  }

  function submit(event) {
    event?.preventDefault?.();
    const text = draft.trim();
    const staged = attachments.slice();
    if (!session) return;
    if (!text && !staged.length) return;
    if (busy) {
      // The agent is mid-turn: do not start a second, competing turn. Hold the
      // prompt (Cursor/Copilot queue) — its files ride with it so flushing it
      // later behaves exactly as pressing Send at this moment did. A picture
      // with no words cannot be held: a queue row is a row of words.
      if (!onQueue || !text) return;
      void onQueue(session.key, 'enqueue', { text, options: { ...composerOptions, attachments: staged } });
      setDraft('');
      setAttachments([]);
      setAttachNote('');
      setAttachmentsExpanded(false);
      return;
    }
    onSend?.(session.key, text, { ...composerOptions, attachments: staged });
    setDraft('');
    setAttachments([]);
    setAttachNote('');
    setAttachmentsExpanded(false);
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const closeOtherDrawers = (except) => {
    if (except !== 'queue') setQueueExpanded(false);
    if (except !== 'tasks') setTasksExpanded(false);
    if (except !== 'plans') setPlansExpanded(false);
    if (except !== 'attachments') setAttachmentsExpanded(false);
    if (except !== 'live') setLiveChatExpanded(false);
  };

  const drawers = (
    <>
      <TaskStack
        tasks={taskItems}
        expanded={tasksExpanded}
        dock={drawerDock}
        onDockToggle={toggleDrawerDock}
        onClose={() => setTasksExpanded(false)}
      />
      <PlanStack
        plans={workspacePlans.plans}
        expanded={plansExpanded}
        selectedId={workspacePlans.selectedId}
        selectedPlan={workspacePlans.selectedPlan}
        busy={workspacePlans.busy}
        note={workspacePlans.note}
        dock={drawerDock}
        onDockToggle={toggleDrawerDock}
        onClose={() => setPlansExpanded(false)}
        onSelect={(id) => { void workspacePlans.select(id); }}
        onBack={workspacePlans.back}
        onApprove={(id) => { void workspacePlans.approve(id); }}
        onContinue={(id) => { void workspacePlans.continueWorkflow(id); }}
        onRemove={(id) => { void workspacePlans.remove(id); }}
        onRefresh={() => { void workspacePlans.refresh(); }}
      />
      <AttachmentStack
        attachments={attachments}
        expanded={attachmentsExpanded}
        imagesReachModel={imagesReachModel}
        note={attachNote}
        dock={drawerDock}
        onDockToggle={toggleDrawerDock}
        onClose={() => setAttachmentsExpanded(false)}
        onChange={(next) => {
          setAttachments(next);
          setAttachNote('');
          if (!next.length) setAttachmentsExpanded(false);
        }}
      />
      <QueueStack
        held={heldQueue}
        steering={steeringQueue}
        sessionKey={session?.key}
        onQueue={onQueue}
        expanded={queueExpanded}
        dock={drawerDock}
        onDockToggle={toggleDrawerDock}
        onClose={() => setQueueExpanded(false)}
      />
      <LiveChatStack
        expanded={liveChatExpanded}
        voiceActive={voiceActive}
        voicePhase={voicePhase}
        voiceError={voiceError}
        liveChatUp={liveChatUp}
        interimTranscript={interimTranscript}
        getLevels={getVoiceLevels}
        avatarUrl={agentDefaults?.avatar || ''}
        dock={drawerDock}
        onDockToggle={toggleDrawerDock}
        onClose={() => setLiveChatExpanded(false)}
      />
    </>
  );

  const drawerOpen = !externalOwned && (
    (queueExpanded && queueTotal > 0)
    || (tasksExpanded && taskTotal > 0)
    || plansExpanded
    || (attachmentsExpanded && attachments.length > 0)
    || liveChatExpanded
  );
  const bottomDockOpen = drawerDock === 'bottom' && drawerOpen;
  const rightDockOpen = drawerDock === 'right' && drawerOpen;

  return (
    <div
      ref={shellRef}
      className={`flex h-full min-h-0 ${drawerDock === 'right' ? 'flex-row' : 'flex-col'}`}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={panelRef}
        className="relative z-0 min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        {showWorkspaceTrust ? (
          <div className="w-full pb-4">
            <SetupGuide
              title={workspaceTrust?.title || 'Workspace trust required'}
              summary={workspaceTrust?.summary || 'This provider needs the workspace trusted before it can run.'}
              steps={[
                'Trusts only this workspace directory for the provider CLI',
                'After it succeeds, send your message again',
              ]}
              action={{
                label: workspaceTrust?.label || 'Trust workspace',
                busyLabel: 'Trusting workspace…',
                busy: trustBusy,
                onClick: () => { void grantWorkspaceTrust(); },
              }}
              footnote={trustNote || undefined}
            />
          </div>
        ) : null}
        {!messages.length && !busy ? (
          <div className="w-full flex flex-col items-start gap-3 pt-10">
            <p className="text-sm font-medium text-gray-200">
              {cliBacked
                ? `New ${(
                  CHAT_PROVIDER_GROUPS.find((g) => g.id === session?.provider)?.label
                  || HARNESS_NAMES[session?.harness]
                  || 'provider'
                )} session`
                : 'New Kusă chat'}
            </p>
            <p className="text-sm leading-relaxed text-gray-500">
              Session <code className="font-mono text-gray-400">{shortId(session?.id)}</code>.
              {cliBacked
                ? (hasWorkspaceTrust
                  ? ' Messages go through the provider CLI. Trust this workspace if prompted, then send.'
                  : ' Messages go through the selected provider CLI.')
                : ' Configure the OpenAI-compatible endpoint under Settings, then send a message. Thinking and tool calls appear inline like VS Code chat.'}
            </p>
          </div>
        ) : (
          <div className="w-full flex flex-col gap-6">
            {messages.map((msg) => {
              const gateKey = msg._queueKey || msg.speaker?.queueKey || session.key;
              return (
                <ChatTurn
                  key={msg.id}
                  msg={msg}
                  busy={selfBusy}
                  editing={!composerLocked && editingId === msg.id}
                  onStartEdit={
                    composerLocked
                      ? undefined
                      : () => setEditingId(msg.id)
                  }
                  onCancelEdit={
                    composerLocked
                      ? undefined
                      : () => setEditingId(null)
                  }
                  onResendEdit={
                    composerLocked
                      ? undefined
                      : (text) => {
                        if (!session || selfBusy) return;
                        setEditingId(null);
                        // The files staged now belong to the message being resent,
                        // not to the one being edited — same rule as pressing Send.
                        onSend?.(
                          session.key,
                          text,
                          { ...composerOptions, editMessageId: msg.id, attachments: attachments.slice() },
                        );
                        setAttachments([]);
                        setAttachNote('');
                        setAttachmentsExpanded(false);
                      }
                  }
                  agentMaxHeight={agentMaxHeight}
                  onApproval={
                    // Pending gate cards (incl. Subagent relays on the parent) must
                    // stay answerable after they land in history — not only while live.
                    externalOwned || !onApproval
                      ? null
                      : async (decision) => { await onApproval(gateKey, decision); }
                  }
                  onAsk={
                    externalOwned || !onAsk
                      ? null
                      : (decision) => onAsk(gateKey, decision)
                  }
                  onTrustWorkspace={
                    hasWorkspaceTrust && !trustGranted
                      ? () => { void grantWorkspaceTrust(); }
                      : null
                  }
                  trustBusy={trustBusy}
                  trustNote={trustNote}
                />
              );
            })}
            {orchestrated && liveTurns?.length ? (
              liveTurns.map((turn) => {
                const gateKey = turn._queueKey || turn.speaker?.queueKey || session.key;
                if (turn._placeholder) {
                  return (
                    <div key={turn.id} className="text-sm">
                      <span className="chat-shimmer font-medium text-gray-300">
                        {turn.speaker?.role
                          ? `${String(turn.speaker.role).replace(/\b\w/g, (c) => c.toUpperCase())}…`
                          : 'Thinking…'}
                      </span>
                    </div>
                  );
                }
                return (
                  <ChatTurn
                    key={turn.id}
                    msg={turn}
                    agentMaxHeight={agentMaxHeight}
                    onApproval={
                      externalOwned || !onApproval
                        ? null
                        : async (decision) => { await onApproval(gateKey, decision); }
                    }
                    onAsk={
                      externalOwned || !onAsk
                        ? null
                        : (decision) => onAsk(gateKey, decision)
                    }
                    onTrustWorkspace={
                      hasWorkspaceTrust && !trustGranted
                        ? () => { void grantWorkspaceTrust(); }
                        : null
                    }
                    trustBusy={trustBusy}
                    trustNote={trustNote}
                  />
                );
              })
            ) : selfBusy && live ? (
              <ChatTurn
                msg={{
                  id: 'live',
                  role: 'assistant',
                  text: live.text || '',
                  thinking: live.thinking || '',
                  tools: live.tools || [],
                  parts: live.parts || [],
                  streaming: true,
                  speaker: speakerFromSession(session),
                }}
                agentMaxHeight={agentMaxHeight}
                onApproval={
                  externalOwned || !onApproval
                    ? null
                    : async (decision) => {
                        // The click settles THIS call only — it is not a Rule and
                        // it must not move one. The Rule is whatever the Rules
                        // picker holds, and that picker is the only thing that
                        // writes a sticky pick into the session record (see
                        // selectApprovalRule / commitPick). Stamping the click
                        // used to persist Allow/Deny into .chat.json, which
                        // silently overrode a pick the user had made; ChatTurn
                        // already catches a rejected POST, so nothing is wrapped
                        // here.
                        await onApproval(session.key, decision);
                      }
                }
                onAsk={
                  externalOwned || !onAsk
                    ? null
                    : (decision) => onAsk(session.key, decision)
                }
                onTrustWorkspace={
                  hasWorkspaceTrust && !trustGranted
                    ? () => { void grantWorkspaceTrust(); }
                    : null
                }
                trustBusy={trustBusy}
                trustNote={trustNote}
              />
            ) : selfBusy ? (
              <div className="text-sm">
                <span className="chat-shimmer font-medium text-gray-300">Thinking…</span>
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>
        )}
        {/*
         * Jump-to-bottom control: only while back-reading. It sticks to the
         * bottom centre of the transcript at any scroll offset, so it reads as
         * a floating button on the chat window rather than a row in the
         * transcript — the wrapper is zero-height so the control never adds
         * scroll height, and the button itself is the only hit target.
         */}
        {backReading ? (
          <div className="sticky bottom-0 h-0 w-full z-40">
            <button
              type="button"
              onClick={() => {
                const panel = panelRef.current;
                if (panel) panel.scrollTop = panel.scrollHeight;
                setBackReading(false);
              }}
              title="Jump back to the latest turn"
              aria-label="Jump back to the latest turn"
              className="absolute bottom-1 left-1/2 -translate-x-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-700 bg-gray-950/92 text-gray-400 shadow-lg backdrop-blur hover:bg-gray-900 hover:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <ChevronDownIcon className="text-gray-300" />
            </button>
          </div>
        ) : null}
      </div>

      {/*
       * Bottom dock: drawers sit above the composer. Height is drag-resized
       * from the top edge, capped at half the chat shell.
       */}
      {bottomDockOpen ? (
        <div className="relative shrink-0" style={{ height: heightPx }}>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-valuenow={heightPx}
            aria-valuemin={DRAWER_MIN_HEIGHT}
            aria-valuemax={maxDrawerHeight}
            aria-label="Resize drawer height"
            title="Drag to resize"
            onPointerDown={(event) => beginDrawerResize('height', event)}
            className="absolute inset-x-0 -top-0.5 z-10 h-2 cursor-ns-resize touch-none hover:bg-emerald-500/25"
          />
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {drawers}
          </div>
        </div>
      ) : null}

      <form
        className="@container relative z-50 shrink-0 border-t border-gray-800/80 bg-gray-950/70 px-4 py-3 backdrop-blur sm:px-6"
        onSubmit={composerLocked ? (event) => event.preventDefault() : submit}
      >
        {externalOwned ? (
          <div
            className="flex items-start gap-3 rounded-2xl border border-amber-700/40 bg-amber-950/25 px-3.5 py-3"
            role="status"
          >
            <LucideIcon
              name="external-link"
              className="mt-0.5 h-[18px] w-[18px] shrink-0 text-amber-400"
              title="External session"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-amber-100">
                Owned by Cursor UI
              </p>
              <p className="text-xs leading-relaxed text-amber-200/80">
                This session is mirrored from Cursor. Prompting is disabled here so Kusă
                does not mix a separate Cursor CLI chat into the same transcript — continue
                in Cursor.
              </p>
            </div>
          </div>
        ) : isSubagent ? (
          <div
            className="flex items-start gap-3 rounded-2xl border border-sky-700/40 bg-sky-950/25 px-3.5 py-3"
            role="status"
          >
            <LucideIcon
              name="network"
              className="mt-0.5 h-[18px] w-[18px] shrink-0 text-sky-400"
              title="Subagent"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium text-sky-100">
                Driven by parent Agent
              </p>
              <p className="text-xs leading-relaxed text-sky-200/80">
                This Subagent runs prompts assigned by its parent (plan workflow).
                Human messaging is disabled here — assigned turns start on the server
                automatically; open the parent Agent to orchestrate.
              </p>
            </div>
            {canStop ? (
              <button
                type="button"
                title="Stop this run"
                aria-label="Stop response"
                onClick={() => { void onStop(session.key); }}
                className="chat-composer-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-600 text-white hover:bg-rose-500"
              >
                <StopIcon />
              </button>
            ) : null}
          </div>
        ) : (
        <>
        {/*
         * Composer chrome: Queue / Tasks / Attachments sit above the input.
         * Mode / Rule / Model live inside the composer footer (left of the
         * context ring + action icons). The form is an @container so a narrow
         * chat column collapses even when the window is wide — below 36rem the
         * three pickers merge into one icon menu (ComposerOptionsMenu) and the
         * popup switches drop their names, leaving glyph + count.
         */}
        <div className="flex items-center justify-end gap-1.5 pb-1.5">
          {/* Tab-style popup switches (PopupList.jsx): opening one closes the
              others so only a single list sits above the composer. */}
          <PopupToggle
            icon={QueueIcon}
            label="Prompt Queue"
            count={queueTotal}
            noun="held"
            pulseClass={promptBounceClass}
            expanded={queueExpanded}
            onToggle={() => {
              setQueueExpanded((open) => {
                const next = !open;
                if (next) closeOtherDrawers('queue');
                return next;
              });
            }}
          />
          <PopupToggle
            icon={TaskIcon}
            label="Task List"
            count={taskTotal}
            noun="listed"
            progress={`${taskDone}/${taskTotal}`}
            countClassName="text-emerald-300/90"
            activeClassName="bg-emerald-500/15 text-emerald-300"
            pulseClass={taskPulseClass}
            expanded={tasksExpanded}
            onToggle={() => {
              setTasksExpanded((open) => {
                const next = !open;
                if (next) closeOtherDrawers('tasks');
                return next;
              });
            }}
          />
          <PopupToggle
            icon={PlanIcon}
            label="Plans"
            count={workspacePlans.plans.length}
            noun="plans"
            available
            countClassName="text-violet-300/90"
            activeClassName="bg-violet-500/15 text-violet-300"
            expanded={plansExpanded}
            onToggle={() => {
              setPlansExpanded((open) => {
                const next = !open;
                if (next) {
                  closeOtherDrawers('plans');
                  void workspacePlans.refresh();
                }
                return next;
              });
            }}
          />
          <PopupToggle
            icon={AttachmentsIcon}
            label="Attachments"
            count={attachments.length}
            noun="staged"
            countClassName="text-sky-300/90"
            activeClassName="bg-sky-500/15 text-sky-300"
            expanded={attachmentsExpanded}
            onToggle={() => {
              setAttachmentsExpanded((open) => {
                const next = !open;
                if (next) closeOtherDrawers('attachments');
                return next;
              });
            }}
          />
          <PopupToggle
            icon={LiveChatIcon}
            label="Live Chat"
            count={voiceActive ? 1 : 0}
            noun="live"
            available
            countClassName="text-emerald-300/90"
            activeClassName="bg-emerald-500/15 text-emerald-300"
            expanded={liveChatExpanded}
            onToggle={() => {
              setLiveChatExpanded((open) => {
                const next = !open;
                if (next) closeOtherDrawers('live');
                return next;
              });
            }}
          />
        </div>
        <div className="w-full">
          <div
            className={`chat-composer rounded-2xl border bg-gray-900/90 shadow-sm transition-[border-color,box-shadow] ${
              selfBusy
                ? 'border-gray-700'
                : 'border-gray-700 focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/30'
            }`}
            onDragOver={onComposerDragOver}
            onDrop={onComposerDrop}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onComposerPaste}
              placeholder={
                selfBusy
                  ? 'Kusă is working… pressing Send holds this prompt in the queue'
                  : editingId
                    ? 'Finish or cancel the edit above…'
                    : 'Add a follow-up'
              }
              disabled={Boolean(editingId)}
              aria-label="Chat message"
              className="block max-h-[200px] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-sm leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none disabled:opacity-50"
            />
            <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-0.5">
              <div className="hidden min-w-0 flex-wrap items-center gap-0.5 @[36rem]:flex">
                <ComposerDropdown
                  title="Mode"
                  options={AGENT_MODE_OPTIONS}
                  value={agentMode}
                  onSelect={selectComposerMode}
                />
                <ComposerDropdown
                  title="Rule"
                  options={rulePickerOptions}
                  value={approvalRules}
                  onSelect={selectApprovalRule}
                />
                {showModelPicker ? (
                  <ComposerDropdown
                    title="Model"
                    options={modelOptions}
                    value={activeModel}
                    onSelect={selectComposerModel}
                  />
                ) : (
                  <span className="rounded-md px-1.5 py-0.5 text-[11px] text-gray-500">
                    via provider CLI
                  </span>
                )}
              </div>
              <div className="@[36rem]:hidden">
                <ComposerOptionsMenu
                  mode={agentMode}
                  modeOptions={AGENT_MODE_OPTIONS}
                  onModeSelect={selectComposerMode}
                  rule={approvalRules}
                  ruleOptions={rulePickerOptions}
                  onRuleSelect={selectApprovalRule}
                  model={showModelPicker ? activeModel : ''}
                  modelOptions={showModelPicker ? modelOptions : []}
                  onModelSelect={selectComposerModel}
                />
              </div>
              <p className={`min-w-0 flex-1 truncate px-1 text-[11px] ${attachNote ? 'text-rose-400' : 'text-gray-600'}`}>
                {attachNote
                  ? attachNote
                  : selfBusy
                    ? 'Generating… · Send queues · Stop ends this run'
                    : editingId
                      ? 'Editing — resend replaces everything after it'
                      : null}
              </p>
              <div className="flex shrink-0 items-center gap-0.5">
                <ContextRing
                  used={estimateContextTokens(messages, live)}
                  limit={activeContextLimit}
                />
                <AttachmentPicker
                  onAction={(action) => {
                    void attachRequested(action);
                  }}
                />
                <button
                  type="button"
                  disabled
                  title="Dictate — not wired up yet"
                  aria-label="Dictate message"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 disabled:cursor-not-allowed"
                >
                  <DictateIcon />
                </button>
                {hasPayload && (selfBusy || canSend) ? (
                  <button
                    type="submit"
                    disabled={!canSend && !canQueue}
                    title={selfBusy ? 'Queue for this run' : 'Send'}
                    aria-label={selfBusy ? 'Queue message' : 'Send'}
                    className={`chat-composer-action inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                      canSend || canQueue
                        ? (selfBusy
                          ? 'bg-amber-600 text-white hover:bg-amber-500'
                          : 'bg-emerald-600 text-white hover:bg-emerald-500')
                        : 'bg-gray-800 text-gray-600'
                    } disabled:cursor-not-allowed`}
                  >
                    <ArrowUpIcon />
                  </button>
                ) : selfBusy ? (
                  <button
                    type="button"
                    disabled={!canStop}
                    title="Stop this run — the next queued prompt is sent next"
                    aria-label="Stop response"
                    onClick={() => {
                      if (!canStop) return;
                      // Abort the running turn; the queue snapshot it returns
                      // feeds the idle-flush, which sends the next held prompt.
                      void onStop(session.key);
                    }}
                    className="chat-composer-action inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors bg-rose-600 text-white hover:bg-rose-500 disabled:cursor-not-allowed"
                  >
                    <StopIcon />
                  </button>
                ) : hasPayload ? (
                  <button
                    type="submit"
                    disabled={!canSend}
                    title="Send"
                    aria-label="Send"
                    className={`chat-composer-action inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                      canSend
                        ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                        : 'bg-gray-800 text-gray-600'
                    } disabled:cursor-not-allowed`}
                  >
                    <ArrowUpIcon />
                  </button>
                ) : voiceActive ? (
                  <button
                    type="button"
                    title={`End live voice (${voicePhase})`}
                    aria-label="End live voice"
                    onClick={() => { void toggleLiveVoice(); }}
                    className="chat-composer-action inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors bg-rose-600 text-white hover:bg-rose-500"
                  >
                    <StopIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!canStartVoice}
                    title={voiceError || 'Live voice (browser)'}
                    aria-label="Live voice"
                    onClick={() => { void toggleLiveVoice(); }}
                    className={`chat-composer-action inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${
                      canStartVoice
                        ? 'border-emerald-600/60 bg-emerald-900/40 text-emerald-300 hover:bg-emerald-800/50'
                        : 'border-gray-700 bg-gray-800/80 text-gray-400 disabled:cursor-not-allowed'
                    }`}
                  >
                    <VoiceIcon />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        </>
        )}
      </form>
      </div>

      {/*
       * Right dock: same drawers, flush left of the right rail. Width is
       * drag-resized from the left edge, capped at half the chat shell.
       * border-l matches the rail's gray-800 edge language.
       */}
      {rightDockOpen ? (
        <aside
          className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-gray-800 bg-gray-950/70"
          style={{ width: widthPx }}
          aria-label="Docked drawer"
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={widthPx}
            aria-valuemin={DRAWER_MIN_WIDTH}
            aria-valuemax={maxDrawerWidth}
            aria-label="Resize drawer width"
            title="Drag to resize"
            onPointerDown={(event) => beginDrawerResize('width', event)}
            className="absolute inset-y-0 -left-0.5 z-10 w-2 cursor-ew-resize touch-none hover:bg-emerald-500/25"
          />
          <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {drawers}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
