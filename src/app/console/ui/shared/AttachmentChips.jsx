import {
  ATTACHMENT_LIMITS,
  attachmentLabel,
  formatBytes,
} from '#ui/shared/lib/attachments.js';
import { PaperclipIcon } from '#ui/features/chat/ChatGlyphs.jsx';

/**
 * The chips that name what is attached to a message.
 *
 * One component serves both places a message appears: the composer (the files
 * staged for the prompt being typed) and the transcript (the files a sent
 * prompt carried). Same names, same notes, same caps — so the two can never
 * disagree about what was actually sent, which is the whole point of showing
 * them: a user reading a chip is reading the record, not a promise.
 *
 * A chip states what WILL happen rather than what was intended:
 *  - a picture the picked model cannot see is marked "not seen by this model",
 *    because a text-only endpoint (and OpenCode, which takes a prompt string)
 *    never receives it as an image part;
 *  - a file the browser could not read carries the note the reader wrote
 *    (`fileToAttachment`), so a name with no bytes is shown as a reference.
 * Nothing here is invented: an attachment with neither bytes nor a note says
 * "name only", which is what the model will be told.
 *
 * The row is a list, so a screen reader hears the count and each name; the
 * count line is the same number the composer's summary states.
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
  className = 'flex flex-wrap items-center gap-1.5',
}) {
  const files = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  if (!files.length) return null;
  return (
    <div
      role="list"
      aria-label={`Attached files: ${files.length}`}
      className={`text-[10px] ${className}`}
    >
      <span className="text-gray-500">
        {`${files.length} of ${ATTACHMENT_LIMITS.files} files on this message`}
      </span>
      {files.map((attachment) => {
        const isImage = attachment?.kind === 'image' && attachment?.dataUrl;
        // What will NOT reach the model, and why — the same rule the loop
        // applies, stated here before the user sends.
        const unseen = Boolean(isImage) && !imagesReachModel;
        const nameOnly = !attachment?.dataUrl && !attachment?.text;
        return (
          <span
            key={`${attachment?.name || 'file'}:${attachment?.size || 0}`}
            role="listitem"
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${
              unseen
                ? 'border-rose-500/60 text-rose-300'
                : 'border-gray-700 bg-gray-900 text-gray-300'
            }`}
          >
            <PaperclipIcon className={unseen ? 'text-rose-300' : 'text-gray-400'} />
            <span className="font-medium">{attachmentLabel(attachment)}</span>
            <span className="mx-1 text-gray-500 tabular-nums">
              {formatBytes(Number(attachment?.size) || 0)}
            </span>
            {unseen ? (
              <span className="ml-1 text-rose-400">not seen by this model</span>
            ) : nameOnly ? (
              <span className="ml-1 text-gray-500">{attachment?.note || 'name only'}</span>
            ) : null}
          </span>
        );
      })}
      {note ? <span className="ml-1 text-rose-400">{note}</span> : null}
    </div>
  );
}
