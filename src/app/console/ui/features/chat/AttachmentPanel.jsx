import { useMemo, useState } from 'react';
import {
  ATTACHMENT_LIMITS,
  attachmentLabel,
  formatBytes,
} from '#ui/shared/lib/attachments.js';
import { PaperclipIcon } from '#ui/features/chat/ChatGlyphs.jsx';
import { ImageViewer } from '#ui/shared/ImageViewer.jsx';
import { PopupList } from './PopupList.jsx';

/**
 * Attachments drawer — the same PopupList control as the Prompt Queue and Task
 * List, listing the files staged for THIS draft above the composer. State stays
 * with SessionChat; this panel renders rows, selection, remove, and the image
 * viewer. Off or empty renders nothing (PopupList), so an idle slot stays empty.
 *
 * Transcript still uses AttachmentChips under a sent user bubble — that surface
 * is a compact chip strip, not this drawer.
 */
export const ATTACHMENT_MAX_HEIGHT_PX = 168;

export function AttachmentStack({
  attachments = [],
  expanded = true,
  imagesReachModel = true,
  note = '',
  onChange = null,
  dock = 'bottom',
  onDockToggle = null,
  onClose = null,
}) {
  const files = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  const [selected, setSelected] = useState(() => new Set());
  const [viewer, setViewer] = useState(null); // { src, name } | null

  const selectedKeys = useMemo(() => {
    const keys = new Set(files.map(attachmentKey));
    const next = new Set();
    for (const key of selected) {
      if (keys.has(key)) next.add(key);
    }
    return next;
  }, [files, selected]);

  const total = files.length;
  if (!total || !expanded) return null;

  function toggleSelect(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function removeSelected() {
    if (!onChange || !selectedKeys.size) return;
    const kept = files.filter((attachment) => !selectedKeys.has(attachmentKey(attachment)));
    setSelected(new Set());
    onChange(kept);
  }

  function openImage(attachment) {
    if (attachment?.kind !== 'image' || !attachment?.dataUrl) return;
    setViewer({ src: attachment.dataUrl, name: attachment.name || 'image' });
  }

  const summary = `${total} of ${ATTACHMENT_LIMITS.files} file${ATTACHMENT_LIMITS.files === 1 ? '' : 's'} on this message`;

  return (
    <>
      <PopupList
        expanded={expanded}
        count={total}
        maxHeightPx={ATTACHMENT_MAX_HEIGHT_PX}
        summary={summary}
        ariaLabel="Staged attachments"
        dock={dock}
        onDockToggle={onDockToggle}
        onClose={onClose}
      >
        <div className="flex flex-wrap items-center gap-1.5 pb-1">
          {selectedKeys.size ? (
            <button
              type="button"
              onClick={removeSelected}
              className="rounded-md border border-rose-500/50 px-1.5 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50"
            >
              {`Remove ${selectedKeys.size} selected`}
            </button>
          ) : (
            <span className="text-[10px] text-gray-600">Select files to remove them from this message</span>
          )}
          {note ? <span className="text-[10px] text-rose-400">{note}</span> : null}
        </div>
        {files.map((attachment) => {
          const key = attachmentKey(attachment);
          return (
            <AttachmentRow
              key={key}
              attachment={attachment}
              selected={selectedKeys.has(key)}
              imagesReachModel={imagesReachModel}
              onToggleSelect={() => toggleSelect(key)}
              onOpenImage={() => openImage(attachment)}
            />
          );
        })}
      </PopupList>
      <ImageViewer
        open={Boolean(viewer)}
        src={viewer?.src || ''}
        name={viewer?.name || 'image'}
        onClose={() => setViewer(null)}
      />
    </>
  );
}

/**
 * One staged file: checkbox, paperclip/thumb, name, size, and notes. Image rows
 * open the shared ImageViewer (zoom / fit / actual size via its context menu).
 */
function AttachmentRow({
  attachment,
  selected = false,
  imagesReachModel = true,
  onToggleSelect,
  onOpenImage,
}) {
  const isImage = attachment?.kind === 'image' && attachment?.dataUrl;
  const unseen = Boolean(isImage) && !imagesReachModel;
  const nameOnly = !attachment?.dataUrl && !attachment?.text;
  const label = attachmentLabel(attachment);

  return (
    <div
      role="listitem"
      className={`flex h-7 items-center gap-1.5 px-1 hover:bg-gray-900/40 ${
        unseen ? 'text-rose-300' : selected ? 'bg-emerald-500/10 text-emerald-100' : 'text-gray-300'
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${label}`}
        className="h-3 w-3 shrink-0 rounded border-gray-600 bg-gray-950 text-emerald-500 focus:ring-emerald-500/40"
      />
      <PaperclipIcon className={unseen ? 'h-3 w-3 shrink-0 text-rose-300' : 'h-3 w-3 shrink-0 text-gray-400'} />
      {isImage ? (
        <button
          type="button"
          onClick={onOpenImage}
          title="View image"
          className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
        >
          {attachment.dataUrl ? (
            <img
              src={attachment.dataUrl}
              alt=""
              className="h-4 w-4 shrink-0 rounded-sm object-cover"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[12px] leading-tight font-medium hover:underline">
            {label}
          </span>
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[12px] leading-tight font-medium">{label}</span>
      )}
      <span className="shrink-0 tabular-nums text-[10px] text-gray-500">
        {formatBytes(Number(attachment?.size) || 0)}
      </span>
      {unseen ? (
        <span className="ml-1 shrink-0 text-[9px] uppercase tracking-wide text-rose-400">
          not seen
        </span>
      ) : nameOnly ? (
        <span className="ml-1 max-w-[8rem] shrink-0 truncate text-[9px] text-gray-500">
          {attachment?.note || 'name only'}
        </span>
      ) : null}
    </div>
  );
}

function attachmentKey(attachment) {
  return `${attachment?.name || 'file'}:${attachment?.size || 0}:${attachment?.file || ''}`;
}
