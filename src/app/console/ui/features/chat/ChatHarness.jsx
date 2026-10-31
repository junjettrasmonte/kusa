import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { shortId } from '#ui/shared/lib/format.js';
import {
  AGENT_MODE_OPTIONS,
  AttachmentPicker,
  ComposerDropdown,
  ContextRing,
  DictateIcon,
  RULE_OPTIONS,
  VoiceIcon,
  ruleOptions,
} from './ComposerControls.jsx';
import {
  ATTACHMENT_LIMITS,
  fileToAttachment,
  pickFilesWithOsDialog,
  readClipboardAttachment,
  readClipboardViaPaste,
  stageAttachments,
} from '#ui/shared/lib/attachments.js';
import { AttachmentChips } from '#ui/shared/AttachmentChips.jsx';
import { PopupList, PopupToggle } from './PopupList.jsx';
import { estimateContextTokens, truncate } from '#ui/shared/lib/chatText.js';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  QueueIcon,
  StopIcon,
  TaskIcon,
} from './ChatGlyphs.jsx';
import { ClippedGrow, lastPendingGate } from './ClippedGrow.jsx';
import { QueueStack } from './QueuePanel.jsx';
import { TaskStack } from './TaskPanel.jsx';
import { ChatTurn } from './TranscriptTurns.jsx';

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

