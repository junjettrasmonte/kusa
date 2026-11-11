import { useMemo, useState } from 'react';
import {
  ATTACHMENT_LIMITS,
  attachmentLabel,
  formatBytes,
} from '#ui/shared/lib/attachments.js';
import { PaperclipIcon } from '#ui/features/chat/ChatGlyphs.jsx';
import { ImageViewer } from '#ui/shared/ImageViewer.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

/**
 * Compact attachment chips for a transcript user bubble (read-only by default).
 *
 * The composer's staged files live in the Attachments PopupList drawer
 * (AttachmentPanel.jsx) — same shape, same notes, same ImageViewer — so a sent
 * message and the files that made it can never disagree. This component is the
 * chip strip under a bubble, not that drawer.
 *
 * When `editable` is set (rare outside tests), rows are selectable and Remove
 * drops the selected files; an image row opens the image viewer popup (zoom /
 * fit / actual size via its context-menu icon).
 *
 * A row states what WILL happen rather than what was intended:
 *  - a picture the picked model cannot see is marked "not seen by this model";
 *  - a file the browser could not read carries the note the reader wrote.
 */
export function AttachmentChips({
  attachments = [],
  // Whether an image can reach the model the composer picked. The caller owns
  // that judgement (it knows the picked model and the backend); unknown counts
  // as "may see", matching the agent loop's own rule.
  imagesReachModel = true,
  // Why the last Add Files / Paste did not add what the user expected. Never
  // invented by this component — an empty string renders nothing.
  note = '',
  className = 'flex flex-col gap-1.5',
  // Composer only: allow select + remove. Transcript leaves this false.
  editable = false,
  onChange = null,
}) {
  const files = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  const [selected, setSelected] = useState(() => new Set());
  const [viewer, setViewer] = useState(null); // { src, name } | null

  // Drop selection entries that no longer exist after a remove / parent reset.
  const selectedKeys = useMemo(() => {
    const keys = new Set(files.map(attachmentKey));
    const next = new Set();
    for (const key of selected) {
      if (keys.has(key)) next.add(key);
    }
    return next;
  }, [files, selected]);

  if (!files.length) return null;

  const jiraOnly = files.every(
    (row) => row?.kind === 'jira' && String(row?.issueKey || '').trim(),
  );

  function toggleSelect(key) {
    if (!editable) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function removeSelected() {
    if (!editable || !onChange || !selectedKeys.size) return;
    const kept = files.filter((attachment) => !selectedKeys.has(attachmentKey(attachment)));
    setSelected(new Set());
    onChange(kept);
  }

  function openImage(attachment) {
    if (attachment?.kind !== 'image' || !attachment?.dataUrl) return;
    setViewer({ src: attachment.dataUrl, name: attachment.name || 'image' });
  }

  function openJira(attachment) {
    const issueKey = String(attachment?.issueKey || '').replace(/^:/, '').trim();
    if (!issueKey || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('kusa:open-jira-issue', {
      detail: { issueKey },
    }));
  }

  const jiraChipLabel = (attachment) => {
    const key = String(attachment?.issueKey || '').replace(/^:/, '').trim();
    return key || attachmentLabel(attachment);
  };
  const showCount = !jiraOnly;
  const showRemove = editable && selectedKeys.size > 0;
  const showHeader = showCount || showRemove || Boolean(note);

  return (
    <div
      role="list"
      aria-label={jiraOnly
        ? `Jira ticket${files.length === 1 ? '' : 's'}: ${files.map(jiraChipLabel).join(', ')}`
        : `Attached files: ${files.length}`}
      className={`text-[10px] ${className}`}
    >
      {showHeader ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {showCount ? (
            <span className="text-gray-500">
              {`${files.length} of ${ATTACHMENT_LIMITS.files} files on this message`}
            </span>
          ) : null}
          {showRemove ? (
            <button
              type="button"
              onClick={removeSelected}
              className="rounded-md border border-rose-500/50 px-1.5 py-0.5 text-rose-300 hover:bg-rose-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50"
            >
              {`Remove ${selectedKeys.size} selected`}
            </button>
          ) : null}
          {note ? <span className="text-rose-400">{note}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map((attachment) => {
          const key = attachmentKey(attachment);
          const isImage = attachment?.kind === 'image' && attachment?.dataUrl;
          const isJira = attachment?.kind === 'jira' && String(attachment?.issueKey || '').trim();
          const unseen = Boolean(isImage) && !imagesReachModel;
          const nameOnly = !attachment?.dataUrl && !attachment?.text;
          const isSelected = selectedKeys.has(key);
          return (
            <div
              key={key}
              role="listitem"
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${
                unseen
                  ? 'border-rose-500/60 text-rose-300'
                  : isJira
                    ? 'border-sky-500/50 bg-sky-500/10 text-sky-100'
                    : isSelected
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-100'
                      : 'border-gray-700 bg-gray-900 text-gray-300'
              }`}
            >
              {editable ? (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(key)}
                  aria-label={`Select ${isJira ? jiraChipLabel(attachment) : attachmentLabel(attachment)}`}
                  className="h-3 w-3 shrink-0 rounded border-gray-600 bg-gray-950 text-emerald-500 focus:ring-emerald-500/40"
                />
              ) : null}
              {isJira ? (
                <LucideIcon name="clipboard-list" className="h-3 w-3 shrink-0 text-sky-300" />
              ) : (
                <PaperclipIcon className={unseen ? 'text-rose-300' : 'text-gray-400'} />
              )}
              {isImage ? (
                <button
                  type="button"
                  onClick={() => openImage(attachment)}
                  title="View image"
                  className="inline-flex items-center gap-1 font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                >
                  <span className="max-w-[10rem] truncate">{attachmentLabel(attachment)}</span>
                  {attachment.dataUrl ? (
                    <img
                      src={attachment.dataUrl}
                      alt=""
                      className="h-4 w-4 rounded-sm object-cover"
                    />
                  ) : null}
                </button>
              ) : isJira ? (
                <button
                  type="button"
                  onClick={() => openJira(attachment)}
                  title={`Open ${jiraChipLabel(attachment)}`}
                  className="inline-flex max-w-[12rem] items-center gap-1 font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50"
                >
                  <span className="truncate">{jiraChipLabel(attachment)}</span>
                </button>
              ) : (
                <span className="max-w-[10rem] truncate font-medium">{attachmentLabel(attachment)}</span>
              )}
              {!isJira ? (
                <span className="mx-1 text-gray-500 tabular-nums">
                  {formatBytes(Number(attachment?.size) || 0)}
                </span>
              ) : null}
              {unseen ? (
                <span className="ml-1 text-rose-400">not seen by this model</span>
              ) : isJira ? null : nameOnly ? (
                <span className="ml-1 text-gray-500">{attachment?.note || 'name only'}</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <ImageViewer
        open={Boolean(viewer)}
        src={viewer?.src || ''}
        name={viewer?.name || 'image'}
        onClose={() => setViewer(null)}
      />
    </div>
  );
}

function attachmentKey(attachment) {
  if (attachment?.kind === 'jira' && attachment?.issueKey) {
    return `jira:${attachment.issueKey}`;
  }
  return `${attachment?.name || 'file'}:${attachment?.size || 0}:${attachment?.file || ''}`;
}
