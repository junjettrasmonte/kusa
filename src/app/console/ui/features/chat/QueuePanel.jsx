import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PopupList } from './PopupList.jsx';
import { previewLine, truncate } from '#ui/shared/lib/chatText.js';
import {
  ArrowUpIcon,
  DragHandleIcon,
  EditIcon,
  PauseIcon,
  ResumeIcon,
  TrashIcon,
} from './ChatGlyphs.jsx';

/**
 * Prompt Queue rows — the composer's queued/steering prompt list.
 *
 * The switch and the auto-collapse decision stay with ChatHarness (see PopupList.jsx);
 * this file renders the box and its rows. The box is height-capped, never item-capped:
 * every queued prompt is listed and the stack scrolls inside its own box, so a long
 * queue can never push the composer or the transcript away.
 */
// Compact one-line rows; ~6–7 visible before the list scrolls.
export const QUEUE_MAX_HEIGHT_PX = 168;

export const QUEUE_PREVIEW_CHARS = 96;

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
export function QueueGap({ active = false }) {
  // Fixed-height slot between rows so the indicator sits in the space, not on a card.
  return (
    <div className="flex h-2 items-center px-1" aria-hidden="true">
      {active ? (
        <div className="h-0.5 w-full rounded-full bg-emerald-400 shadow-[0_0_0_1px_rgba(106,144,220,0.25)]" />
      ) : (
        <div className="h-px w-full bg-gray-800/90" />
      )}
    </div>
  );
}

export function QueueStack({ held, steering, sessionKey, onQueue, expanded = true }) {
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
 * One held prompt. "Send now" moves it into the running turn — the loop polls
 * the queue per streamed chunk, so the prompt interrupts the model call in
 * flight and the agent reacts to it right away; "Edit" rewrites the held text
 * in place — same id, same position, same carried options — so the user can fix
 * a prompt before it is sent; "Remove" takes it out of the queued list. The
 * server owns the list, so every action just calls the queue endpoint and the
 * next snapshot re-renders this block.
 *
 * Actions are icon buttons flushed to the right edge of the card — the label
 * stays in title/aria-label so the row keeps its meaning without words. The
 * pencil is offered on every row: the list is either fully shown or not shown
 * at all, so there is no thinned row that has to drop it. In edit mode the
 * card body becomes a textarea seeded with the held
 * prompt, so the rewrite happens in place rather than by resending it.
 */
export function QueuedPromptCard({
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
      <p className={`min-w-0 flex-1 truncate text-[12px] leading-tight ${paused ? 'text-gray-500' : 'text-gray-300'}`}>
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
