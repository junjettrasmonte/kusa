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
 * On disk, bytes live under the session's `attachments/` folder; the transcript
 * keeps a slim record with `file` (basename) so chat.json does not grow with
 * every picture. Readers hydrate `dataUrl` / `text` back from that folder when
 * the agent or the UI needs the bytes.
 *
 * Caps mirror the browser's, and are enforced again here: the transcript and the
 * queue are hand-editable files, so the limit has to hold on the way back in.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { migrateFlatSessionFiles } from '#features/monitor/lib.mjs';

export const ATTACHMENT_LIMITS = {
  files: 5,
  fileBytes: 2 * 1024 * 1024,
  dataUrlChars: 3_000_000,
  textChars: 20_000,
  nameChars: 200,
};

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;
const SAFE_FILE = /[^A-Za-z0-9._-]+/g;

/**
 * @param {unknown} raw
 * @returns {null|{name,kind,size,mime?,dataUrl?,text?,note?,file?}}
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
  // Basename pointer into the session's attachments/ folder. Kept even when the
  // inline payload is present so a later write can skip re-encoding the file.
  const file = sanitizeAttachmentFileName(raw.file);
  if (file) attachment.file = file;

  if (resolved === 'image') {
    const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl.trim() : '';
    // Only a real inline image counts as content — anything else is a name,
    // unless a persisted file will hydrate it on read.
    if (dataUrl && dataUrl.startsWith('data:') && dataUrl.length <= ATTACHMENT_LIMITS.dataUrlChars) {
      attachment.dataUrl = dataUrl;
    } else if (!file) {
      attachment.note = String(raw.note || 'image not included');
    } else if (raw.note) {
      attachment.note = String(raw.note);
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

/** Reject path traversal; keep only a plain basename. */
export function sanitizeAttachmentFileName(raw) {
  const name = basename(String(raw || '').trim());
  if (!name || name === '.' || name === '..') return '';
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return '';
  return name.slice(0, ATTACHMENT_LIMITS.nameChars);
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
    return attachment?.note && !attachment?.dataUrl && !attachment?.text && !attachment?.file
      ? `${name} (not sent)`
      : name;
  });
}

/** Absolute path of a session's attachments/ folder (creates nothing). */
export function sessionAttachmentsDir(dir, sessionId, harness = 'kusa') {
  const name = typeof harness === 'string' && harness.trim() ? harness.trim() : 'kusa';
  const files = migrateFlatSessionFiles(dir, { harness: name, id: sessionId });
  return files.attachments;
}

/**
 * Build a collision-safe basename for an attachment inside attachments/.
 * Keeps a readable stem from the original name and suffixes a short hash of
 * the payload (or a uuid) so two "shot.png" files in one session never clash.
 */
function uniqueAttachmentFileName(attachment, bytes) {
  const original = String(attachment?.name || 'file');
  const ext = extname(original).slice(0, 16);
  const stem = basename(original, ext)
    .replace(SAFE_FILE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'file';
  const digest = bytes && bytes.length
    ? createHash('sha256').update(bytes).digest('hex').slice(0, 10)
    : randomUUID().replace(/-/g, '').slice(0, 10);
  return sanitizeAttachmentFileName(`${stem}-${digest}${ext}`) || `${digest}${ext || '.bin'}`;
}

function dataUrlToBuffer(dataUrl) {
  const raw = String(dataUrl || '');
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(raw);
  if (!match) return null;
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  try {
    return Buffer.from(payload, isBase64 ? 'base64' : 'utf8');
  } catch {
    return null;
  }
}

function bufferToDataUrl(buf, mime) {
  const type = String(mime || 'application/octet-stream');
  return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
}

/**
 * Write one attachment's bytes into the session attachments/ folder and return
 * a slim record (no inline payload). Records that already point at a file and
 * have no new bytes are left alone.
 * @returns {object|null}
 */
export function persistAttachment(dir, sessionId, attachment, harness = 'kusa') {
  const normalized = normalizeAttachment(attachment);
  if (!normalized || !dir || !sessionId) return normalized;
  const folder = sessionAttachmentsDir(dir, sessionId, harness);
  mkdirSync(folder, { recursive: true });

  let bytes = null;
  if (normalized.kind === 'image' && normalized.dataUrl) {
    bytes = dataUrlToBuffer(normalized.dataUrl);
  } else if (normalized.kind === 'text' && typeof normalized.text === 'string') {
    bytes = Buffer.from(normalized.text, 'utf8');
  }

  let fileName = sanitizeAttachmentFileName(normalized.file);
  if (bytes && bytes.length) {
    if (!fileName || !existsSync(join(folder, fileName))) {
      fileName = uniqueAttachmentFileName(normalized, bytes);
    }
    writeFileSync(join(folder, fileName), bytes, { mode: 0o600 });
  } else if (fileName && !existsSync(join(folder, fileName))) {
    // Pointer with no bytes and no file on disk — drop the pointer.
    fileName = '';
  }

  const slim = {
    name: normalized.name,
    kind: normalized.kind,
    size: normalized.size || (bytes ? bytes.length : 0),
  };
  if (normalized.mime) slim.mime = normalized.mime;
  if (normalized.note) slim.note = normalized.note;
  if (fileName) slim.file = fileName;
  else if (normalized.kind === 'image' && !slim.note) slim.note = 'image not included';
  return slim;
}

/** Persist every attachment on a message; returns slim records. */
export function persistAttachments(dir, sessionId, attachments, harness = 'kusa') {
  const list = normalizeAttachments(attachments);
  if (!list.length) return [];
  return list.map((attachment) => persistAttachment(dir, sessionId, attachment, harness)).filter(Boolean);
}

/**
 * Reload inline payload from the session attachments/ folder when the slim
 * transcript record only carries a `file` pointer. Missing files keep the
 * record as a named reference (with a note) rather than inventing bytes.
 */
export function hydrateAttachment(dir, sessionId, attachment, harness = 'kusa') {
  const normalized = normalizeAttachment(attachment);
  if (!normalized) return null;
  if (normalized.dataUrl || normalized.text) return normalized;
  const fileName = sanitizeAttachmentFileName(normalized.file);
  if (!fileName || !dir || !sessionId) return normalized;
  const path = join(sessionAttachmentsDir(dir, sessionId, harness), fileName);
  if (!existsSync(path)) {
    if (normalized.kind === 'image' && !normalized.note) {
      return { ...normalized, note: 'image not included' };
    }
    return normalized;
  }
  try {
    const buf = readFileSync(path);
    if (normalized.kind === 'image') {
      const { note: _note, ...rest } = normalized;
      return {
        ...rest,
        size: normalized.size || buf.length,
        dataUrl: bufferToDataUrl(buf, normalized.mime || 'image/png'),
      };
    }
    if (normalized.kind === 'text') {
      const text = buf.toString('utf8');
      return {
        ...normalized,
        size: normalized.size || buf.length,
        text: text.length > ATTACHMENT_LIMITS.textChars
          ? text.slice(0, ATTACHMENT_LIMITS.textChars)
          : text,
      };
    }
    return { ...normalized, size: normalized.size || buf.length };
  } catch {
    return normalized;
  }
}

export function hydrateAttachments(dir, sessionId, attachments, harness = 'kusa') {
  const list = normalizeAttachments(attachments);
  if (!list.length) return [];
  return list.map((attachment) => hydrateAttachment(dir, sessionId, attachment, harness)).filter(Boolean);
}
