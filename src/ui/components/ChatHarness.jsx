import { useEffect, useMemo, useRef, useState } from 'react';
import { clock, shortId } from '../lib/format.js';
import { readLocal, writeLocal } from '../lib/storage.js';
import {
  AGENT_MODE_OPTIONS,
  RULE_OPTIONS,
  ruleOptions,
  AttachmentIcon,
  ComposerDropdown,
  ContextRing,
  DictateIcon,
  VoiceIcon,
} from './ComposerControls.jsx';
import { PopupList, PopupToggle } from './PopupList.jsx';
import { looksLikeMarkdown, MarkdownBody } from './MarkdownBody.jsx';

const COMPOSER_MODE_KEY = 'monitor.composerMode';
const COMPOSER_RULE_KEY = 'monitor.composerRule';
const COMPOSER_RULE_EXPIRES_KEY = 'monitor.composerRuleExpiresAt';
const COMPOSER_MODEL_KEY = 'monitor.composerModel';

function initialComposerMode(defaults) {
  const saved = readLocal(COMPOSER_MODE_KEY, '');
  if (AGENT_MODE_OPTIONS.some((option) => option.id === saved)) return saved;
  return defaults?.mode || 'agent';
}

function readRuleExpiresAt() {
  const n = Number(readLocal(COMPOSER_RULE_EXPIRES_KEY, 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function initialComposerRule(defaults) {
  const saved = readLocal(COMPOSER_RULE_KEY, '');
  if (RULE_OPTIONS.some((option) => option.id === saved)) {
    // Allow / Deny are temporary: without a future expiry they fall back to
    // ask-deny so a forgotten picker cannot leave tools permanently open.
    if (saved === 'allow' || saved === 'deny') {
      const expiresAt = readRuleExpiresAt();
      if (expiresAt > Date.now()) return saved;
      return 'ask-deny';
    }
    return saved;
  }
  const fallback = defaults?.rules || 'ask-deny';
  if (fallback === 'allow' || fallback === 'deny') return 'ask-deny';
  return fallback;
}

function initialRuleExpiresAt() {
  const saved = readLocal(COMPOSER_RULE_KEY, '');
  if (saved !== 'allow' && saved !== 'deny') return null;
  const expiresAt = readRuleExpiresAt();
  return expiresAt > Date.now() ? expiresAt : null;
}

function initialComposerModel(defaults) {
  const saved = readLocal(COMPOSER_MODEL_KEY, '');
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  return defaults?.model || '';
}

function formatRemainingMinutes(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins <= 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

// An agent block is height-capped to this share of the transcript panel while
// streaming; past the cap it clips (top/bottom vignette) instead of nesting a
// scrollbar. Show all grows the block into the transcript so only the chat
// panel scrolls. A pending approval stays clipped — the vignette viewport
// scrolls to the ask, and the chat panel scrolls that row on screen.
const AGENT_EXPAND_HEIGHT_RATIO = 0.6;
const THINKING_CLIP_PX = 192; // ~max-h-48
const TOOL_INPUT_CLIP_PX = 112; // ~max-h-28
const TOOL_OUTPUT_CLIP_PX = 144; // ~max-h-36
// Matches .chat-clip-vignette h-10 — keep Allow/Deny clear of the bottom fade.
const CLIP_VIGNETTE_PX = 40;

// Mirror of src/agent/approval.mjs APPROVAL_TIMEOUT_MS — only used when a live
// approval arrives without its own timeoutMs (older stream, partial frame).
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

// Mirror of src/agent/ask.mjs ASK_TIMEOUT_MS — same fallback rule: only used
// when a live question arrives without its own timeoutMs (older stream).
const DEFAULT_ASK_TIMEOUT_MS = 120_000;

// The queue belongs to the composer, so it must never push the transcript away:
// while the list is on it is height-capped, not item-capped — every queued
// prompt is listed and the stack scrolls inside its own box past this height.
// The toggle hides the whole list rather than thinning it, so auto-collapse
// past the cap switches a long queue off instead of shrinking its rows; the
// toolbar control still shows the count and turns the list back on.
const QUEUE_AUTO_COLLAPSE_AT = 3;
// Compact one-line rows; ~6–7 visible before the list scrolls.
const QUEUE_MAX_HEIGHT_PX = 168;
const QUEUE_PREVIEW_CHARS = 96;

// The Task List is the same control as the queue (see PopupList.jsx) with its
// own caps: task rows are taller than a one-line prompt, so the auto-hide
// threshold is lower and the box is sized for ~5 rows.
const TASK_AUTO_HIDE_AT = 6;
const TASK_MAX_HEIGHT_PX = 168;

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
  agentDefaults = null,
}) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  // 60% of the live transcript panel height, measured (not a CSS %) so the cap
  // tracks the real container even when the sidebar or window resizes.
  const [agentMaxHeight, setAgentMaxHeight] = useState(null);
  // Composer pickers (VS Code Copilot style): Ask/Plan/Agent, approval rules,
  // model. Last choice wins across refresh (localStorage); Settings fill in
  // only when nothing has been picked yet. Allow / Deny also store an expiry
  // so they auto-revert to ask-deny after the settings window.
  const [agentMode, setAgentMode] = useState(() => initialComposerMode(agentDefaults));
  const [approvalRules, setApprovalRules] = useState(() => initialComposerRule(agentDefaults));
  const [ruleExpiresAt, setRuleExpiresAt] = useState(() => initialRuleExpiresAt());
  const [ruleNow, setRuleNow] = useState(() => Date.now());
  const [modelChoice, setModelChoice] = useState(() => initialComposerModel(agentDefaults));
  const [models, setModels] = useState([]);
  const approvalTimeoutMinutes = Math.min(
    60,
    Math.max(1, Math.floor(Number(agentDefaults?.approvalTimeoutMinutes) || 2)),
  );
  const allowDenyRevertMinutes = Math.min(
    240,
    Math.max(1, Math.floor(Number(agentDefaults?.allowDenyRevertMinutes) || 15)),
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
  const canQueue = hasDraft && busy && Boolean(session) && Boolean(onQueue);
  const canSend = hasDraft && !busy && Boolean(session) && !editingId;
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

  useEffect(() => {
    writeLocal(COMPOSER_MODE_KEY, agentMode);
  }, [agentMode]);

  useEffect(() => {
    writeLocal(COMPOSER_RULE_KEY, approvalRules);
    if (ruleExpiresAt && (approvalRules === 'allow' || approvalRules === 'deny')) {
      writeLocal(COMPOSER_RULE_EXPIRES_KEY, String(ruleExpiresAt));
    } else {
      writeLocal(COMPOSER_RULE_EXPIRES_KEY, '');
    }
  }, [approvalRules, ruleExpiresAt]);

  // Allow / Deny are temporary auto-allow / auto-deny windows: when the
  // settings countdown ends, snap back to the safe ask-deny rule.
  useEffect(() => {
    if (!ruleExpiresAt || (approvalRules !== 'allow' && approvalRules !== 'deny')) return undefined;
    const remaining = ruleExpiresAt - Date.now();
    if (remaining <= 0) {
      setApprovalRules('ask-deny');
      setRuleExpiresAt(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setApprovalRules('ask-deny');
      setRuleExpiresAt(null);
    }, remaining);
    return () => clearTimeout(timer);
  }, [approvalRules, ruleExpiresAt]);

  useEffect(() => {
    if (!ruleExpiresAt || (approvalRules !== 'allow' && approvalRules !== 'deny')) return undefined;
    const tick = () => setRuleNow(Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [approvalRules, ruleExpiresAt]);

  function selectApprovalRule(next) {
    setApprovalRules(next);
    if (next === 'allow' || next === 'deny') {
      setRuleExpiresAt(Date.now() + allowDenyRevertMinutes * 60_000);
    } else {
      setRuleExpiresAt(null);
    }
  }

  useEffect(() => {
    if (modelChoice) writeLocal(COMPOSER_MODEL_KEY, modelChoice);
  }, [modelChoice]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/kusa/models', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const list = (Array.isArray(body?.models) ? body.models : [])
          .map((entry) => (typeof entry === 'string' ? entry : entry?.id || entry?.model || '')?.trim())
          .filter(Boolean);
        const fallback = agentDefaults?.model || body?.default || '';
        setModels(list.length ? list : (fallback ? [fallback] : []));
      } catch {
        setModels(agentDefaults?.model ? [agentDefaults.model] : []);
      }
    };
    void load();
  }, []);

  // A single-model endpoint still gets a picker — it defaults to that model.
  const modelOptions = (models.length ? models : (modelChoice ? [modelChoice] : []))
    .map((id) => ({ id, label: id }));
  const activeModel = modelOptions.some((option) => option.id === modelChoice)
    ? modelChoice
    : (modelOptions[0]?.id || modelChoice);
  const composerOptions = {
    mode: agentMode,
    approvalMode: approvalRules,
    model: activeModel,
  };
  const rulePickerOptions = useMemo(() => {
    const base = ruleOptions({
      approvalTimeoutMinutes,
      allowDenyRevertMinutes,
    });
    if (!ruleExpiresAt || (approvalRules !== 'allow' && approvalRules !== 'deny')) return base;
    const left = formatRemainingMinutes(ruleExpiresAt - ruleNow);
    return base.map((option) => {
      if (option.id !== approvalRules) return option;
      return { ...option, label: `${option.label} · ${left}` };
    });
  }, [
    approvalRules,
    approvalTimeoutMinutes,
    allowDenyRevertMinutes,
    ruleExpiresAt,
    ruleNow,
  ]);

  useEffect(() => {
    if (busy) setEditingId(null);
  }, [busy]);

  // While a turn is running, Mode / Rules changes must reach the server so the
  // agent loop can apply them at the next step boundary — not only on the next
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, session?.key, busy, live?.text, live?.thinking, liveToolKey, livePartsKey]);

  // Declared after the scroll-to-bottom above, so on the frame where an approval
  // appears this one wins: Allow/Deny must be ON screen and clickable. The live
  // agent block stays in vignette (clipped) while an ask is pending —
  // ClippedGrow scrolls the CTA clear of its bottom fade, and this scroll
  // brings that CTA into the chat panel. The row stays in transcript flow.
  useEffect(() => {
    const row =
      document.querySelector('[data-kusa-approval-cta]')
      || document.querySelector('[data-kusa-approval="pending"]');
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [livePartsKey]);

  useEffect(() => {
    setDraft('');
    setEditingId(null);
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

  function submit(event) {
    event?.preventDefault?.();
    const text = draft.trim();
    if (!text || !session) return;
    if (busy) {
      // The agent is mid-turn: do not start a second, competing turn. Hold the
      // prompt (Cursor/Copilot queue) — "Send now" on the card below injects it
      // into this run instead.
      if (!onQueue) return;
      void onQueue(session.key, 'enqueue', { text, options: composerOptions });
      setDraft('');
      return;
    }
    onSend?.(session.key, text, composerOptions);
    setDraft('');
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
                  onSend?.(session.key, text, { ...composerOptions, editMessageId: msg.id });
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
                    ? (decision) => onApproval(session.key, decision)
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
            onSelect={setAgentMode}
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
            onSelect={setModelChoice}
          />
          {/* Tab-style popup switches (PopupList.jsx): opening one closes the
              other so only a single list sits above the composer. */}
          <PopupToggle
            className="ml-auto"
            icon={QueueIcon}
            label="Prompt Queue"
            count={queueTotal}
            noun="held"
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
            countClassName="text-emerald-300/90"
            activeClassName="bg-emerald-500/15 text-emerald-300"
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
                <button
                  type="button"
                  disabled
                  title="Attach files — not wired up yet"
                  aria-label="Attach files"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 disabled:cursor-not-allowed"
                >
                  <AttachmentIcon />
                </button>
                <button
                  type="button"
                  disabled
                  title="Dictate — not wired up yet"
                  aria-label="Dictate message"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 disabled:cursor-not-allowed"
                >
                  <DictateIcon />
                </button>
                {hasDraft && (busy || canSend) ? (
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
                ) : hasDraft ? (
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

/**
 * Held prompts stacked above the composer — rendered only while the composer
 * toolbar's Prompt Queue switch is on. Off, this returns nothing at all: no
 * header line, no rows, no empty scroll box. The switch itself still carries
 * the count, so a hidden queue stays discoverable without a persistent list
 * above the message box. Hiding changes nothing about the prompts — the server
 * still holds them and the end-of-run flush still sends them — so the switch
 * can never silently drop a queued message.
 *
 * On, every queued message is listed (nothing is hidden behind a "+N more"
 * count) and the stack is height-capped instead, so a long queue scrolls
 * inside its own box and never pushes the transcript up. Order is the server's
 * (oldest first): the top row is what gets sent next, the bottom row is the
 * one closest to the message box it slid up from. A parked (paused) row keeps
 * that order and its key, and is only skipped by the flush.
 */
/** Thin line between queue rows — the drop target lives in the gap, not on a row. */
function QueueGap({ active = false }) {
  // Fixed-height slot between rows so the indicator sits in the space, not on a card.
  return (
    <div className="flex h-2 items-center px-1" aria-hidden="true">
      {active ? (
        <div className="h-0.5 w-full rounded-full bg-emerald-400 shadow-[0_0_0_1px_rgba(52,211,153,0.25)]" />
      ) : (
        <div className="h-px w-full bg-gray-800/90" />
      )}
    </div>
  );
}

function QueueStack({ held, steering, sessionKey, onQueue, expanded = true }) {
  const [dragId, setDragId] = useState(null);
  // Insert slot: `{ beforeId }` (null beforeId = append after the last held row).
  const [dropGap, setDropGap] = useState(null);
  // Optimistic order while a drag is in flight / until the server snapshot lands.
  const [orderIds, setOrderIds] = useState(null);
  const heldKey = held.map((entry) => `${entry?.id}:${entry?.paused ? 1 : 0}`).join('|');

  useEffect(() => {
    setOrderIds(null);
    setDragId(null);
    setDropGap(null);
  }, [heldKey]);

  const displayHeld = useMemo(() => {
    if (!orderIds?.length) return held;
    const byId = new Map(held.map((entry) => [entry.id, entry]));
    const ordered = orderIds.map((id) => byId.get(id)).filter(Boolean);
    // Append any brand-new rows the optimistic list does not know about yet.
    for (const entry of held) {
      if (!orderIds.includes(entry.id)) ordered.push(entry);
    }
    return ordered;
  }, [held, orderIds]);

  const total = displayHeld.length + steering.length;
  if (!total || !expanded) return null;
  const parked = displayHeld.filter((entry) => entry?.paused).length;
  // Only session-bound held rows reorder; parked are workspace-shared and stay
  // at the end of the snapshot in parked order.
  const canReorder = displayHeld.filter((entry) => !entry?.paused).length > 1;

  function gapFromHover(entryId, edge) {
    // edge: 'before' | 'after' — normalize to a single insert-before slot.
    if (edge === 'before') return { beforeId: entryId };
    const idx = displayHeld.findIndex((entry) => entry.id === entryId);
    const next = idx >= 0 ? displayHeld[idx + 1] : null;
    return { beforeId: next ? next.id : null };
  }

  function gapIsNoop(fromId, gap) {
    if (!fromId || !gap) return true;
    const ids = displayHeld.map((entry) => entry.id);
    const from = ids.indexOf(fromId);
    if (from < 0) return true;
    const without = ids.filter((id) => id !== fromId);
    const insertAt = gap.beforeId == null
      ? without.length
      : without.indexOf(gap.beforeId);
    if (insertAt < 0) return true;
    return insertAt === from;
  }

  function moveHeldToGap(fromId, gap) {
    if (!fromId || !gap || !onQueue || gapIsNoop(fromId, gap)) return;
    const fromEntry = displayHeld.find((entry) => entry.id === fromId);
    if (fromEntry?.paused) return;
    // Reorder only unparked (session-bound) ids; parked stay after them.
    const heldIds = displayHeld.filter((entry) => !entry?.paused).map((entry) => entry.id);
    if (!heldIds.includes(fromId)) return;
    const without = heldIds.filter((id) => id !== fromId);
    let insertAt = without.length;
    if (gap.beforeId != null) {
      const beforeHeld = without.indexOf(gap.beforeId);
      if (beforeHeld >= 0) insertAt = beforeHeld;
      else if (displayHeld.some((entry) => entry.id === gap.beforeId && entry?.paused)) {
        // Dropping before a parked row → append at end of held.
        insertAt = without.length;
      } else {
        return;
      }
    }
    const next = without.slice();
    next.splice(insertAt, 0, fromId);
    const parkedIds = displayHeld.filter((entry) => entry?.paused).map((entry) => entry.id);
    setOrderIds([...next, ...parkedIds]);
    void onQueue(sessionKey, 'reorder', { ids: next });
  }

  const showGap = Boolean(dragId && dropGap && !gapIsNoop(dragId, dropGap));
  // The summary line is plain text, so it is built as a string and handed to
  // PopupList, which owns the box, the cap and the off/empty guard.
  const summary = [
    `${total} queued`,
    parked ? ` · ${parked} parked` : '',
    steering.length ? ` · ${steering.length} send now` : '',
    canReorder ? ' · drag to reorder' : '',
  ].join('');

  return (
    <PopupList
      expanded={expanded}
      count={total}
      maxHeightPx={QUEUE_MAX_HEIGHT_PX}
      summary={summary}
      ariaLabel="Queued prompts"
    >
        {showGap && dropGap.beforeId === displayHeld[0]?.id ? <QueueGap active /> : null}
        {displayHeld.map((entry, index) => (
          <div key={entry.id}>
            <QueuedPromptCard
              entry={entry}
              sessionKey={sessionKey}
              onQueue={onQueue}
              steering={false}
              draggable={canReorder && !entry?.paused}
              dragging={dragId === entry.id}
              onDragBegin={(id) => setDragId(id)}
              onDragHover={(id, edge) => setDropGap(gapFromHover(id, edge))}
              onDragEnd={() => {
                setDragId(null);
                setDropGap(null);
              }}
              onDropGap={(id, edge) => {
                if (dragId) moveHeldToGap(dragId, gapFromHover(id, edge));
                setDragId(null);
                setDropGap(null);
              }}
            />
            {index < displayHeld.length - 1 ? (
              <QueueGap
                active={
                  showGap && dropGap.beforeId === displayHeld[index + 1]?.id
                }
              />
            ) : null}
          </div>
        ))}
        {showGap && dropGap.beforeId == null ? <QueueGap active /> : null}
        {steering.map((entry) => (
          <QueuedPromptCard
            key={entry.id}
            entry={entry}
            sessionKey={sessionKey}
            onQueue={onQueue}
            steering
          />
        ))}
    </PopupList>
  );
}

/**
 * Task List — the same popup control as the queue (PopupToggle + PopupList),
 * over the plan/todo snapshot this lane already carries. Rows are read-only on
 * the chat surface: the tasks are written by the agent's plan tools and by the
 * harness hooks, so the composer lists and bounds them but never edits them —
 * which is why there is no row action bar here, only a status mark and a tag.
 * Off or empty renders nothing, and a long list scrolls inside the cap rather
 * than pushing the composer down.
 */
function TaskStack({ tasks, expanded = true }) {
  const total = tasks.length;
  if (!total || !expanded) return null;
  const done = tasks.filter((task) => task?.status === 'completed').length;
  const doing = tasks.filter((task) => task?.status === 'in_progress').length;
  const cancelled = tasks.filter((task) => task?.status === 'cancelled').length;
  const summary = [
    `${total} task${total === 1 ? '' : 's'}`,
    doing ? ` · ${doing} in progress` : '',
    done ? ` · ${done} done` : '',
    cancelled ? ` · ${cancelled} cancelled` : '',
  ].join('');

  return (
    <PopupList
      expanded={expanded}
      count={total}
      maxHeightPx={TASK_MAX_HEIGHT_PX}
      summary={summary}
      ariaLabel="Session task list"
    >
      {tasks.map((task, index) => (
        <TaskRow key={task?.id || `task-${index}`} task={task} index={index} />
      ))}
    </PopupList>
  );
}

// Task rows reuse the plan vocabulary the Prompts panel already draws (✓ done,
// ● in progress, – cancelled, ○ pending) so a task reads identically in both
// surfaces; colour carries the state, the tag only names it in one word.
const TASK_MARK = {
  completed: <span className="text-emerald-400" aria-hidden="true">✓</span>,
  in_progress: <span className="text-amber-400" aria-hidden="true">●</span>,
  cancelled: <span className="text-gray-600" aria-hidden="true">–</span>,
  pending: <span className="text-gray-700" aria-hidden="true">○</span>,
};
const TASK_STATUS = {
  completed: 'completed',
  in_progress: 'in_progress',
  cancelled: 'cancelled',
};
const TASK_LABEL = {
  completed: 'done',
  in_progress: 'doing',
  cancelled: 'skipped',
  pending: 'open',
};
const TASK_TONE = {
  completed: 'text-emerald-300/80',
  in_progress: 'text-amber-300/80',
  cancelled: 'text-gray-600',
  pending: 'text-gray-600',
};
const TASK_BODY = {
  completed: 'text-gray-500 line-through',
  in_progress: 'text-gray-200',
  cancelled: 'text-gray-600 line-through',
  pending: 'text-gray-300',
};
const TASK_PREVIEW_CHARS = 120;

/**
 * One task row: ordinal, status mark, the task text, and a one-word status tag
 * flushed right. Same row rhythm as a queued prompt (h-7, mark column,
 * truncated body, right-aligned tag) so the two lists read as one vocabulary.
 * There is no action bar: the chat surface lists tasks but never edits them.
 */
function TaskRow({ task, index = 0 }) {
  const content = String(task?.content || '').trim();
  const status = TASK_STATUS[task?.status] || 'pending';
  return (
    <div
      role="listitem"
      title={content}
      className="flex h-7 items-center gap-1.5 px-1 hover:bg-gray-900/40"
    >
      <span className="shrink-0 tabular-nums text-[9px] text-gray-600">{index + 1}</span>
      <span className="ml-1.5 shrink-0">{TASK_MARK[status]}</span>
      <p
        className={`min-w-0 flex-1 truncate text-[12px] leading-none ${TASK_BODY[status]}`}
      >
        {previewLine(content, TASK_PREVIEW_CHARS)}
      </p>
      <span
        className={`ml-auto shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide ${TASK_TONE[status]}`}
      >
        {TASK_LABEL[status]}
      </span>
    </div>
  );
}

/**
 * One held prompt. "Send now" moves it into the running turn (the loop injects
 * it at its next step boundary); "Edit" rewrites the held text in place — same
 * id, same position, same carried options — so the user can fix a prompt before
 * it is sent; "Remove" takes it out of the queued list. The server owns the
 * list, so every action just calls the queue endpoint and the next snapshot
 * re-renders this block.
 *
 * Actions are icon buttons flushed to the right edge of the card — the label
 * stays in title/aria-label so the row keeps its meaning without words. The
 * pencil is offered on every row: the list is either fully shown or not shown
 * at all, so there is no thinned row that has to drop it. In edit mode the
 * card body becomes a textarea seeded with the held
 * prompt, so the rewrite happens in place rather than by resending it.
 */
function QueuedPromptCard({
  entry,
  sessionKey,
  onQueue,
  steering = false,
  draggable = false,
  dragging = false,
  onDragBegin = null,
  onDragHover = null,
  onDragEnd = null,
  onDropGap = null,
}) {
  const serverText = String(entry?.text || '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(serverText);
  const editRef = useRef(null);
  const rowRef = useRef(null);
  const canDrag = draggable && !editing && !steering && Boolean(entry?.id);

  function edgeFromEvent(event) {
    const el = rowRef.current;
    if (!el) return 'before';
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    return event.clientY < mid ? 'before' : 'after';
  }

  // The server owns the text, so the draft is re-seeded from it whenever the
  // held prompt changes or edit mode is entered; typing then only moves the
  // draft, and a saved edit re-seeds from the new server text.
  useEffect(() => {
    setDraft(serverText);
  }, [editing, serverText]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => editRef.current?.focus());
  }, [editing]);

  useEffect(() => {
    const el = editRef.current;
    if (!el || !editing) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 32), 120)}px`;
  }, [draft, editing]);

  const actions = [];
  if (!steering && !editing && onQueue && entry?.id) {
    actions.push({
      key: 'send',
      label: 'Send now',
      icon: ArrowUpIcon,
      tone: 'bg-emerald-600 text-white hover:bg-emerald-500',
      onClick: () => onQueue?.(sessionKey, 'send', { id: entry?.id }),
    });
    actions.push({
      key: 'edit',
      label: 'Edit this prompt',
      icon: EditIcon,
      tone: 'border border-gray-600 text-gray-300 hover:border-gray-400 hover:text-gray-100',
      onClick: () => setEditing(true),
    });
    // Park / un-park this one row: the server keeps the entry in place (same
    // id, same slot, same carried options) and only flags it, so the end-of-run
    // flush skips it while it stays visible in the stack. Pressing it again
    // puts it back in line — the row never leaves the queue, so nothing is lost.
    actions.push(
      entry?.paused
        ? {
            key: 'resume',
            label: 'Resume — send this when the run ends',
            icon: ResumeIcon,
            tone: 'border border-amber-500/70 text-amber-300 hover:border-amber-400 hover:text-amber-100',
            onClick: () => onQueue?.(sessionKey, 'resume', { id: entry?.id }),
          }
        : {
            key: 'pause',
            label: 'Pause this prompt — skip it when the run ends',
            icon: PauseIcon,
            tone: 'border border-gray-600 text-gray-300 hover:border-gray-400 hover:text-gray-100',
            onClick: () => onQueue?.(sessionKey, 'pause', { id: entry?.id }),
          },
    );
    actions.push({
      key: 'remove',
      label: 'Remove',
      icon: TrashIcon,
      tone: 'border border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-100',
      onClick: () => onQueue?.(sessionKey, 'remove', { id: entry?.id }),
    });
  }
  const paused = Boolean(entry?.paused) && !steering;
  // Lane tag is held/now only; parked is a compact inline badge so it does not
  // steal a column or add a second line.
  const stateTag = steering ? 'now' : 'held';
  const tagTone = steering ? 'text-gray-500' : 'text-amber-300/80';
  const preview = previewLine(serverText, QUEUE_PREVIEW_CHARS);
  const iconButtons = (
    <div className={`flex shrink-0 items-center gap-0.5 ${paused ? 'text-gray-500' : ''}`}>
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          title={action.label}
          aria-label={action.label}
          onClick={action.onClick}
          className={`inline-flex h-5 w-5 items-center justify-center rounded transition-colors ${action.tone}`}
        >
          <action.icon />
        </button>
      ))}
    </div>
  );

  function saveEdit(event) {
    event?.preventDefault?.();
    const next = draft.trim();
    if (!next) return;
    // The server rewrites the held text in place and returns the snapshot, so
    // this card re-renders with the new prompt under the same key.
    onQueue?.(sessionKey, 'edit', { id: entry?.id, text: next });
    setEditing(false);
  }

  if (editing) {
    return (
      <div
        role="listitem"
        className="chat-queue-in px-1 py-1.5 bg-gray-900/50"
      >
        <textarea
          ref={editRef}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(false);
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              saveEdit(event);
            }
          }}
          aria-label="Edit queued prompt"
          className="block max-h-[120px] min-h-[32px] w-full resize-none bg-transparent text-[12px] leading-snug text-gray-100 focus:outline-none"
        />
        <div className="mt-1 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-800 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={saveEdit}
            title="Save this queued prompt"
            aria-label="Save this queued prompt"
            className="inline-flex h-5 w-5 items-center justify-center rounded transition-colors bg-amber-600 text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <EditIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      role="listitem"
      title={serverText}
      onDragOver={(event) => {
        if (steering || !draggable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragHover?.(entry.id, edgeFromEvent(event));
      }}
      onDrop={(event) => {
        if (steering || !draggable) return;
        event.preventDefault();
        onDropGap?.(entry.id, edgeFromEvent(event));
      }}
      className={`chat-queue-in flex h-7 items-center gap-1.5 px-1 ${
        dragging ? 'opacity-40' : 'hover:bg-gray-900/40'
      }`}
    >
      {canDrag ? (
        <span
          draggable
          title="Drag to reorder"
          aria-label="Drag to reorder"
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', entry.id);
            onDragBegin?.(entry.id);
          }}
          onDragEnd={() => onDragEnd?.()}
          className="shrink-0 cursor-grab text-gray-600 active:cursor-grabbing"
        >
          <DragHandleIcon />
        </span>
      ) : null}
      <span className={`w-8 shrink-0 text-[9px] uppercase tracking-wide ${tagTone}`}>{stateTag}</span>
      <p className={`min-w-0 flex-1 truncate text-[12px] leading-none ${paused ? 'text-gray-500' : 'text-gray-300'}`}>
        {preview}
      </p>
      {paused ? (
        <span className="shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide text-amber-300/90 bg-amber-950/50 ring-1 ring-amber-700/40">
          parked
        </span>
      ) : null}
      {iconButtons}
    </div>
  );
}

/**
 * Rough context-window estimate for the composer meter (~4 chars per token).
 * The endpoint reports no usage, so this is an estimate of what a turn would
 * send: the transcript plus whatever is streaming now.
 */
function estimateContextTokens(messages, live) {
  let chars = 0;
  for (const msg of messages) {
    chars += String(msg?.text || msg?.content || '').length;
  }
  chars += String(live?.text || '').length + String(live?.thinking || '').length;
  for (const part of live?.parts || []) {
    chars += String(part?.text || '').length;
    chars += JSON.stringify(part?.args || {}).length;
  }
  return Math.round(chars / 4);
}

function UserMessage({ msg, busy, editing, onStartEdit, onCancelEdit, onResendEdit }) {
  const [text, setText] = useState(msg.text || '');
  const editRef = useRef(null);

  useEffect(() => {
    if (editing) {
      setText(msg.text || '');
      requestAnimationFrame(() => {
        const el = editRef.current;
        if (!el) return;
        el.focus();
        el.style.height = 'auto';
        el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 240)}px`;
        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    }
  }, [editing, msg.text]);

  useEffect(() => {
    const el = editRef.current;
    if (!el || !editing) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 240)}px`;
  }, [text, editing]);

  function submitEdit(event) {
    event?.preventDefault?.();
    const next = text.trim();
    if (!next || busy) return;
    onResendEdit?.(next);
  }

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-2 shadow-sm">
          <textarea
            ref={editRef}
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancelEdit?.();
              } else if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitEdit();
              }
            }}
            aria-label="Edit message"
            className="block max-h-[240px] min-h-[44px] w-full resize-none bg-transparent px-2 pt-1.5 pb-1 text-sm leading-relaxed text-gray-100 focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2 px-1 pb-0.5 pt-1">
            <button
              type="button"
              onClick={() => onCancelEdit?.()}
              className="rounded-md px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!text.trim() || busy}
              onClick={submitEdit}
              title="Resend from here"
              aria-label="Resend from here"
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group/user flex justify-end">
      <div className="relative max-w-[85%]">
        <div className="rounded-lg bg-emerald-500/15 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-gray-100">
          {msg.text}
        </div>
        {!busy ? (
          <button
            type="button"
            title="Edit message"
            aria-label="Edit message"
            onClick={() => onStartEdit?.()}
            className="absolute -bottom-3 -left-1 inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-gray-400 opacity-0 shadow-sm transition-opacity hover:border-gray-600 hover:text-gray-200 group-hover/user:opacity-100 focus:opacity-100"
          >
            <EditIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EditIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.5 2.5 13.5 4.5 5.5 12.5H3.5v-2z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12.5V3.5M8 3.5 4.5 7M8 3.5 11.5 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.5 4.5h9M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4.5l.5 8h5l.5-8"
      />
    </svg>
  );
}

/**
 * Parked prompt (pause bars): the row is skipped by the end-of-run flush, not
 * deleted — so it keeps the media-control meaning of "hold this one back".
 */
function PauseIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M5.75 3.75v8.5M10.25 3.75v8.5" />
    </svg>
  );
}

/** Un-parked prompt (bar + play triangle): it is back in line to be sent. */
function ResumeIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 3.5v9M7.5 3.5 12.5 8 7.5 12.5z" />
    </svg>
  );
}

/** Six-dot grip for queue drag-and-drop. */
function DragHandleIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="4" r="1" />
      <circle cx="10.5" cy="4" r="1" />
      <circle cx="5.5" cy="8" r="1" />
      <circle cx="10.5" cy="8" r="1" />
      <circle cx="5.5" cy="12" r="1" />
      <circle cx="10.5" cy="12" r="1" />
    </svg>
  );
}

function ChatTurn({ msg, busy, editing, onStartEdit, onCancelEdit, onResendEdit, agentMaxHeight = null, onApproval = null, onAsk = null }) {
  if (msg.role === 'user') {
    return (
      <UserMessage
        msg={msg}
        busy={busy}
        editing={editing}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onResendEdit={onResendEdit}
      />
    );
  }

  return <AssistantTurn msg={msg} agentMaxHeight={agentMaxHeight} onApproval={onApproval} onAsk={onAsk} />;
}

/**
 * Height-capped region with no nested scrollbar. Content clips; while
 * `follow` is on the viewport pins to the bottom (programmatic scrollTop).
 * A pending approval inside the clip wins over follow: scrollTop moves so the
 * Allow/Deny CTA clears the bottom fade (vignette stays on; bottom edge is
 * suppressed while the ask is pinned). Show all / Show less toggles growth
 * into the parent transcript scroll.
 */
function ClippedGrow({
  maxHeightPx = null,
  follow = false,
  followKey = '',
  className = '',
  children,
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [approvalCtaPinned, setApprovalCtaPinned] = useState(false);
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const cap = Number.isFinite(maxHeightPx) && maxHeightPx > 0 ? maxHeightPx : null;
  const grown = !cap || expanded;

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !cap) {
      setOverflows(false);
      return undefined;
    }
    const measure = () => {
      setOverflows(content.scrollHeight > cap + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    return () => ro.disconnect();
  }, [cap, followKey, grown]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || grown || !cap) {
      setApprovalCtaPinned(false);
      return;
    }
    // overflow:hidden still accepts scrollTop. Prefer a pending approval CTA
    // so Allow/Deny stay clear of the bottom fade and remain clickable; else
    // pin to latest while following, or show the start of the clipped region.
    const approval = content?.querySelector('[data-kusa-approval="pending"]');
    if (approval) {
      const cta = approval.querySelector('[data-kusa-approval-cta]') || approval;
      const clearBottom = viewport.getBoundingClientRect().bottom - CLIP_VIGNETTE_PX;
      viewport.scrollTop += cta.getBoundingClientRect().bottom - clearBottom;
      setApprovalCtaPinned(true);
      return;
    }
    setApprovalCtaPinned(false);
    viewport.scrollTop = follow ? viewport.scrollHeight : 0;
  }, [follow, followKey, grown, cap, overflows]);

  const showVignette = Boolean(!grown && overflows);
  const showToggle = Boolean(overflows && (showVignette || (grown && expanded)));

  return (
    <div className={className}>
      <div className="relative">
        <div
          ref={viewportRef}
          className={grown ? undefined : 'overflow-hidden'}
          style={grown || !cap ? undefined : { maxHeight: cap }}
        >
          <div ref={contentRef}>{children}</div>
        </div>
        {showVignette ? (
          <>
            <div
              data-edge="top"
              className="chat-clip-vignette absolute inset-x-0 top-0 h-10"
              aria-hidden="true"
            />
            {/* Bottom fade would wash out Allow/Deny while the ask is pinned. */}
            {!approvalCtaPinned ? (
              <div
                data-edge="bottom"
                className="chat-clip-vignette absolute inset-x-0 bottom-0 h-10"
                aria-hidden="true"
              />
            ) : null}
          </>
        ) : null}
      </div>
      {showToggle ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-gray-600 hover:text-gray-400"
          aria-expanded={grown}
        >
          {grown ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One assistant turn as a collapsible parent: collapsed transcript stays
 * user / agent / user / agent; expand for thoughts, tools, and full reply.
 */
function AssistantTurn({ msg, onApproval = null, onAsk = null, agentMaxHeight = null }) {
  const streaming = Boolean(msg.streaming);
  const parts = assistantParts(msg);
  const groups = groupAssistantParts(parts);
  const hasProgress = parts.length > 0 || (streaming && !msg.text);
  const lastPart = parts[parts.length - 1];
  const thinkingStream = Boolean(
    streaming && !msg.text && (lastPart?.type === 'thinking' || !parts.length),
  );
  const awaitingApproval = parts.some(
    (p) => p.type === 'approval' && p.approval?.status === 'pending',
  );
  const awaitingAnswer = parts.some(
    (p) => p.type === 'ask' && p.ask?.status === 'pending',
  );
  const replyText = typeof msg.text === 'string' ? msg.text : '';
  const hasReply = Boolean(replyText && replyText !== '(empty response)');
  const [open, setOpen] = useState(true);
  const followKey = [
    parts.length,
    replyText.length,
    groups.map((g) => {
      if (g.type === 'thinking') return `t:${(g.text || '').length}`;
      if (g.type === 'approval') return `a:${g.approval?.id}:${g.approval?.status}`;
      if (g.type === 'ask') return `q:${g.ask?.id}:${g.ask?.status}:${g.ask?.answer?.selected ?? ''}`;
      if (g.type === 'tool_group') {
        return (g.tools || []).map((t) => `${t.id}:${t.status}`).join(',');
      }
      return '';
    }).join('|'),
  ].join('/');

  useEffect(() => {
    if (streaming) setOpen(true);
    else setOpen(false);
  }, [streaming]);

  const toolCount = groups.reduce(
    (n, g) => (g.type === 'tool_group' ? n + g.tools.length : n),
    0,
  );
  const thoughtCount = groups.filter((g) => g.type === 'thinking').length;
  const approvalCount = groups.filter((g) => g.type === 'approval').length;
  const questionCount = groups.filter((g) => g.type === 'ask').length;
  const stepBits = [];
  if (thoughtCount) stepBits.push(thoughtCount === 1 ? '1 thought' : `${thoughtCount} thoughts`);
  if (toolCount) stepBits.push(toolCount === 1 ? '1 tool' : `${toolCount} tools`);
  if (approvalCount) stepBits.push(approvalCount === 1 ? '1 approval' : `${approvalCount} approvals`);
  if (questionCount) stepBits.push(questionCount === 1 ? '1 question' : `${questionCount} questions`);
  const stepSummary = stepBits.join(' · ');

  // The user pressed Stop: the partial reply is kept but labelled, so it is
  // never read as a finished answer.
  const stopped = Boolean(msg.stopped);
  const label = streaming
    ? (awaitingApproval
      ? 'Awaiting approval…'
      : awaitingAnswer
        ? 'Awaiting your answer…'
        : hasReply
        ? 'Agent…'
        : hasProgress
          ? 'Working…'
          : 'Thinking…')
    : stopped
      ? 'Stopped'
      : 'Agent';

  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group sticky top-0 z-[1] flex w-full max-w-full items-start gap-1.5 rounded bg-gray-950/90 px-0.5 py-0.5 text-left backdrop-blur hover:bg-gray-900/60"
        aria-expanded={open}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
        <AgentIcon className={`mt-0.5 ${streaming ? 'text-gray-400' : 'text-gray-500 group-hover:text-gray-400'}`} />
        {streaming ? (
          <StatusGlyph
            status={awaitingApproval ? 'awaiting_approval' : awaitingAnswer ? 'awaiting_answer' : 'running'}
            className="mt-0.5"
          />
        ) : null}
        <span className={`min-w-0 truncate ${streaming ? 'chat-shimmer text-gray-300' : 'text-gray-300'}`}>
          <span className="font-medium">{label}</span>
          {!streaming && stepSummary ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> {stepSummary}
            </span>
          ) : null}
          {!streaming && stopped ? (
            <span className="ml-1.5 shrink-0 text-rose-400">stopped by you</span>
          ) : null}
        </span>
      </button>

      {!open && hasReply ? (
        <p className="mt-0.5 line-clamp-3 border-l border-transparent pl-3 ml-1 text-[13px] leading-relaxed text-gray-400">
          {previewLine(replyText, 220)}
        </p>
      ) : null}

      {open ? (
        <ClippedGrow
          maxHeightPx={agentMaxHeight}
          follow={streaming}
          followKey={followKey}
          className="mt-1.5 ml-1 border-l border-gray-800 pl-3"
        >
          <div className="flex flex-col gap-2.5">
            {hasProgress ? (
              <div className="flex flex-col gap-1">
                {groups.map((group, index) => {
                  if (group.type === 'thinking') {
                    const isLastThinking = thinkingStream && group.lastInParts;
                    return (
                      <ThinkingBlock
                        key={`thinking-${index}`}
                        text={group.text || ''}
                        streaming={isLastThinking}
                      />
                    );
                  }
                  if (group.type === 'tool_group') {
                    const tools = group.tools;
                    if (tools.length === 1) {
                      return (
                        <ToolCallRow
                          key={tools[0].id || `tool-${index}`}
                          tool={tools[0]}
                        />
                      );
                    }
                    return (
                      <ToolGroupBlock
                        key={`tools-${tools[0]?.id || index}`}
                        tools={tools}
                      />
                    );
                  }
                  if (group.type === 'approval') {
                    return (
                      <ApprovalBlock
                        key={`approval-${group.approval?.id || index}`}
                        approval={group.approval}
                        onApproval={onApproval}
                      />
                    );
                  }
                  if (group.type === 'ask') {
                    return (
                      <AskBlock
                        key={`ask-${group.ask?.id || index}`}
                        ask={group.ask}
                        onAsk={onAsk}
                      />
                    );
                  }
                  return null;
                })}
                {thinkingStream && lastPart?.type !== 'thinking' && lastPart?.type !== 'approval' && lastPart?.type !== 'ask' ? (
                  <ThinkingBlock text="" streaming />
                ) : null}
              </div>
            ) : null}

            {hasReply ? (
              looksLikeMarkdown(replyText) || streaming ? (
                <MarkdownBody text={replyText} variant="chat" />
              ) : (
                <div className="text-sm leading-relaxed whitespace-pre-wrap text-gray-200">
                  {replyText}
                </div>
              )
            ) : streaming || hasProgress ? (
              streaming ? null : (
                <p className="text-sm text-gray-500">
                  No visible reply — expand thinking or tool rows above.
                </p>
              )
            ) : (
              <p className="text-sm text-gray-500">(empty response)</p>
            )}
          </div>
        </ClippedGrow>
      ) : null}
    </div>
  );
}

/** Interleaved timeline; fall back to legacy thinking-then-tools shape. */
function assistantParts(msg) {
  if (Array.isArray(msg.parts) && msg.parts.length) return msg.parts;
  const parts = [];
  if (typeof msg.thinking === 'string' && msg.thinking.trim()) {
    parts.push({ type: 'thinking', text: msg.thinking });
  }
  for (const tool of Array.isArray(msg.tools) ? msg.tools : []) {
    parts.push({ type: 'tool', tool });
  }
  return parts;
}

/** Collapse consecutive tool parts into tool_group entries for the timeline. */
function groupAssistantParts(parts) {
  /** @type {Array<{ type: 'thinking', text: string, lastInParts: boolean } | { type: 'tool_group', tools: object[] } | { type: 'approval', approval: object } | { type: 'ask', ask: object }>} */
  const groups = [];
  const list = Array.isArray(parts) ? parts : [];
  for (let i = 0; i < list.length; i++) {
    const part = list[i];
    if (part?.type === 'thinking') {
      groups.push({
        type: 'thinking',
        text: part.text || '',
        lastInParts: i === list.length - 1,
      });
      continue;
    }
    if (part?.type === 'approval' && part.approval) {
      groups.push({ type: 'approval', approval: part.approval });
      continue;
    }
    if (part?.type === 'ask' && part.ask) {
      groups.push({ type: 'ask', ask: part.ask });
      continue;
    }
    if (part?.type === 'tool' && part.tool) {
      const tools = [part.tool];
      while (i + 1 < list.length && list[i + 1]?.type === 'tool' && list[i + 1].tool) {
        i += 1;
        tools.push(list[i].tool);
      }
      groups.push({ type: 'tool_group', tools });
    }
  }
  return groups;
}

function ThinkingBlock({ text, streaming }) {
  const hasText = Boolean(text && text.trim());
  const [open, setOpen] = useState(Boolean(streaming || hasText));

  useEffect(() => {
    if (streaming) setOpen(true);
    else if (hasText) setOpen(false);
  }, [streaming, hasText]);

  if (!hasText && !streaming) return null;

  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left"
        aria-expanded={open}
        aria-label={streaming ? 'Thinking' : 'Thought'}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-500 group-hover:text-gray-400" />
        <BrainIcon
          className={`mt-0.5 ${streaming ? 'text-gray-400' : 'text-gray-500 group-hover:text-gray-400'}`}
        />
        {!hasText ? (
          <span className="chat-shimmer mt-0.5 text-[12px] italic text-gray-500">…</span>
        ) : !open ? (
          <pre className="min-w-0 flex-1 line-clamp-2 whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed italic text-gray-600">
            {text}
          </pre>
        ) : (
          <span className={`mt-0.5 text-[12px] italic ${streaming ? 'chat-shimmer text-gray-400' : 'text-gray-500'}`}>
            {streaming ? 'Thinking' : 'Thought'}
          </span>
        )}
      </button>
      {open && hasText ? (
        <ClippedGrow
          maxHeightPx={THINKING_CLIP_PX}
          follow={streaming}
          followKey={String(text.length)}
          className="ml-5 mt-0.5"
        >
          <pre
            className={`whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed italic text-gray-500 ${
              streaming ? 'chat-shimmer' : ''
            }`}
          >
            {text}
          </pre>
        </ClippedGrow>
      ) : null}
    </div>
  );
}

function ToolGroupBlock({ tools }) {
  const list = Array.isArray(tools) ? tools : [];
  const running = list.some((t) => (t.status || (t.ok === false ? 'error' : 'done')) === 'running');
  const failed = list.some((t) => t.status === 'error' || t.ok === false);
  // Expansion follows only the running state: a finished call — success or failure —
  // starts collapsed and is expandable on demand, so failed rows behave like the rest.
  const [open, setOpen] = useState(running);

  useEffect(() => {
    setOpen(running);
  }, [running]);

  const n = list.length;
  const label = running
    ? (n === 1 ? 'Running tool…' : `Running ${n} tools…`)
    : (n === 1 ? 'Tool' : `${n} tools`);

  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-gray-900/60"
        aria-expanded={open}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
        <ToolIcon className="mt-0.5 text-gray-500 group-hover:text-gray-400" />
        {running ? <StatusGlyph status="running" className="mt-0.5" />
          : failed ? <StatusGlyph status="error" className="mt-0.5" />
            : null}
        <span className={`min-w-0 truncate ${running ? 'chat-shimmer text-gray-300' : 'text-gray-400'}`}>
          <span className="font-medium text-gray-300">{label}</span>
        </span>
        {failed && !running ? (
          <span className="ml-auto shrink-0 text-[11px] text-rose-400">failed</span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-5 mt-0.5 flex flex-col gap-0.5 border-l border-gray-800 pl-2">
          {list.map((tool, i) => (
            <ToolCallRow key={tool.id || `tool-${i}`} tool={tool} nested />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalBlock({ approval, onApproval = null }) {
  const pending = approval?.status === 'pending';
  const allowed = approval?.status === 'allowed';
  const denied = approval?.status === 'denied';
  // Expansion follows only the pending state: an unresolved approval must stay open so
  // its Allow/Deny buttons are reachable, but a resolved one — Allowed or Denied —
  // collapses like any other finished tool call and is expandable on demand.
  const [open, setOpen] = useState(pending);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    setOpen(pending);
  }, [pending]);

  useEffect(() => {
    if (!pending) setDeciding(false);
  }, [pending]);

  // A waiting approval is NOT pinned: no sticky, no fixed, no floating overlay.
  // It stays in the transcript flow and the scroll-to-approval effect in the chat
  // view brings it into view, so the row reads as a step in order rather than as
  // a panel hovering over the work above it. That is why it carries no opaque
  // background either — nothing scrolls behind it.

  // Visible countdown to the rule's timeout. The approval gate owns the one
  // deadline and ships timeoutStartsAt on the request, so this counts down to
  // the moment the gate will settle — there is no second clock to drift against.
  // When it reaches zero the rule's default settles the row (ask-deny denies,
  // ask-allow allows) and the gate re-emits the resolved status, which collapses
  // this block like any other finished step.
  const timeoutMs = Number(approval?.timeoutMs) > 0 ? Number(approval.timeoutMs) : DEFAULT_APPROVAL_TIMEOUT_MS;
  const timeoutAllows = approval?.timeoutDefaultAllowed === true;
  const [deadline, setDeadline] = useState(null);
  useEffect(() => {
    if (!pending || !approval?.id) {
      setDeadline(null);
      return;
    }
    const startsAt = Number(approval?.timeoutStartsAt);
    setDeadline(Number.isFinite(startsAt) && startsAt > 0 ? startsAt + timeoutMs : Date.now() + timeoutMs);
  }, [pending, approval?.id, approval?.timeoutStartsAt, timeoutMs]);
  const [remainingMs, setRemainingMs] = useState(null);
  useEffect(() => {
    if (!deadline) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadline]);
  const remainingNow = remainingMs ?? timeoutMs;
  const barPct = Math.max(0, Math.min(100, Math.round((remainingNow / timeoutMs) * 100)));

  async function decide(nextAllowed) {
    if (!onApproval || !approval?.id || deciding || !pending) return;
    setDeciding(true);
    try {
      await onApproval({ approvalId: approval.id, allowed: nextAllowed });
    } catch {
      setDeciding(false);
    }
  }

  const detail = approval?.summary || '';
  // A timeout settles the row without a human click — say so, so an
  // auto-allowed command is never read as something the user approved.
  const autoSettled = approval?.autoSettled === true;
  const label = pending
    ? 'Approval'
    : allowed
      ? autoSettled ? 'Auto-allowed' : 'Allowed'
      : denied
        ? autoSettled ? 'Auto-denied' : 'Denied'
        : 'Approval';

  return (
    <div
      data-kusa-approval={pending ? 'pending' : 'resolved'}
      className="text-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-gray-900/60"
        aria-expanded={open}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
        <ApprovalIcon
          className={`mt-0.5 ${pending ? 'text-amber-400' : allowed ? 'text-emerald-500' : denied ? 'text-rose-400' : 'text-gray-500 group-hover:text-gray-400'}`}
        />
        {pending ? <StatusGlyph status="awaiting_approval" className="mt-0.5" /> : null}
        <span className={`min-w-0 truncate ${pending ? 'chat-shimmer text-gray-300' : 'text-gray-400'}`}>
          <span className="font-medium text-gray-300">{label}</span>
          {approval?.name ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> {approval.name}
            </span>
          ) : null}
          {detail ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> {detail}
            </span>
          ) : null}
          {pending && deadline ? (
            <span className="ml-2 shrink-0 text-amber-300">
              {' '}
              <span className="text-gray-700">·</span> {clock(remainingNow)} left
              <span className="ml-1.5 text-gray-500">
                {' '}
                <span className="text-gray-700">→</span> {timeoutAllows ? 'auto-allow' : 'auto-deny'}
              </span>
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className={`ml-5 mt-1.5 space-y-2 border-l pl-3 ${pending ? 'border-amber-900/60' : 'border-gray-800'}`}>
          <p className={`text-[12px] leading-relaxed ${pending ? 'text-amber-200/90' : 'text-gray-500'}`}>
            {approval?.message || `Allow ${approval?.name || 'this tool'} to run?`}
          </p>
          {pending ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Nobody answering is not a stall — after {Math.round(timeoutMs / 1000)}s this rule settles as{' '}
              <code className={timeoutAllows ? 'text-emerald-300' : 'text-rose-300'}>
                {timeoutAllows ? 'allow' : 'deny'}
              </code>
              .
            </p>
          ) : null}
          {pending && deadline ? (
            <div className="flex items-center gap-2 text-[11px] text-gray-500">
              <span>Time left</span>
              <span className="relative block h-1 w-24 rounded overflow-hidden bg-gray-700">
                <span
                  className={`absolute inset-y-0 left-0 block rounded ${timeoutAllows ? 'bg-emerald-500' : 'bg-amber-400'}`}
                  style={{ width: `${barPct}%` }}
                />
              </span>
              <span className="ml-2 font-mono text-amber-300">{clock(remainingNow)}</span>
              <span className="ml-2 text-gray-400">
                on timeout → {timeoutAllows ? 'allow' : 'deny'}
              </span>
            </div>
          ) : null}
          {!pending && autoSettled ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Settled by the rule after {Math.round(timeoutMs / 1000)}s with no answer —{' '}
              {timeoutAllows ? 'the call ran' : 'the call did not run'}.
            </p>
          ) : null}
          {pending && onApproval ? (
            <div data-kusa-approval-cta className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={deciding}
                onClick={() => decide(true)}
                className="rounded bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {deciding ? '…' : 'Allow'}
              </button>
              <button
                type="button"
                disabled={deciding}
                onClick={() => decide(false)}
                className="rounded border border-gray-700 bg-gray-900 px-2.5 py-1 text-[12px] font-medium text-gray-300 hover:border-gray-500 hover:text-gray-100 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A question the model asked the user (kusa_ask). It sits in the transcript
 * flow like an Approval — open while pending so its buttons are reachable,
 * collapsed once answered — because it is a step in order, not a panel
 * hovering over the work above it.
 *
 * The card is a choice, not a form: one clickable button per option, plus a
 * free-text field for anything none of them covers. Clicking sends the answer
 * straight away; typing needs an explicit Send, since a text field has no
 * reliable "I am done" signal. Nobody answering is not a stall — the ask
 * refuses after its countdown and the model says which assumption it is
 * proceeding with, so the countdown only explains that.
 */
function AskBlock({ ask, onAsk = null }) {
  const pending = ask?.status === 'pending';
  const answered = ask?.status === 'answered';
  const options = Array.isArray(ask?.options) ? ask.options : [];
  const allowFreeText = ask?.allowFreeText !== false;
  // The index the server resolved (-1 = typed text), so the answered card can
  // point at the choice the user actually made instead of re-deriving it.
  const chosenIndex = Number(ask?.answer?.selected);
  const typedAnswer = String(ask?.answer?.freeText ?? '');
  const chosenOption = chosenIndex >= 0
    ? options.find((option) => Number(option?.index) === chosenIndex)
    : null;

  // Expansion follows only the pending state, same rule as ApprovalBlock.
  const [open, setOpen] = useState(pending);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setOpen(pending);
  }, [pending]);

  useEffect(() => {
    if (!pending) setSending(false);
  }, [pending]);

  async function send(patch) {
    if (!onAsk || !ask?.id || sending || !pending) return;
    setSending(true);
    try {
      await onAsk({ askId: ask.id, ...patch });
    } catch {
      setSending(false);
    }
  }

  const timeoutMs = Number(ask?.timeoutMs) > 0 ? Number(ask.timeoutMs) : DEFAULT_ASK_TIMEOUT_MS;
  const [deadline, setDeadline] = useState(null);
  useEffect(() => {
    if (!pending || !ask?.id) {
      setDeadline(null);
      return;
    }
    const startsAt = Number(ask?.timeoutStartsAt);
    setDeadline(Number.isFinite(startsAt) && startsAt > 0 ? startsAt + timeoutMs : Date.now() + timeoutMs);
  }, [pending, ask?.id, ask?.timeoutStartsAt, timeoutMs]);
  const [remainingMs, setRemainingMs] = useState(null);
  useEffect(() => {
    if (!deadline) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  const label = pending
    ? 'Question'
    : answered
      ? 'Answered'
      : 'No answer';

  return (
    <div
      data-kusa-ask={pending ? 'pending' : 'resolved'}
      className="text-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-gray-900/60"
        aria-expanded={open}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
        <svg
          className={`mt-0.5 h-4 w-4 shrink-0 ${pending ? 'text-violet-400' : answered ? 'text-emerald-500' : 'text-gray-500 group-hover:text-gray-400'}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path strokeLinecap="round" d="M6.5 5.5A3 3 0 0 1 8.8 4.2 3 3 0 0 1 9.5 7.2" />
          <path strokeLinecap="round" d="M9.5 10.5h.01" />
        </svg>
        {pending ? <StatusGlyph status="awaiting_answer" className="mt-0.5" /> : null}
        <span className={`min-w-0 truncate ${pending ? 'chat-shimmer text-gray-300' : 'text-gray-400'}`}>
          <span className="font-medium text-gray-300">{label}</span>
        </span>
      </button>
      {open ? (
        <div className={`ml-5 mt-1.5 space-y-2 border-l pl-3 ${pending ? 'border-violet-900/60' : 'border-gray-800'}`}>
          <p className={`text-[12px] leading-relaxed ${pending ? 'text-violet-200/90' : 'text-gray-500'}`}>
            {ask?.question || 'The model asked a question.'}
          </p>
          {pending ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              {allowFreeText
                ? 'Click a choice, or answer in your own words. '
                : 'Click a choice. '}
              Nobody answering is not a stall — after{' '}
              {Math.round(timeoutMs / 1000)}s the question is dropped and the model states the assumption it is proceeding with.
            </p>
          ) : null}
          {pending && deadline ? (
            <div className="flex items-center gap-2 text-[11px] text-gray-500">
              <span>Time left</span>
              <span className="ml-2 font-mono text-violet-300">{clock(remainingMs ?? timeoutMs)}</span>
            </div>
          ) : null}
          {pending ? (
            <div data-kusa-ask-cta className="flex flex-col gap-1.5">
              {options.map((option) => (
                <button
                  key={option?.index ?? option?.label}
                  type="button"
                  disabled={sending}
                  onClick={() => send({ optionIndex: Number(option?.index) })}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-[12px] font-medium text-gray-200 hover:border-violet-500 hover:text-white disabled:opacity-50"
                >
                  {option?.label}
                  {option?.detail ? (
                    <span className="ml-1.5 text-[11px] text-gray-500">{option.detail}</span>
                  ) : null}
                </button>
              ))}
              {allowFreeText ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draft}
                    onChange={(event) => setDraft(String(event.target?.value ?? ''))}
                    placeholder="None of these — type your answer"
                    className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[12px] text-gray-200"
                  />
                  <button
                    type="button"
                    disabled={sending || !draft.trim()}
                    onClick={() => send({ freeText: draft.trim() })}
                    className="rounded bg-violet-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
                  >
                    Send answer
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {!pending && answered ? (
            <p className="text-[11px] leading-relaxed text-gray-400">
              Answered:{' '}
              {chosenOption
                ? chosenOption.label
                : typedAnswer || 'the user answered without a choice'}
            </p>
          ) : null}
          {!pending && !answered ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              No answer within {Math.round(timeoutMs / 1000)}s — the model proceeds on a stated assumption.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallRow({ tool, nested = false }) {
  const status = tool.status || (tool.ok === false ? 'error' : 'done');
  const running = status === 'running';
  const failed = status === 'error' || tool.ok === false;
  const detail = useMemo(() => toolDetail(tool), [tool]);
  // Expansion follows only the running state: a finished call — success or failure —
  // starts collapsed and is expandable on demand, so failed rows behave like the rest.
  const [open, setOpen] = useState(running);

  useEffect(() => {
    setOpen(running);
  }, [running]);

  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-gray-900/60"
        aria-expanded={open}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
        {nested ? null : <ToolIcon className="mt-0.5 text-gray-500 group-hover:text-gray-400" />}
        {(running || failed) ? <StatusGlyph status={status} className="mt-0.5" /> : null}
        <span className={`min-w-0 truncate ${running ? 'chat-shimmer text-gray-300' : 'text-gray-400'}`}>
          <span className="font-medium text-gray-300">{tool.name || 'tool'}</span>
          {detail ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> {detail}
            </span>
          ) : null}
        </span>
        {failed ? (
          <span className="ml-auto shrink-0 text-[11px] text-rose-400">failed</span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-5 mt-0.5 space-y-1.5 border-l border-gray-800 pl-3 font-mono text-[11px] text-gray-500">
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wide text-gray-600">Input</div>
            <ClippedGrow
              maxHeightPx={TOOL_INPUT_CLIP_PX}
              follow={running}
              followKey={stringify(tool.args)}
            >
              <pre className="whitespace-pre-wrap break-words text-gray-400">
                {stringify(tool.args) || '—'}
              </pre>
            </ClippedGrow>
          </div>
          {(tool.result !== undefined || tool.summary || failed) ? (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-gray-600">Output</div>
              <ClippedGrow
                maxHeightPx={TOOL_OUTPUT_CLIP_PX}
                follow={running}
                followKey={
                  tool.result !== undefined
                    ? stringify(tool.result)
                    : String(tool.summary || '')
                }
              >
                <pre className={`whitespace-pre-wrap break-words ${failed ? 'text-rose-300/80' : 'text-gray-400'}`}>
                  {tool.result !== undefined ? stringify(tool.result) : (tool.summary || (running ? '…' : '—'))}
                </pre>
              </ClippedGrow>
            </div>
          ) : running ? (
            <div className="text-gray-600">Running…</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusGlyph({ status, className = '' }) {
  if (status === 'awaiting_answer') {
    return (
      <span
        className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center ${className}`}
        aria-hidden="true"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
      </span>
    );
  }
  if (status === 'awaiting_approval') {
    return (
      <span
        className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center ${className}`}
        aria-hidden="true"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      </span>
    );
  }
  if (status === 'running') {
    return (
      <svg className={`h-4.5 w-4.5 shrink-0 animate-spin text-sky-400 ${className}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
        <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg className={`h-4.5 w-4.5 shrink-0 text-rose-400 ${className}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5v3.5M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  // Done: subtle chevron-dot, not a loud checkmark (VS Code default).
  return (
    <span className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center ${className}`} aria-hidden="true">
      <span className="h-1.5 w-1.5 rounded-full bg-gray-600" />
    </span>
  );
}

function Chevron({ open, className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''} ${className}`}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4z" />
    </svg>
  );
}

/**
 * Queue toggle glyph. On, it draws the list itself — dot + row per held
 * prompt, in the order the cards stack above the composer. Off, it draws one
 * row with a "+": the queue exists but is not listed, and this is the control
 * that lists it. The glyph never promises rows that are not on screen, so the
 * toggle and the composer agree about what the user will see.
 */
function QueueIcon({ expanded = true, className = 'text-gray-500' }) {
  const dots = expanded ? 'M3.5 4.5h.01M3.5 8h.01M3.5 11.5h.01' : 'M3.5 5.5h.01';
  const rows = expanded ? 'M6 4.5h7M6 8h7M6 11.5h7' : 'M6 5.5h7';
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path strokeWidth="2.25" d={dots} />
      <path d={rows} />
      {expanded ? null : <path d="M11.5 8.75v3.5M9.75 10.5h3.5" />}
    </svg>
  );
}

/**
 * Task List toggle glyph. It must not read as the queue glyph, so it is a
 * checklist, not a bulleted list: on, three rows of work with two ticks —
 * "some of this is done", which is what a task list is. Off, it draws one
 * ticked row plus a "+": tasks exist but are not listed, and this is the
 * control that lists them. Same affordance as QueueIcon, different picture.
 */
function TaskIcon({ expanded = true, className = 'text-gray-500' }) {
  const rows = expanded ? 'M6 4.5h7M6 8h7M6 11.5h7' : 'M6 5.5h7';
  const ticks = expanded
    ? 'M3.5 7.6 4.5 8.6 6.2 6.9M3.5 11.1 4.5 12.1 6.2 10.4'
    : 'M3.5 8.6 4.5 9.6 6.2 7.9';
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={rows} />
      <path d={ticks} />
      {expanded ? null : <path d="M11.5 11.25v3.5M9.75 13h3.5" />}
    </svg>
  );
}

/** Simple two-hemisphere brain for thinking rows. */
function BrainIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4.5 w-4.5 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15.5 13a3.5 3.5 0 0 0-3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8" />
      <path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1-7 0v-1.8" />
      <path d="M17.5 16a3.5 3.5 0 0 0 0-7H17" />
      <path d="M19 9.3V6.5a3.5 3.5 0 0 0-7 0" />
      <path d="M6.5 16a3.5 3.5 0 0 1 0-7H7" />
      <path d="M5 9.3V6.5a3.5 3.5 0 0 1 7 0v10" />
    </svg>
  );
}

/** Open-jaw wrench for tool call rows. */
function ToolIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4.5 w-4.5 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
    </svg>
  );
}

function ApprovalIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4.5 w-4.5 shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 2.25 3.75 4v3.4c0 2.85 1.85 4.9 4.25 5.85 2.4-.95 4.25-3 4.25-5.85V4L8 2.25z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.1 7.9 7.4 9.2 9.9 6.5" />
    </svg>
  );
}

function AgentIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4.5 w-4.5 shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 1.75v1.5M4.5 5.25h7a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.25v-4.5a1.5 1.5 0 0 1 1.5-1.5z"
      />
      <path strokeLinecap="round" d="M6.25 8.25h.01M9.75 8.25h.01M6.5 10.25h3" />
    </svg>
  );
}

function toolDetail(tool) {
  const args = normalizeArgs(tool.args);
  if (!args) {
    if (typeof tool.summary === 'string' && tool.summary) return truncate(tool.summary, 72);
    return '';
  }
  for (const key of [
    'path', 'file_path', 'filePath', 'target', 'command', 'cmd',
    'query', 'pattern', 'url', 'uri', 'name', 'id',
  ]) {
    if (args[key] != null && String(args[key]).trim()) {
      return truncate(String(args[key]).trim(), 72);
    }
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 72);
  }
  return '';
}

function normalizeArgs(args) {
  if (args == null) return null;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : { value: trimmed };
    } catch {
      return { value: trimmed };
    }
  }
  if (typeof args === 'object') return args;
  return { value: String(args) };
}

function previewLine(text, max = 120) {
  const line = String(text || '').trim().split(/\n/).find((l) => l.trim()) || '';
  return truncate(line, max);
}

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function stringify(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
