/**
 * Composer attachments — the shape both sides of the wire agree on.
 *
 * The browser reads a selected file (see ui/shared/lib/attachments.js) and hands
 * over a plain record; this module is the reader on the other side, so a
 * hand-edited or truncated record can never smuggle bytes the agent would
 * invent. Nothing here is stored blindly: `dataUrl` only survives on an image,
 * `text` only on a text file, and a file that is neither keeps its name — the
 * note says why, because a name with no bytes is a reference, not content.
 *
 * Caps mirror the browser's, and are enforced again here: the transcript and the
 * queue are hand-editable files, so the limit has to hold on the way back in.
 */
export const ATTACHMENT_LIMITS = {
  files: 5,
  fileBytes: 2 * 1024 * 1024,
  dataUrlChars: 3_000_000,
  textChars: 20_000,
  nameChars: 200,
};

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

/**
 * @param {unknown} raw
 * @returns {null|{name,kind,size,mime?,dataUrl?,text?,note?}}
 */
export function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || '').replace(/[^\S\n]+/g, ' ').trim().slice(0, ATTACHMENT_LIMITS.nameChars);
  if (!name) return null;
  const kind = raw.kind === 'image' || raw.kind === 'text' || raw.kind === 'other'
    ? raw.kind
    : null;
  const mime = String(raw.mime || '').slice(0, 80);
  const resolved = kind || (IMAGE_MIME.test(mime) ? 'image' : 'other');
  const size = Number.isFinite(raw.size) ? Math.max(0, Math.round(raw.size)) : 0;
  const attachment = { name, kind: resolved, size };
  if (mime) attachment.mime = mime;

  if (resolved === 'image') {
    const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl.trim() : '';
    // Only a real inline image counts as content — anything else is a name.
    if (dataUrl && dataUrl.startsWith('data:') && dataUrl.length <= ATTACHMENT_LIMITS.dataUrlChars) {
      attachment.dataUrl = dataUrl;
    } else {
      attachment.note = String(raw.note || 'image not included');
    }
    return attachment;
  }
  if (resolved === 'text') {
    if (typeof raw.text === 'string' && raw.text.length) {
      attachment.text = raw.text.length > ATTACHMENT_LIMITS.textChars
        ? raw.text.slice(0, ATTACHMENT_LIMITS.textChars)
        : raw.text;
    } else if (raw.note) {
      attachment.note = String(raw.note);
    }
    return attachment;
  }
  if (raw.note) attachment.note = String(raw.note);
  return attachment;
}

/**
 * Normalize a whole attachment list: drop junk, keep the first `files` entries,
 * and stop once the total inline payload passes the budget so one oversized
 * pick cannot push the rest of a message off the wire.
 * @param {unknown} raw
 * @returns {Array<object>}
 */
export function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let bytes = 0;
  for (const entry of raw) {
    const attachment = normalizeAttachment(entry);
    if (!attachment) continue;
    const payload = (attachment.dataUrl || attachment.text || '').length;
    if (out.length >= ATTACHMENT_LIMITS.files) continue;
    if (bytes + payload > ATTACHMENT_LIMITS.dataUrlChars * ATTACHMENT_LIMITS.files) continue;
    bytes += payload;
    out.push(attachment);
  }
  return out;
}

/**
 * How many of these can actually be shown to a model that sees images.
 * @param {Array<object>} attachments
 * @returns {{ images: Array<object>, readable: Array<object>, named: Array<object> }}
 */
export function splitAttachments(attachments) {
  const images = [];
  const readable = [];
  const named = [];
  for (const attachment of (attachments || [])) {
    if (attachment?.kind === 'image' && attachment.dataUrl) images.push(attachment);
    else if (typeof attachment?.text === 'string' && attachment.text.trim()) readable.push(attachment);
    else named.push(attachment);
  }
  return { images, readable, named };
}

/**
 * The text half of an attachment payload: labelled blocks the model can read
 * whether or not it can see images.
 * @param {Array<object>} attachments
 * @returns {string} '' when nothing readable is attached
 */
export function attachmentTextBlock(attachments) {
  const { readable, named } = splitAttachments(attachments);
  const blocks = readable.map((attachment) => (
    `Attached file "${attachment.name}" (${attachment.size || attachment.text.length} bytes):\n` +
    '```\n' +
    `${attachment.text}\n` +
    '```'
  ));
  for (const attachment of named) {
    blocks.push(
      `Attached file "${attachment.name}" (${formatBytes(attachment.size)})` +
      (attachment.note ? ` — ${attachment.note}` : ' — contents not included; read it with the file tools if it is in the workspace.'),
    );
  }
  return blocks.join('\n\n');
}

export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/**
 * One-line labels for the UI and the transcript — the same names the composer
 * chips show, so a sent message and its attachment chips can never disagree.
 * @param {Array<object>} attachments
 * @returns {Array<string>}
 */
export function attachmentLabels(attachments) {
  return (attachments || []).map((attachment) => {
    const name = String(attachment?.name || 'file');
    return attachment?.note && !attachment?.dataUrl && !attachment?.text
      ? `${name} (not sent)`
      : name;
  });
}
