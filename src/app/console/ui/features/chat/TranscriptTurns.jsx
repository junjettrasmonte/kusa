import { useEffect, useRef, useState } from 'react';
import { MarkdownBody, looksLikeMarkdown } from '#ui/shared/MarkdownBody.jsx';
import {
  agentErrorDisplayText,
  isCursorTrustError,
  assistantParts,
  groupAssistantParts,
  isAgentErrorMessage,
  normalizeChatMarkdown,
  truncate,
} from '#ui/shared/lib/chatText.js';
import { HARNESS_NAMES, sessionProviderHarness } from '#ui/shared/lib/format.js';
import { HarnessLogo } from '#ui/shared/HarnessLogo.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import {
  AgentIcon,
  ArrowUpIcon,
  Chevron,
  StatusGlyph,
} from './ChatGlyphs.jsx';
import { AttachmentChips } from '#ui/shared/AttachmentChips.jsx';
import { ClippedGrow } from './ClippedGrow.jsx';
import { ThinkingBlock, ToolCallRow, ToolGroupBlock } from './ToolRows.jsx';
import {
  ApprovalBlock,
  AskAnswerReply,
  AskCard,
  gateCarryBack,
} from './GateBlocks.jsx';
import { roleDisplayName, roleVisual } from './roleVisuals.js';

/** Compact model id for the AgentSegment header (drop org/path noise). */
function shortModelLabel(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  const base = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return base.length > 28 ? `${base.slice(0, 26)}…` : base;
}

function speakerHarness(speaker) {
  if (!speaker) return '';
  // Provider (Agent picker) first — same rule as the sidebar session mark.
  return sessionProviderHarness(speaker);
}

function speakerRoleLabel(speaker) {
  const role = String(speaker?.role || '').trim();
  if (!role) return '';
  return role.replace(/[_-]+/g, ' ');
}

/** Fine-print stub under an orchestrator turn for each Delegated handoff. */
function DelegateFinePrint({ stub }) {
  if (!stub) return null;
  const role = speakerRoleLabel(stub.speaker) || stub.roleLabel || 'agent';
  const brief = typeof stub.text === 'string' ? stub.text.trim() : '';
  return (
    <p className="mt-1.5 text-[10px] leading-relaxed text-gray-600">
      <span className="text-gray-500">Delegated · {role}</span>
      {brief ? (
        <>
          {' '}
          <span className="text-gray-700">·</span>
          {' '}
          {truncate(brief, 120)}
        </>
      ) : null}
    </p>
  );
}

function DelegateFinePrintList({ delegates }) {
  const list = Array.isArray(delegates) ? delegates.filter(Boolean) : [];
  if (!list.length) return null;
  return (
    <div className="mt-1">
      {list.map((stub, index) => (
        <DelegateFinePrint key={stub.id || `delegate-${index}`} stub={stub} />
      ))}
    </div>
  );
}

/**
 * Role-mark avatar to the left of an assistant bubble — Lucide glyph tinted to
 * the Subagent/role palette so orchestrated transcripts stay scannable.
 */
