import { useEffect, useMemo, useState } from 'react';
import { stringify, toolDetail, truncate } from '#ui/shared/lib/chatText.js';
import {
  BrainIcon,
  Chevron,
  StatusGlyph,
  ToolIcon,
} from './ChatGlyphs.jsx';
import { ClippedGrow } from './ClippedGrow.jsx';

/**
 * Thinking and tool rows — the progressive middle of an assistant turn.
 *
 * Thinking shimmers and collapses; tool calls stream as rows with clipped input
 * and output. Row state stays with the turn (see TranscriptTurns.jsx), which
 * calls these renderers with the data it already has.
 */
export const THINKING_CLIP_PX = 192; // ~max-h-48

export const TOOL_INPUT_CLIP_PX = 112; // ~max-h-28

export const TOOL_OUTPUT_CLIP_PX = 144; // ~max-h-36

export function ThinkingBlock({ text, streaming }) {
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

export function ToolGroupBlock({ tools }) {
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

export function ToolCallRow({ tool, nested = false }) {
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