function initialComposerModel(options, defaults) {
  const saved = options?.model;
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  return defaults?.model || '';
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

/**
 * First-party Kusă chat surface — transcript styled like VS Code chat:
 * shimmering thinking header, progressive collapsible tool rows, then reply.
 */
export function ChatHarness({
  session,
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
  // expected: the caps, a cancelled dialog, an empty clipboard. Rendered beside
  // the chips, and never invented — '' means there is nothing to say.
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
  const [agentMode, setAgentMode] = useState(() => initialComposerMode(sessionOptions, agentDefaults));
  const [approvalRules, setApprovalRules] = useState(() => initialComposerRule(sessionOptions, agentDefaults));
  const [modelChoice, setModelChoice] = useState(() => initialComposerModel(sessionOptions, agentDefaults));
  const [models, setModels] = useState([]);
  // Which backend the configured endpoint runs ('opencode' | 'native' | '').
  // OpenCode takes a prompt string, so it never receives an image part — the
  // composer says so on the chip rather than letting the picture vanish.
  const [modelBackend, setModelBackend] = useState('');
  const approvalTimeoutMinutes = Math.min(
    60,
    Math.max(1, Math.floor(Number(agentDefaults?.approvalTimeoutMinutes) || 2)),
  );
  // Queue and Task List share one slot above the composer (tab-style): only
  // one list is open at a time. Off hides the rows only — the server still
  // holds queued prompts / tasks, so closing a tab can never drop them.
  const [queueExpanded, setQueueExpanded] = useState(true);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const messages = session?.messages || [];
  const busy = session?.status === 'busy' || session?.status === 'thinking';
  const live = session?.live;
  const liveToolKey = (live?.tools || []).map((t) => `${t.id}:${t.status}`).join('|');
  const livePartsKey = (live?.parts || [])
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
  const canQueue = hasDraft && busy && Boolean(session) && Boolean(onQueue);
  const canSend = hasPayload && !busy && Boolean(session) && !editingId;
  // Stop only exists while a turn is actually running for this session.
  const canStop = busy && Boolean(session) && Boolean(onStop);

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
    setModelChoice(next);
    commitPick({ model: next });
  }

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/kusa/models', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        // Each entry carries whether it can see images (GET /kusa/models
        // answers with { id, vision }) — the composer needs that BEFORE a
        // prompt is sent, so attaching a picture can warn instead of quietly
        // dropping it. The judgement is the agent loop's own (model-capabilities
        // .mjs), so the picker and the request can never disagree about what
        // actually reaches the model. Unknown stays null, never false: the loop
        // only drops a picture when it is CERTAIN the model is text-only.
        const records = (Array.isArray(body?.models) ? body.models : [])
          .map((entry) => {
            const id = (typeof entry === 'string' ? entry : entry?.id || entry?.model || '')?.trim();
            if (!id) return null;
            const vision = typeof entry === 'object' && typeof entry.vision === 'boolean'
              ? entry.vision
              : null;
            return { id, vision };
          })
          .filter(Boolean);
        const fallback = agentDefaults?.model || body?.default || '';
        setModelBackend(body?.backend === 'opencode' ? 'opencode' : 'native');
        setModels(records.length ? records : (fallback ? [{ id: fallback, vision: null }] : []));
      } catch {
        setModelBackend('');
        setModels(agentDefaults?.model ? [{ id: agentDefaults.model, vision: null }] : []);
      }
    };
    void load();
  }, []);

  // A single-model endpoint still gets a picker — it defaults to that model.
  const modelOptions = (models.length ? models : (modelChoice ? [{ id: modelChoice, vision: null }] : []))
    .map((record) => ({ id: record.id, label: record.id }));
  const activeModel = modelOptions.some((option) => option.id === modelChoice)
    ? modelChoice
    : (modelOptions[0]?.id || modelChoice);
  const composerOptions = {
    mode: agentMode,
    approvalMode: approvalRules,
    model: activeModel,
  };
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
    setAgentMode(initialComposerMode(sessionOptions, agentDefaults));
    setApprovalRules(initialComposerRule(sessionOptions, agentDefaults));
    setModelChoice(initialComposerModel(sessionOptions, agentDefaults));
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
   * One paperclip action, run the moment the user clicks it. The file chooser
   * is the operating system's own (showOpenFilePicker where the browser has it,
   * a file <input> where it does not) and the user answers it at their own
   * pace, so this runs async: the composer never blocks, and the chips appear
   * when the dialog answers. Nothing is invented here — a file the browser
   * cannot read keeps its name and a note saying so, a cancelled dialog adds
   * nothing, and an over-budget pick is refused rather than half-attached.
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
          if (!pasted) {
            note = 'the clipboard holds no image or text to take — a normal paste types into the composer instead';
          }
        }
      } catch {
        // A chooser the browser cannot open is simply no attachment: what the
        // user already staged stays on the message.
      }
      const already = added.filter((attachment) =>
        attachments.some((held) => held?.name === attachment.name && held?.size === attachment.size),
      );
      const { list, rejected } = stageAttachments(attachments, added);
      setAttachments(list);
      setAttachNote(
        rejected.length
          ? `not added — this message holds ${ATTACHMENT_LIMITS.files} files at most`
          : already.length
            ? 'already on this message — it is attached once'
            : note,
      );
    };
    void run();
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
      return;
    }
    onSend?.(session.key, text, { ...composerOptions, attachments: staged });
    setDraft('');
    setAttachments([]);
    setAttachNote('');
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={panelRef}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        {!messages.length && !busy ? (
          <div className="w-full flex flex-col items-start gap-3 pt-10">
            <p className="text-sm font-medium text-gray-200">New Kusă chat</p>
            <p className="text-sm leading-relaxed text-gray-500">
              Session <code className="font-mono text-gray-400">{shortId(session?.id)}</code>.
              Configure the OpenAI-compatible endpoint under Settings, then send a message.
              Thinking and tool calls appear inline like VS Code chat.
            </p>
          </div>
        ) : (
          <div className="w-full flex flex-col gap-6">
            {messages.map((msg) => (
              <ChatTurn
                key={msg.id}
                msg={msg}
                busy={busy}
                editing={editingId === msg.id}
                onStartEdit={() => setEditingId(msg.id)}
                onCancelEdit={() => setEditingId(null)}
                onResendEdit={(text) => {
                  if (!session || busy) return;
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
                }}
                agentMaxHeight={agentMaxHeight}
                onApproval={null}
                onAsk={null}
              />
            ))}
            {busy && live ? (
              <ChatTurn
                msg={{
                  id: 'live',
                  role: 'assistant',
                  text: live.text || '',
                  thinking: live.thinking || '',
                  tools: live.tools || [],
                  parts: live.parts || [],
                  streaming: true,
                }}
                agentMaxHeight={agentMaxHeight}
                onApproval={
                  onApproval
                    ? async (decision) => {
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
                    : null
                }
                onAsk={
                  onAsk
                    ? (decision) => onAsk(session.key, decision)
                    : null
                }
              />
            ) : busy ? (
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
       * Task List slot: the session's plan/todos, listed above the composer
       * like the queue is. Fixed sibling slot so the switch state survives
       * every frame; TaskStack renders nothing while its switch is off or
       * there are no tasks, so an idle slot stays empty.
       */}
      <TaskStack
        tasks={taskItems}
        expanded={tasksExpanded}
      />

      {/*
       * The queue belongs to the composer, not the transcript: it is the last
       * thing the message box produced, so it renders directly above the form
       * and each new card slides up out of that box (see .chat-queue-in).
       * Fixed sibling slot — the component instance (and its switch state)
       * survives every SSE frame while prompts are held. QueueStack renders
       * nothing while the switch is off, so this slot stays empty.
       */}
      <QueueStack
        held={heldQueue}
        steering={steeringQueue}
        sessionKey={session?.key}
        onQueue={onQueue}
        expanded={queueExpanded}
      />

      <form
        className="shrink-0 border-t border-gray-800/80 bg-gray-950/70 px-4 py-3 backdrop-blur sm:px-6"
        onSubmit={submit}
      >
        <div className="flex flex-wrap items-center gap-2 pb-1.5">
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
          <ComposerDropdown
            title="Model"
            options={modelOptions}
            value={activeModel}
            onSelect={selectComposerModel}
          />
          {/* Tab-style popup switches (PopupList.jsx): opening one closes the
              other so only a single list sits above the composer. */}
          <PopupToggle
            className="ml-auto"
            icon={QueueIcon}
            label="Prompt Queue"
            count={queueTotal}
            noun="held"
            pulseClass={promptBounceClass}
            expanded={queueExpanded}
            onToggle={() => {
              setQueueExpanded((open) => {
                const next = !open;
                if (next) setTasksExpanded(false);
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
                if (next) setQueueExpanded(false);
                return next;
              });
            }}
          />
        </div>
        <div className="w-full">
          <div
            className={`chat-composer rounded-2xl border bg-gray-900/90 shadow-sm transition-[border-color,box-shadow] ${
              busy
                ? 'border-gray-700'
                : 'border-gray-700 focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/30'
            }`}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                busy
                  ? 'Kusă is working… pressing Send holds this prompt in the queue'
                  : editingId
                    ? 'Finish or cancel the edit above…'
                    : 'Add a follow-up'
              }
              disabled={Boolean(editingId)}
              aria-label="Chat message"
              className="block max-h-[200px] min-h-[44px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-sm leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none disabled:opacity-50"
            />
            {/*
              * What is attached to THIS message, as chips under the input. The
              * chips are the same component the transcript renders, so a sent
              * message and the files that made it can never disagree — and a
              * chip states what will actually reach the model, not what was
              * intended.
              */}
            <AttachmentChips
              attachments={attachments}
              imagesReachModel={imagesReachModel}
              note={attachNote}
              className="flex flex-wrap items-center gap-1.5 px-3.5 pb-1"
            />
            <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-0.5">
              <p className="min-w-0 flex-1 truncate px-1 text-[11px] text-gray-600">
                {busy
                  ? 'Generating response… · pressing Send queues the prompt · Stop ends this run and sends the next queued prompt'
                  : editingId
                    ? 'Editing a previous message — resend replaces everything after it'
                    : (
                      <>
                        <kbd className="font-sans text-gray-500">Enter</kbd>
                        {' '}to send
                        <span className="mx-1.5 text-gray-700">·</span>
                        <kbd className="font-sans text-gray-500">Shift</kbd>
                        +
                        <kbd className="font-sans text-gray-500">Enter</kbd>
                        {' '}newline
                      </>
                    )}
              </p>
              <div className="flex shrink-0 items-center gap-0.5">
                <ContextRing used={estimateContextTokens(messages, live)} />
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
                {hasPayload && (busy || canSend) ? (
                  <button
                    type="submit"
                    disabled={!canSend && !canQueue}
                    title={busy ? 'Queue for this run' : 'Send'}
                    aria-label={busy ? 'Queue message' : 'Send'}
                    className={`chat-composer-action inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                      canSend || canQueue
                        ? (busy
                          ? 'bg-amber-600 text-white hover:bg-amber-500'
                          : 'bg-emerald-600 text-white hover:bg-emerald-500')
                        : 'bg-gray-800 text-gray-600'
                    } disabled:cursor-not-allowed`}
                  >
                    <ArrowUpIcon />
                  </button>
                ) : busy ? (
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
                ) : (
                  <button
                    type="button"
                    disabled
                    title="Live voice — not wired up yet"
                    aria-label="Live voice"
                    className="chat-composer-action inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-700 bg-gray-800/80 text-gray-400 disabled:cursor-not-allowed"
                  >
                    <VoiceIcon />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