export function RoleAvatar({ role = '', className = '' }) {
  const visual = roleVisual(role);
  const title = roleDisplayName(role);
  return (
    <span
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${visual.avatar}${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={title}
    >
      <LucideIcon name={visual.icon} className="h-4 w-4" title={title} />
    </span>
  );
}

/**
 * Left-avatar + tinted bubble shell for one assistant participant turn.
 * Gates (ask / approval) stay outside — they are the human's turn.
 */
export function AssistantBubble({ speaker = null, children, className = '' }) {
  const role = speaker?.role || '';
  const visual = roleVisual(role);
  return (
    <div className={`flex items-start gap-2.5${className ? ` ${className}` : ''}`}>
      <RoleAvatar role={role} className="mt-0.5" />
      <div className={`min-w-0 flex-1 rounded-lg px-3.5 py-2.5 ${visual.bubble}`}>
        {children}
      </div>
    </div>
  );
}

/**
 * Transcript turns — the outer shape of one chat exchange.
 *
 * ChatTurn routes a user row and an assistant row; AssistantTurn/AgentSegment lay
 * out the parts (see ../lib/chatText.js) and delegate the actual drawing to
 * ToolRows.jsx and GateBlocks.jsx. Height caps come in from SessionChat, which
 * owns the transcript scroll container.
 */
export function UserMessage({ msg, busy, editing, onStartEdit, onCancelEdit, onResendEdit }) {
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

  const files = Array.isArray(msg.attachments) ? msg.attachments.filter(Boolean) : [];
  const hasText = typeof msg.text === 'string' && Boolean(msg.text.trim());
  const jiraOnly = files.length > 0
    && files.every((row) => row?.kind === 'jira' && String(row?.issueKey || '').trim());
  // Jira-ticket kickoffs carry no typed words — show only the issue-key chip,
  // not "(N files attached — no words were typed)" or an empty green bubble.
  const showEmptyAttachNote = !hasText && files.length > 0 && !jiraOnly;
  const showBubble = hasText || showEmptyAttachNote;
  const body = (
    <>
      {hasText ? msg.text : null}
      {showEmptyAttachNote ? (
        <span className="text-gray-500 italic">
          {`(${files.length} file${files.length === 1 ? '' : 's'} attached — no words were typed)`}
        </span>
      ) : null}
    </>
  );
  const bubbleClass =
    'rounded-lg bg-emerald-500/15 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-gray-100';
  // External / observe-only sessions never pass onStartEdit — bubble stays inert.
  const canEdit = Boolean(onStartEdit) && !busy;

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%]">
        {showBubble ? (
          canEdit ? (
            <button
              type="button"
              title="Edit message"
              aria-label="Edit message"
              onClick={() => onStartEdit?.()}
              className={`${bubbleClass} w-full cursor-pointer text-left transition-colors hover:bg-emerald-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50`}
            >
              {body}
            </button>
          ) : (
            <div className={bubbleClass}>{body}</div>
          )
        ) : null}
        {/*
         * The files this prompt carried, as a compact chip strip (same shape
         * the Attachments drawer staged). A sent message states what it held,
         * so a transcript read months later and the prompt that produced it
         * cannot disagree. Jira-only turns are chip-only (key + icon).
         */}
        {files.length ? (
          <AttachmentChips
            attachments={files}
            className={`flex flex-wrap justify-end items-center gap-1.5${showBubble ? ' mt-1.5' : ''}`}
          />
        ) : null}
      </div>
    </div>
  );
}

export function ChatTurn({
  msg,
  busy,
  editing,
  onStartEdit,
  onCancelEdit,
  onResendEdit,
  agentMaxHeight = null,
  onApproval = null,
  onAsk = null,
  onTrustWorkspace = null,
  trustBusy = false,
  trustNote = '',
}) {
  // Unhosted leftover (parent still streaming when assign fired). Same fine
  // print as stubs folded onto an orchestrator turn — never a section header.
  if (msg.role === 'meta' || msg.role === 'delegate') {
    return <DelegateFinePrint stub={msg} />;
  }
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

  return (
    <AssistantTurn
      msg={msg}
      agentMaxHeight={agentMaxHeight}
      onApproval={onApproval}
      onAsk={onAsk}
      onTrustWorkspace={onTrustWorkspace}
      trustBusy={trustBusy}
      trustNote={trustNote}
    />
  );
}

/**
 * Cut the parts timeline into renderable blocks: `{ kind: 'segment' }` runs of
 * agent work, plus `{ kind: 'ask' }` questions and `{ kind: 'approval' }` gates
 * that are STILL WAITING. Only an open gate ends the container before it, and
 * only because it must stay outside the collapsible rail: its Allow/Deny row is
 * the user's turn and folding that rail can never bury buttons the user still
 * has to press. A settled approval is not an interruption — the run never
 * paused, or it paused and the user answered it in place — so it stays inside
 * `current` and the run keeps ONE container across it. That is the difference
 * between a turn reading as one thread and the same turn repeating an
 * `Agent · n thoughts · m tools` header once per gated call. Questions keep
 * their own block in every state: an answered one is followed by the user's
 * own reply bubble, which is a new turn and legitimately opens a new container.
 * An interruption with no work before it yields no empty container; the
 * trailing segment is always emitted so the final reply always has an owner.
 */
export function splitAtVisibleRows(parts) {
  const list = Array.isArray(parts) ? parts : [];
  // Only these two statuses mean "settled" — anything else is still the
  // user's turn and keeps its own row. (A superseded open gate is settled to
  // `denied` by the parts merge, so it folds like any other resolved row.)
  const settled = (approval) =>
    approval?.status === 'allowed' || approval?.status === 'denied';
  const blocks = [];
  let current = [];
  for (const part of list) {
    const isAsk = part?.type === 'ask' && part.ask;
    const isApproval = part?.type === 'approval' && part.approval;
    if (isAsk || (isApproval && !settled(part.approval))) {
      if (current.length) {
        blocks.push({ kind: 'segment', parts: current });
        current = [];
      }
      blocks.push(isAsk ? { kind: 'ask', ask: part.ask } : { kind: 'approval', approval: part.approval });
      continue;
    }
    current.push(part);
  }
  blocks.push({ kind: 'segment', parts: current });
  return blocks;
}

