import { useEffect, useMemo, useState } from 'react';
import { previewLine } from '#ui/shared/lib/chatText.js';

/** Show the rail once there are enough prompts to make jumping useful. */
const MIN_TURNS = 3;

function turnSelector(id) {
  const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(String(id))
    : String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[data-kusa-turn="${safe}"]`;
}

function turnPreview(msg) {
  const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
  if (text) return previewLine(text, 96);
  const files = Array.isArray(msg?.attachments) ? msg.attachments.filter(Boolean) : [];
  if (files.length) {
    return files.length === 1 ? '(1 file attached)' : `(${files.length} files attached)`;
  }
  return 'Empty prompt';
}

/**
 * Build the jump list from the live transcript: one entry per user prompt
 * (ChatGPT-style), in chat order. Assistant / meta / live rows are skipped —
 * jumping to the prompt that opened the exchange is the useful target.
 */
export function buildChatMinimapTurns(messages = []) {
  const turns = [];
  for (const msg of messages) {
    if (!msg || msg.role !== 'user' || !msg.id) continue;
    turns.push({
      id: String(msg.id),
      preview: turnPreview(msg),
    });
  }
  return turns;
}

/**
 * Right-edge turn navigator — thin bars, hover preview, click to jump.
 * Sits outside the transcript scrollport so it stays fixed while the chat moves.
 */
export function ChatMinimap({
  panelRef,
  turns = [],
  sessionKey = '',
  onJump = null,
}) {
  const turnIds = useMemo(() => turns.map((t) => t.id).join('|'), [turns]);
  const [activeId, setActiveId] = useState(turns[turns.length - 1]?.id || '');
  const [hoveredId, setHoveredId] = useState(null);

  useEffect(() => {
    setHoveredId(null);
  }, [sessionKey]);

  useEffect(() => {
    setActiveId((prev) => {
      if (prev && turns.some((turn) => turn.id === prev)) return prev;
      return turns[turns.length - 1]?.id || '';
    });
  }, [sessionKey, turnIds, turns]);

  useEffect(() => {
    const panel = panelRef?.current;
    if (!panel || turns.length < MIN_TURNS) return undefined;

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
  }, [panelRef, sessionKey, turnIds, turns]);

  if (turns.length < MIN_TURNS) return null;

  function jump(id) {
    const panel = panelRef?.current;
    const el = panel?.querySelector(turnSelector(id));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
    onJump?.(id);
  }

  return (
    <nav
      aria-label="Jump to a prompt in this chat"
      className="pointer-events-none absolute inset-y-0 right-3.5 z-30 flex w-7 items-center justify-center"
      onMouseLeave={() => setHoveredId(null)}
    >
      {/*
       * Fixed to the chat shell (not inside the scrollport): compact mid-right
       * cluster that stays put while the transcript moves, inset so it sits
       * left of the native scrollbar.
       */}
      <div className="pointer-events-auto flex w-full flex-col items-center gap-1 overflow-visible py-1">
        {turns.map((turn, index) => {
          const active = turn.id === activeId;
          const hot = turn.id === hoveredId;
          return (
            <div key={turn.id} className="relative flex w-full shrink-0 justify-center">
              <button
                type="button"
                title={turn.preview}
                aria-label={`Jump to prompt ${index + 1}: ${turn.preview}`}
                aria-current={active ? 'true' : undefined}
                onMouseEnter={() => setHoveredId(turn.id)}
                onFocus={() => setHoveredId(turn.id)}
                onBlur={() => setHoveredId((id) => (id === turn.id ? null : id))}
                onClick={() => jump(turn.id)}
                className={`block h-0.5 shrink-0 rounded-full transition-[width,background-color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  active
                    ? 'w-3.5 bg-emerald-400'
                    : hot
                      ? 'w-3 bg-gray-300'
                      : 'w-2.5 bg-gray-600/80 hover:bg-gray-400'
                }`}
              />
              {hot ? (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute right-full top-1/2 z-40 mr-1.5 w-56 -translate-y-1/2 rounded-md border border-gray-700 bg-gray-950/95 px-2.5 py-1.5 text-left shadow-lg shadow-black/40 backdrop-blur"
                >
                  <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
                    Prompt {index + 1}
                  </p>
                  <p className="mt-0.5 line-clamp-3 text-xs leading-snug text-gray-200">
                    {turn.preview}
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
