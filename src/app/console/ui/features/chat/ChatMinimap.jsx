import { useEffect, useMemo, useState } from 'react';
import { previewLine } from '#ui/shared/lib/chatText.js';
import { ChevronDownIcon, ChevronUpIcon } from './ChatGlyphs.jsx';
import {
  roleDisplayName,
  roleVisual,
  USER_MINIMAP_PEG,
} from './roleVisuals.js';

function turnSelector(id) {
  const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(String(id))
    : String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[data-kusa-turn="${safe}"]`;
}

function turnPreview(msg) {
  const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
  if (text) return previewLine(text, 96);
  if (msg?.role === 'assistant') {
    return roleDisplayName(msg?.speaker?.role) || 'Agent reply';
  }
  const files = Array.isArray(msg?.attachments) ? msg.attachments.filter(Boolean) : [];
  if (files.length) {
    return files.length === 1 ? '(1 file attached)' : `(${files.length} files attached)`;
  }
  return 'Empty prompt';
}

/**
 * Build the jump list from the live transcript: one peg per user prompt and
 * each assistant turn, in chat order. Meta / delegate rows stay out — they are
 * not places you jump to read.
 */
export function buildChatMinimapTurns(messages = []) {
  const turns = [];
  for (const msg of messages) {
    if (!msg?.id) continue;
    if (msg.role === 'user') {
      turns.push({
        id: String(msg.id),
        kind: 'user',
        label: 'You',
        preview: turnPreview(msg),
        pegClass: USER_MINIMAP_PEG,
      });
      continue;
    }
    if (msg.role !== 'assistant') continue;
    const role = msg.speaker?.role || '';
    turns.push({
      id: String(msg.id),
      kind: 'assistant',
      label: roleDisplayName(role),
      preview: turnPreview(msg),
      pegClass: roleVisual(role).peg,
    });
  }
  return turns;
}

/**
 * Right-edge turn navigator — thin bars, hover preview, click to jump.
 * Sits outside the transcript scrollport so it stays fixed while the chat moves.
 * Shown only while the transcript scrollbar is active (content overflows).
 */
export function ChatMinimap({
  panelRef,
  turns = [],
  sessionKey = '',
  onJump = null,
  onVisibleChange = null,
}) {
  const turnIds = useMemo(() => turns.map((t) => t.id).join('|'), [turns]);
  const [scrollable, setScrollable] = useState(false);
  const [activeId, setActiveId] = useState(turns[turns.length - 1]?.id || '');
  const [hoveredId, setHoveredId] = useState(null);
  const visible = scrollable && turns.length > 0;

  useEffect(() => {
    setHoveredId(null);
  }, [sessionKey]);

  useEffect(() => {
    setActiveId((prev) => {
      if (prev && turns.some((turn) => turn.id === prev)) return prev;
      return turns[turns.length - 1]?.id || '';
    });
  }, [sessionKey, turnIds, turns]);

  // Appear only when the transcript can actually scroll — not by turn count.
  useEffect(() => {
    const panel = panelRef?.current;
    if (!panel) {
      setScrollable(false);
      return undefined;
    }

    const measure = () => {
      setScrollable(panel.scrollHeight > panel.clientHeight + 1);
    };
    measure();

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(panel);
    if (panel.firstElementChild) ro?.observe(panel.firstElementChild);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [panelRef, sessionKey, turnIds]);

  useEffect(() => {
    onVisibleChange?.(visible);
  }, [visible, onVisibleChange]);

  useEffect(() => {
    const panel = panelRef?.current;
    if (!panel || !visible) return undefined;

    const syncActive = () => {
      const readingLine = panel.getBoundingClientRect().top + Math.min(72, panel.clientHeight * 0.2);
      let next = turns[0]?.id || '';
      for (const turn of turns) {
        const el = panel.querySelector(turnSelector(turn.id));
        if (!el) continue;
        if (el.getBoundingClientRect().top <= readingLine + 8) next = turn.id;
      }
      setActiveId((prev) => (prev === next ? prev : next));
    };

    syncActive();
    panel.addEventListener('scroll', syncActive, { passive: true });
    window.addEventListener('resize', syncActive);
    return () => {
      panel.removeEventListener('scroll', syncActive);
      window.removeEventListener('resize', syncActive);
    };
  }, [panelRef, sessionKey, turnIds, turns, visible]);

  if (!visible) return null;

  const firstId = turns[0]?.id || '';
  const lastId = turns[turns.length - 1]?.id || '';

  function jump(id) {
    const panel = panelRef?.current;
    const el = panel?.querySelector(turnSelector(id));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
    onJump?.(id);
  }

  function jumpToStart() {
    if (!firstId) return;
    jump(firstId);
  }

  function jumpToLatest() {
    const panel = panelRef?.current;
    if (!panel) return;
    // Match the old floating control: land at the true bottom, not just the
    // last peg's top edge, so the newest reply + composer gap are in view.
    panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
    if (lastId) setActiveId(lastId);
    onJump?.(lastId);
  }

  return (
    <nav
      aria-label="Jump to a turn in this chat"
      className="pointer-events-none absolute inset-y-0 right-3.5 z-30 flex w-7 items-center justify-center"
      onMouseLeave={() => setHoveredId(null)}
    >
      {/*
       * Fixed to the chat shell (not inside the scrollport): compact mid-right
       * cluster that stays put while the transcript moves, inset so it sits
       * left of the native scrollbar. Chevron up/down bookend the pegs for
       * jump-to-first and jump-to-latest; assistant pegs use the agent color.
       */}
      <div className="pointer-events-auto flex w-full flex-col items-center gap-1 overflow-visible py-1">
        <button
          type="button"
          title="Jump to the first turn"
          aria-label="Jump to the first turn"
          onClick={jumpToStart}
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-gray-500 transition-colors hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
        >
          <ChevronUpIcon className="h-3 w-3" />
        </button>
        {turns.map((turn) => {
          const active = turn.id === activeId;
          const hot = turn.id === hoveredId;
          return (
            <div key={turn.id} className="relative flex w-full shrink-0 justify-center">
              <button
                type="button"
                title={`${turn.label}: ${turn.preview}`}
                aria-label={`Jump to ${turn.label}: ${turn.preview}`}
                aria-current={active ? 'true' : undefined}
                onMouseEnter={() => setHoveredId(turn.id)}
                onFocus={() => setHoveredId(turn.id)}
                onBlur={() => setHoveredId((id) => (id === turn.id ? null : id))}
                onClick={() => jump(turn.id)}
                className={`block h-0.5 shrink-0 rounded-full transition-[width,opacity] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${turn.pegClass} ${
                  active
                    ? 'w-3.5 opacity-100'
                    : hot
                      ? 'w-3 opacity-90'
                      : 'w-2.5 opacity-55 hover:opacity-80'
                }`}
              />
              {hot ? (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute right-full top-1/2 z-40 mr-1.5 w-56 -translate-y-1/2 rounded-md border border-gray-700 bg-gray-950/95 px-2.5 py-1.5 text-left shadow-lg shadow-black/40 backdrop-blur"
                >
                  <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
                    {turn.label}
                  </p>
                  <p className="mt-0.5 line-clamp-3 text-xs leading-snug text-gray-200">
                    {turn.preview}
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          title="Jump to the latest turn"
          aria-label="Jump to the latest turn"
          onClick={jumpToLatest}
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-gray-500 transition-colors hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
        >
          <ChevronDownIcon className="h-3 w-3" />
        </button>
      </div>
    </nav>
  );
}