/**
 * One assistant turn as a collapsible parent: collapsed transcript stays
 * user / agent / user / agent; expand for thoughts, tools, and full reply.
 *
 * A question is the user's turn, and an approval gate is the user's decision,
 * so neither hides behind a fold WHILE IT WAITS: a pending question card and a
 * pending Allow/Deny row render as their own visible rows, so folding a
 * container can never bury a gate the user still has to answer. Settled, the
 * two part ways on purpose. An approval is not an interruption — the run
 * carried on under the verdict — so `splitAtVisibleRows` leaves it inside the
 * container it paused, its row renders in that rail, and the header still
 * states the verdict the run continued under: one container across every
 * gated call, not one header per call. A question IS an interruption, and it
 * keeps its row in every state, because the row is the record of what was
 * asked and nothing else in the thread says that; an answered one is followed
 * by the user's own reply bubble, which is a new turn and opens a new
 * container.
 */
/**
 * Settled model/endpoint failure — not an assistant reply. Keeps the user
 * prompt and prior turns above it; the next Send can retry. Cursor trust
 * failures also offer a one-click `agent -p --trust` via onTrustWorkspace.
 * Starts collapsed (like finished tool rows); expand for the full body.
 */
function AgentErrorCard({
  text,
  code = '',
  onTrustWorkspace = null,
  trustBusy = false,
  trustNote = '',
}) {
  const body = agentErrorDisplayText(text);
  const needsTrust = isCursorTrustError({ text, code })
    || (typeof onTrustWorkspace === 'function' && isCursorTrustError(text));
  const title = needsTrust ? 'Workspace trust required' : 'Model error';
  const [open, setOpen] = useState(false);
  const showTrust = needsTrust && typeof onTrustWorkspace === 'function';

  return (
    <div
      className="mt-1 rounded-md border border-rose-900/70 bg-rose-950/50 px-3 py-2.5 text-sm"
      role="alert"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded text-left"
        aria-expanded={open}
        aria-label={title}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-rose-400/60 group-hover:text-rose-300" />
        <StatusGlyph status="error" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-rose-300">{title}</p>
          {!open && body ? (
            <p className="mt-0.5 line-clamp-1 whitespace-pre-wrap leading-relaxed text-rose-100/70">
              {body}
            </p>
          ) : null}
        </div>
      </button>
      {open && body ? (
        <p className="mt-1.5 ml-5 whitespace-pre-wrap leading-relaxed text-rose-100/90">{body}</p>
      ) : null}
      {showTrust ? (
        <div className="mt-3 ml-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={trustBusy}
            onClick={onTrustWorkspace}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {trustBusy ? 'Trusting workspace…' : 'Trust workspace'}
          </button>
          {trustNote ? (
            <span className="text-xs text-rose-200/80">{trustNote}</span>
          ) : (
            <span className="text-xs text-rose-200/70">
              Runs <code className="font-mono text-rose-100">agent -p --trust</code> in this repo
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantTurn({
  msg,
  onApproval = null,
  onAsk = null,
  agentMaxHeight = null,
  onTrustWorkspace = null,
  trustBusy = false,
  trustNote = '',
}) {
  const parts = assistantParts(msg);
  const blocks = splitAtVisibleRows(parts);
  const replyText = typeof msg.text === 'string' ? msg.text : '';
  const streaming = Boolean(msg.streaming);
  const stopped = Boolean(msg.stopped);
  const errored = isAgentErrorMessage(msg);
  // An unresolved question or approval is the user's turn, not the agent's:
  // drop the empty container that follows it, so the container whose work led
  // to that row stays the live one (and keeps its "Awaiting approval…" label).
  const tail = blocks[blocks.length - 1];
  const gate = blocks.length > 1 ? blocks[blocks.length - 2] : null;
  const pausedAtGate =
    gate?.kind === 'ask'
      ? gate.ask?.status === 'pending'
      : gate?.kind === 'approval'
        ? gate.approval?.status === 'pending'
        : false;
  if (pausedAtGate && tail?.kind === 'segment' && !tail.parts.length) blocks.pop();
  // Only the trailing container is live: a container closed by an interruption
  // is settled, so it collapses, owns no reply, and gets no footer.
  let lastSegment = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind === 'segment') lastSegment = i;
  }
  // The gate a block represents, in the shape `AgentSegment` expects.
  const gateOf = (block) =>
    block?.kind === 'ask'
      ? { kind: 'ask', ask: block.ask }
      : block?.kind === 'approval'
        ? { kind: 'approval', approval: block.approval }
        : null;
  // Only a question can still be dropped from the flow this way: a timed-out
  // or superseded one carries its outcome back to the container before it,
  // which would otherwise say the same thing twice. `gateCarryBack` answers
  // for questions only, so this test is exactly that — an approval block is
  // always an open gate and always keeps its own row.
  const carriedBack = (index) =>
    Boolean(gateCarryBack(gateOf(blocks[index]))) &&
    (() => {
      const prev = blocks[index - 1];
      if (!prev || prev.kind !== 'segment') return false;
      return Boolean(prev.parts?.length) || index - 1 === lastSegment;
    })();
  const rendered = blocks.map((block, index) => {
    if (block.kind === 'ask') {
      const answerReply = block.ask?.status === 'answered'
        ? <AskAnswerReply key={`answer-${index}`} ask={block.ask} />
        : null;
      if (carriedBack(index)) return answerReply;
      return [
        <AskCard key={`ask-${index}`} ask={block.ask} onAsk={onAsk} />,
        answerReply,
      ];
    }
    if (block.kind === 'approval') {
      // Only an OPEN gate reaches this branch: it renders outside the rail so
      // its Allow/Deny stay reachable with the container above it folded. A
      // settled one never gets here — it stayed inside a segment and renders
      // in that rail instead (see AgentSegment).
      if (carriedBack(index)) return null;
      return (
        <ApprovalBlock
          key={`approval-${index}`}
          approval={block.approval}
          onApproval={onApproval}
        />
      );
    }
    const isLast = index === lastSegment;
    // An empty container in the middle of a turn has nothing to show; the
    // trailing one still renders while the turn streams.
    if (!block.parts.length && !isLast) return null;
    // The gate that follows this container, if any. The row itself renders
    // outside the fold (so its buttons stay reachable); the container only
    // needs the gate to label the wait it is paused at. A settled gate hands
    // nothing back — an approval's verdict row lives inside the rail, and a
    // question's answer is its own reply bubble — so the header stays clean.
    const gateRow = blocks[index + 1];
    return (
      <AgentSegment
        key={`segment-${index}`}
        parts={block.parts}
        replyText={isLast ? replyText : ''}
        streaming={streaming && isLast}
        stopped={stopped && isLast}
        error={errored && isLast}
        errorCode={errored && isLast ? (msg?.code || '') : ''}
        isLast={isLast}
        gate={gateOf(gateRow)}
        speaker={msg?.speaker || null}
        delegates={isLast ? (msg?.delegates || null) : null}
        agentMaxHeight={agentMaxHeight}
        onApproval={onApproval}
        onTrustWorkspace={onTrustWorkspace}
        trustBusy={trustBusy}
        trustNote={trustNote}
      />
    );
  });
  // Pure failure with no thinking/tools: just the error card under the user turn.
  if (errored && !parts.length) {
    return (
      <AssistantBubble speaker={msg?.speaker || null}>
        <AgentErrorCard
          text={replyText}
          code={msg?.code || ''}
          onTrustWorkspace={onTrustWorkspace}
          trustBusy={trustBusy}
          trustNote={trustNote}
        />
        <DelegateFinePrintList delegates={msg?.delegates} />
      </AssistantBubble>
    );
  }
  // Unsplit turns keep their original DOM: no wrapper around a single container.
  if (blocks.length === 1) return rendered[0];
  return (
    <div className="flex flex-col gap-6">
      {rendered}
    </div>
  );
}

/**
 * One collapsible container of agent work: the thinking and tool rows between
 * two interruptions (a question, an OPEN approval gate, or the end of the run)
 * plus the approvals that were settled inside it — those belong to this
 * container, not to the timeline around it, and they render as their own rows
 * in this rail so a run keeps ONE header across every gated call instead of
 * one header per call. Only an open gate is hoisted by `splitAtVisibleRows`,
 * and only because its Allow/Deny must stay reachable with this rail folded.
 * `gate` is that open interruption, handed over by `AssistantTurn`: while it
 * waits the rail says which kind of wait it is. With no gate after it, the
 * verdict this container ended on is the last approval it absorbed, and that
 * is carried back in the header — folded, the rail is hidden and the header
 * is the only part of this container the user reads. `isLast`
 * marks the
 * container that owns the turn's final reply — earlier ones were closed by an
 * interruption, so they own no reply and no footer.
 */
export function AgentSegment({
  parts,
  replyText = '',
  streaming = false,
  stopped = false,
  error = false,
  errorCode = '',
  isLast = true,
  gate = null,
  speaker = null,
  delegates = null,
  agentMaxHeight = null,
  onApproval = null,
  onTrustWorkspace = null,
  trustBusy = false,
  trustNote = '',
}) {
  const groups = groupAssistantParts(parts);
  // Normalize before deciding what to show — leaked <tool_call> dumps break
  // markdown/HTML rendering, and fences glued to prose (`as-is.```) leak
  // literal backticks. Real tool rows in `parts` stay as-is.
  const displayReply = normalizeChatMarkdown(replyText);
  const hasProgress = parts.length > 0 || (streaming && !displayReply);
  const lastPart = parts[parts.length - 1];
  const thinkingStream = Boolean(
    streaming && !displayReply && (lastPart?.type === 'thinking' || !parts.length),
  );
  // Error turns carry the failure text in `replyText` but must not render it as
  // a normal assistant reply — AgentErrorCard owns that body.
  const hasReply = Boolean(!error && displayReply && displayReply !== '(empty response)');
  // The gate this container's work stopped at, as far as its header is
  // concerned: a pending one is still the user's turn, so the rail says which
  // kind of wait it is. A settled one is NOT handed back to the header — its
  // verdict row already sits inside this container's rail, and the header
  // would only repeat it. So the header carries a phrase back for questions
  // only, and an approval contributes nothing beyond its label while open.
  const awaitingApproval =
    streaming && gate?.kind === 'approval' && gate.approval?.status === 'pending';
  const awaitingAsk = streaming && gate?.kind === 'ask' && gate.ask?.status === 'pending';
  // Nothing is reconstructed from `parts` here: an approval absorbed by this
  // run states itself in the rail below, so the header stays free of verdict
  // text. `gate` only ever contributes for a settled question.
  const carryBack = gateCarryBack(gate);
  const [open, setOpen] = useState(true);
  const followKey = [
    parts.length,
    replyText.length,
    groups.map((g) => {
      if (g.type === 'thinking') return `t:${(g.text || '').length}`;
      if (g.type === 'approval') return `a:${g.approval?.id}:${g.approval?.status}`;
      // Same token rule as approvals: an ask that opens, gets answered or times
      // out must change this key, or the clipped block never re-pins and its
      // answer list stays buried under the bottom fade.
      if (g.type === 'ask') return `q:${g.ask?.id}:${g.ask?.status}`;
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
  const stepBits = [];
  if (thoughtCount) stepBits.push(thoughtCount === 1 ? '1 thought' : `${thoughtCount} thoughts`);
  if (toolCount) stepBits.push(toolCount === 1 ? '1 tool' : `${toolCount} tools`);
  const stepSummary = stepBits.join(' · ');

  // The user pressed Stop: the partial reply is kept but labelled, so it is
  // never read as a finished answer. Speaker role/provider wins the idle name
  // so a merged orchestrated transcript reads as a group of distinct agents.
  const roleLabel = speakerRoleLabel(speaker);
  const harness = speakerHarness(speaker);
  const modelLabel = shortModelLabel(speaker?.model);
  const isOrchestrator = String(speaker?.role || '').trim().toLowerCase() === 'orchestrator';
  const idleName = roleLabel
    ? roleLabel.replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Agent';
  const label = streaming
    ? awaitingApproval
      ? 'Awaiting approval…'
      : awaitingAsk
        ? 'Awaiting answer…'
        : hasReply
          ? `${idleName}…`
          : hasProgress
            ? 'Working…'
            : 'Thinking…'
    : error
      ? 'Failed'
      : stopped
        ? 'Stopped'
        : idleName;
  const providerTitle = isOrchestrator
    ? 'Orchestrator · chat group'
    : harness
      ? (HARNESS_NAMES[harness] || harness)
      : '';
  const markClass = `mt-0.5 ${streaming ? 'text-gray-400' : error ? 'text-rose-400' : 'text-gray-500 group-hover:text-gray-400'}`;

  // Error-only turns (no thinking/tools) skip the collapsible rail — the card
  // below is the whole row. Mid-turn failures keep the rail so prior work stays.
  if (error && !hasProgress) {
    return (
      <AssistantBubble speaker={speaker}>
        <div className="text-sm">
          <AgentErrorCard
            text={replyText}
            code={errorCode}
            onTrustWorkspace={onTrustWorkspace}
            trustBusy={trustBusy}
            trustNote={trustNote}
          />
        </div>
      </AssistantBubble>
    );
  }

  return (
    <AssistantBubble speaker={speaker}>
      <div className="text-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-black/20"
          aria-expanded={open}
        >
          <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
          {harness ? (
            <HarnessLogo
              harness={harness}
              size="h-4 w-4"
              className={markClass}
              title={providerTitle || null}
            />
          ) : (
            <AgentIcon className={markClass} />
          )}
          {streaming ? (
            <StatusGlyph
              // Only an OPEN gate is hoisted out of this rail; the container
              // that paused at one still names which kind of wait it is.
              status={
                awaitingApproval
                  ? 'awaiting_approval'
                  : awaitingAsk
                    ? 'awaiting_answer'
                    : 'running'
              }
              className="mt-0.5"
            />
          ) : error ? (
            <StatusGlyph status="error" className="mt-0.5" />
          ) : null}
          <span className={`min-w-0 flex-1 truncate ${streaming ? 'chat-shimmer text-gray-300' : error ? 'text-rose-300' : 'text-gray-300'}`}>
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
            {carryBack ? (
              <span className={`ml-1.5 shrink-0 ${carryBack.className}`}>
                {' '}
                <span className="text-gray-700">·</span> {carryBack.text}
              </span>
            ) : null}
          </span>
          {modelLabel ? (
            <span
              className="mt-0.5 max-w-[40%] shrink-0 truncate font-mono text-[10px] text-gray-600"
              title={String(speaker?.model || modelLabel)}
            >
              {modelLabel}
            </span>
          ) : null}
        </button>

        {open ? (
          <ClippedGrow
            maxHeightPx={agentMaxHeight}
            follow={streaming}
            followKey={followKey}
            className="mt-1.5 ml-1 border-l border-gray-800/80 pl-3"
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
                    // An ask keeps its own hoisted row: it is the user's turn,
                    // and an answered one is followed by their reply bubble.
                    // A settled approval is part of this run, so it renders
                    // here — the same one-line verdict row, nested like a tool
                    // row, so the thread still names every gated call this run
                    // made and how the rule settled it.
                    if (group.type === 'approval') {
                      return (
                        <ApprovalBlock key={`approval-${index}`} approval={group.approval} />
                      );
                    }
                    return null;
                  })}
                  {thinkingStream && lastPart?.type !== 'thinking' && lastPart?.type !== 'approval' && lastPart?.type !== 'ask' ? (
                    <ThinkingBlock text="" streaming />
                  ) : null}
                </div>
              ) : null}

            </div>
          </ClippedGrow>
        ) : null}

        {/* The reply sits OUTSIDE the clipped thinking rail: thinking, tools and
            settled approval verdicts collapse/fade/scroll inside it, while an
            open gate, a question and an answer never do — splitAtVisibleRows
            hoists those into separate visible rows, so the buttons of a gate the
            user still has to answer are always reachable. A container closed by
            such an interruption owns no reply at all: that exchange ended with
            the user, so it gets no footer. */}
        {error ? (
          <AgentErrorCard
            text={replyText}
            code={errorCode}
            onTrustWorkspace={onTrustWorkspace}
            trustBusy={trustBusy}
            trustNote={trustNote}
          />
        ) : hasReply ? (
          <div className="mt-2">
            {looksLikeMarkdown(displayReply) || streaming ? (
              <MarkdownBody text={displayReply} variant="chat" />
            ) : (
              <div className="text-sm leading-relaxed whitespace-pre-wrap text-gray-200">
                {displayReply}
              </div>
            )}
          </div>
        ) : !isLast ? null : streaming ? null : hasProgress ? (
          <p className="mt-2 text-sm text-gray-500">
            No visible reply — expand thinking or tool rows above.
          </p>
        ) : (
          <p className="mt-2 text-sm text-gray-500">(empty response)</p>
        )}
        {/* Handoff brief — fine print on the orchestrator turn, not its own section. */}
        {isLast ? <DelegateFinePrintList delegates={delegates} /> : null}
      </div>
    </AssistantBubble>
  );
}
