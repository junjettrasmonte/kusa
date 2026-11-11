/**
 * Composer attachments — browser-side only.
 *
 * An attachment is a small plain record, never a DOM node or a File handle, so
 * it can be held in React state, sent to the server, and written into the chat
 * sidecar like any other message field:
 *
 *   { name, kind: 'image' | 'text' | 'other' | 'jira', size, mime, dataUrl?, text?, note?, issueKey? }
 *
 * `dataUrl` is what a vision model actually sees; `text` is what any model can
 * read. A file that is neither (a PDF, an archive) keeps its name only — the
 * note says so, because inventing bytes for it would be a lie.
 *
 * Everything here is capped: the POST body to /kusa/chat is bounded, so an
 * oversized image is re-encoded through a canvas (vision endpoints downsample
 * images to ~1536px on their side anyway) rather than rejected outright.
 */
export const ATTACHMENT_LIMITS = {
  files: 5,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 6 * 1024 * 1024,
  textChars: 20_000,
  imageEdge: 1536,
};

// How long a paste-from-clipboard request keeps the paste listener armed. A
// gesture the user never makes is not a stall: the window closes itself and the
// composer says so. It is long because the gesture is the user's own — they may
// be hunting for the screenshot they want to hand over.
export const PASTE_READ_WINDOW_MS = 45_000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Extension → kind, for files the browser reports no usable MIME for. */
const TEXT_SUFFIXES = [
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.log', '.html', '.htm', '.xml', '.svg',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.py', '.rb',
  '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.java', '.kt', '.swift',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.graphql', '.toml', '.diff',
  '.patch', '.po', '.properties',
];

export function attachmentKind(file) {
  const type = String(file?.type || '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  const name = String(file?.name || '').toLowerCase();
  if (TEXT_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'text';
  return 'other';
}

export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return `${n}B`;
}

/** Short label for a chip: the name alone, clipped — the size sits beside it. */
export function attachmentLabel(attachment, max = 28) {
  const name = String(attachment?.name || 'file');
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

function readAsDataUrl(file) {
  const reader = new FileReader();
  return new Promise((resolve, error) => {
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => error(new Error('could not read file'));
    void reader.readAsDataURL(file);
  });
}

function readAsText(file) {
  const reader = new FileReader();
  return new Promise((resolve, error) => {
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => error(new Error('could not read file'));
    void reader.readAsText(file);
  });
}

/**
 * Re-encode an oversized image so it fits the request budget. Vision endpoints
 * downsample to roughly this edge on their side, so shrinking here loses nothing
 * the model would have seen.
 * @param {File} file
 * @returns {string} a data: URL, or '' when the canvas cannot decode it
 */
async function downscaleImageDataUrl(file) {
  const { imageEdge, fileBytes } = ATTACHMENT_LIMITS;
  const objectUrl = window?.createObjectURL?.(file);
  if (!objectUrl) return '';
  try {
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image could not be decoded'));
        image.src = objectUrl;
      });
    } finally {
      window?.revokeObjectURL?.(objectUrl);
    }
    const longest = Math.max(1, Number(image.naturalWidth) || 1, Number(image.naturalHeight) || 1);
    const scale = Math.min(1, imageEdge / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((Number(image.naturalWidth) || 1) * scale));
    canvas.height = Math.max(1, Math.round((Number(image.naturalHeight) || 1) * scale));
    const context = canvas?.getContext?.('2d');
    if (!context) return '';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let dataUrl = String(canvas.toDataURL('image/jpeg', 0.85) || '');
    // A screenshot at this edge can still overflow the budget; one more step
    // down in quality is cheaper than refusing the attachment outright.
    if (dataUrl.length * 0.75 > fileBytes) dataUrl = String(canvas.toDataURL('image/jpeg', 0.6) || '');
    return dataUrl;
  } catch {
    return '';
  }
}

/**
 * @param {File} file
 * @returns {Promise<object|null>} an attachment record, or null when the file
 *   is unreadable in the browser (kept as a name-only reference)
 */
export async function fileToAttachment(file) {
  if (!file) return null;
  const name = String(file.name || 'file').slice(0, 200);
  const size = Number(file.size) || 0;
  const mime = String(file.type || '');
  const kind = attachmentKind(file);
  const base = {
    name,
    kind,
    size,
    mime: mime || inferredMime(name),
  };
  if (size > ATTACHMENT_LIMITS.fileBytes && kind !== 'image') {
    return {
      ...base,
      note: kind === 'text'
        ? 'too large to inline — the name is sent, the agent can read it with its file tools'
        : 'not readable in the browser — only the name is sent',
    };
  }
  try {
    if (kind === 'image') {
      const dataUrl = size <= ATTACHMENT_LIMITS.fileBytes
        ? await readAsDataUrl(file)
        : await downscaleImageDataUrl(file);
      if (!dataUrl) return { ...base, note: 'image too large to send' };
      return { ...base, dataUrl };
    }
    if (kind === 'text') {
      const text = await readAsText(file);
      const clipped = text.length > ATTACHMENT_LIMITS.textChars
        ? `${text.slice(0, ATTACHMENT_LIMITS.textChars)}…`
        : text;
      return { ...base, text: clipped };
    }
    return { ...base, note: 'not readable in the browser — only the name is sent' };
  } catch {
    return { ...base, note: 'could not be read — only the name is sent' };
  }
}

function inferredMime(name) {
  const lower = String(name || '').toLowerCase();
  for (const type of IMAGE_TYPES) {
    const suffix = `.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`;
    if (lower.endsWith(suffix)) return type;
  }
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  return '';
}

/**
 * The OS file-chooser dialog.
 *
 * Where the File System Access API exists (Chrome / Edge on a secure origin —
 * the dashboard is served from 127.0.0.1, which is one) `showOpenFilePicker` IS
 * the operating system's dialog, and it returns handles we can read. Everywhere
 * else a file `<input>` is the only thing the browser can open a chooser with:
 * clicking it fires a `change` event carrying the selected Files. The input is
 * kept in the document at zero opacity because a detached or hidden node is not
 * hit-testable, and it is removed as soon as the chooser has answered.
 *
 * @param {number} [max] how many files the dialog may hand back
 * @returns {Promise<File[]>} empty when the user cancelled
 */
export async function pickFilesWithOsDialog(max = ATTACHMENT_LIMITS.files) {
  const picker = window.showOpenFilePicker;
  if (typeof picker === 'function') {
    let handles;
    try {
      handles = await picker({ multiple: true });
    } catch {
      // Cancelled (DOMException "canceled") or blocked by the permission prompt.
      return [];
    }
    const files = [];
    for (const handle of (handles || [])) {
      try {
        const file = await handle.getFile();
        if (file) files.push(file);
      } catch {
        /* a handle that no longer resolves is simply not attached */
      }
      if (files.length >= max) break;
    }
    return files;
  }
  return await pickFilesViaInput(max);
}

async function pickFilesViaInput(max) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  // A file input only opens its chooser when it is in the document and clickable.
  input.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;z-index:1;cursor:pointer;';
  document.appendChild(input);
  try {
    const files = await new Promise((resolve) => {
      input.addEventListener('change', (event) => {
        resolve([...(event.target.files || [])].slice(0, max));
      });
      // The chooser is a user gesture that the user answers at their own pace;
      // closing the tab or pressing Escape simply never fires `change`, and the
      // finally below drops the input off the page either way.
      input.click();
    });
    return files;
  } finally {
    if (input.parentNode) input.parentNode.removeChild(input);
  }
}

/**
 * Read an image (or text) off the clipboard as an attachment.
 *
 * `clipboard.read()` needs the `clipboard-read` permission — the browser asks
 * once, per origin, and this is a secure origin. Denied or unsupported, the
 * caller falls back to `readClipboardViaPaste`, which needs no permission at
 * all; text still reaches the composer through a normal paste, which needs
 * none either.
 * @returns {Promise<object|null>} an attachment record, or null when the
 *   clipboard holds nothing this call can take
 */
export async function readClipboardAttachment() {
  const read = navigator.clipboard?.read;
  if (typeof read !== 'function') return null;
  let items;
  try {
    items = await read();
  } catch {
    // Permission denied or the clipboard is unavailable.
    return null;
  }
  for (const item of (items || [])) {
    for (const type of (item?.types || [])) {
      if (!String(type).startsWith('image/')) continue;
      try {
        // Standard ClipboardItem API — getType(mime), not a non-standard getImage.
        const blob = await item.getType(type);
        if (!blob) continue;
        const extension = String(type).split('/')[1] || 'png';
        const file = new File(
          [blob],
          `clipboard-${Date.now().toString(36)}.${extension === 'jpeg' ? 'jpg' : extension}`,
          { type },
        );
        return await dataTransferToAttachment({
          kind: 'image',
          name: file.name,
          size: file.size,
          mime: type,
          dataUrl: await readAsDataUrl(file),
        });
      } catch {
        /* this type could not be read — try the next */
      }
    }
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      return await dataTransferToAttachment({ kind: 'text', text });
    }
  } catch {
    /* no text on the clipboard */
  }
  return null;
}

/**
 * The clipboard without the permission — the path Firefox and Safari have.
 *
 * There is no API that reads the clipboard on demand in those browsers, and
 * there is no API that synthesizes a paste gesture either: `clipboardData` is
 * only handed over while the user is actually pasting. So this arms a listener
 * and waits for that one gesture — Ctrl+V into the composer, or a middle-click
 * paste anywhere on the page — which is the same gesture the user already makes
 * to put words in the box, and needs no permission prompt on any browser.
 *
 * The event is consumed, not passed on: taking the clipboard as an attachment
 * and letting the browser type the same words into the composer would put the
 * same text on the message twice.
 * @param {number} [maxMs] how long the listener stays armed
 * @returns {Promise<object|null>} an attachment record, or null when no paste
 *   arrived inside the window
 */
export async function readClipboardViaPaste(maxMs = PASTE_READ_WINDOW_MS) {
  const transfer = await awaitPasteEvent(maxMs);
  return transfer ? await dataTransferToAttachment(transfer) : null;
}

/**
 * One real paste gesture, as a plain clipboard record.
 * @param {number} [maxMs]
 * @returns {Promise<object|null>} the pasted clipboard, or null on timeout
 */
async function awaitPasteEvent(maxMs) {
  const transfer = await new Promise((resolve) => {
    let timer = 0;
    const finish = (value) => {
      document.removeEventListener('paste', onPaste);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const onPaste = (event) => {
      // Composer onPaste may already have staged files from this gesture —
      // leave that path alone rather than attaching the same payload twice.
      if (event.defaultPrevented) {
        finish(null);
        return;
      }
      // Consume the gesture: attaching the clipboard and letting the browser
      // also type it into the composer would put the same payload on the
      // message twice.
      event.preventDefault();
      finish(event?.clipboardData || null);
    };
    // Document-wide, not composer-only: a paste into the textarea bubbles here,
    // and a paste made anywhere else on the page still carries the clipboard.
    document.addEventListener('paste', onPaste);
    try {
      timer = setTimeout(() => {
        // The window closed with no gesture: take the listener back off the
        // page, or the next unrelated paste would be read as this request.
        finish(null);
      }, Math.max(1000, Number(maxMs) || PASTE_READ_WINDOW_MS));
    } catch {
      /* no timer: the next paste, or nothing, decides */
    }
  });
  if (!transfer) return null;
  return transfer;
}

/**
 * A clipboard payload — a `ClipboardItem`, a `DataTransfer`, or the plain
 * record the clipboard path builds itself — as the attachment record both
 * sides of the wire agree on. One builder for every source, so the two ways
 * the clipboard can be read cannot drift apart.
 * @param {unknown} source
 * @returns {Promise<object|null>} null when the clipboard holds nothing readable
 */
async function clipboardRecordFrom(source) {
  if (!source) return null;
  let kind = '';
  let name = '';
  let size = 0;
  let mime = '';
  let dataUrl = '';
  let text = '';

  // Paste events hand a DataTransfer. Prefer files (screenshots / copied
  // images) then plain text — never wrap a DataTransferItem as a File blob.
  if (typeof source.getData === 'function' || source.files || source.items) {
    const files = source.files ? [...source.files] : [];
    for (const file of files) {
      if (!file?.type?.startsWith('image/')) continue;
      kind = 'image';
      name = file.name || clipboardName(String(file.type).split('/')[1] || 'png');
      size = file.size;
      mime = file.type;
      dataUrl = await readAsDataUrl(file);
      break;
    }
    if (!kind && source.items) {
      for (const entry of source.items) {
        const type = String(entry?.type || '');
        if (!type.startsWith('image/')) continue;
        const file = typeof entry.getAsFile === 'function' ? entry.getAsFile() : null;
        if (!file) continue;
        kind = 'image';
        name = file.name || clipboardName(type.split('/')[1] || 'png');
        size = file.size;
        mime = type;
        dataUrl = await readAsDataUrl(file);
        break;
      }
    }
    if (!kind && typeof source.getData === 'function') {
      const body = String(source.getData('text/plain') || '');
      if (body.trim()) {
        kind = 'text';
        text = body;
        size = body.length;
        mime = 'text/plain';
      }
    }
  } else {
    kind = source.kind === 'image' ? 'image' : 'text';
    name = String(source.name || '');
    size = Number(source.size) || 0;
    mime = String(source.mime || '');
    dataUrl = String(source.dataUrl || '');
    text = String(source.text || '');
  }
  if (kind === 'image') {
    if (!dataUrl || !size) return null;
    return { name: name || clipboardName('png'), kind, size, mime: mime || 'image/png', dataUrl };
  }
  if (!text.trim()) return null;
  return {
    name: name || 'clipboard.txt',
    kind: 'text',
    size: size || text.length,
    mime: mime || 'text/plain',
    text: text.length > ATTACHMENT_LIMITS.textChars
      ? `${text.slice(0, ATTACHMENT_LIMITS.textChars)}…`
      : text,
  };
}

/**
 * @param {unknown} source
 * @returns {Promise<object|null>} an attachment record, or null when the
 *   clipboard holds nothing readable
 */
export async function dataTransferToAttachment(source) {
  return await clipboardRecordFrom(source);
}

/**
 * Files/images from a paste or drop `DataTransfer` — not plain text.
 *
 * Plain text stays for the composer to type in; a screenshot, a dragged file,
 * or a clipboard image becomes an attachment. Dedupes by name+size so a
 * transfer that lists the same file in both `files` and `items` only yields
 * one entry.
 * @param {DataTransfer|null|undefined} transfer
 * @returns {File[]}
 */
export function collectTransferFiles(transfer) {
  if (!transfer) return [];
  /** @type {File[]} */
  const out = [];
  const seen = new Set();
  function push(file) {
    if (!file) return;
    const key = `${file.name || ''}:${file.size || 0}:${file.type || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  }
  if (transfer.files?.length) {
    for (const file of transfer.files) push(file);
  }
  if (transfer.items) {
    for (const entry of transfer.items) {
      if (entry?.kind && entry.kind !== 'file') continue;
      const type = String(entry?.type || '');
      // Prefer real files; also take clipboard images that only appear as items.
      if (entry?.kind === 'file' || type.startsWith('image/')) {
        const file = typeof entry.getAsFile === 'function' ? entry.getAsFile() : null;
        push(file);
      }
    }
  }
  return out;
}

/** True when a paste/drop carries at least one file or image to attach. */
export function transferHasFiles(transfer) {
  return collectTransferFiles(transfer).length > 0;
}

function clipboardName(extension) {
  return `clipboard-${Date.now().toString(36)}.${extension}`;
}

/**
 * Merge freshly-read files into the attachments already staged for this draft.
 * Duplicates (same name and size) are ignored, so pressing Add Files twice on
 * the same selection cannot stack the same file up to the cap.
 * @param {Array<object>} current
 * @param {Array<object>} added
 * @returns {{ list: Array<object>, rejected: Array<object> }}
 */
export function stageAttachments(current, added) {
  const limits = ATTACHMENT_LIMITS;
  const list = [];
  const rejected = [];
  let bytes = 0;
  for (const existing of (current || [])) {
    if (list.length >= limits.files) {
      rejected.push(existing);
      continue;
    }
    bytes += Number(existing?.size) || 0;
    list.push(existing);
  }
  for (const attachment of (added || [])) {
    if (!attachment) continue;
    const size = Number(attachment.size) || 0;
    const duplicate = list.some((held) => held?.name === attachment.name && held?.size === size);
    if (duplicate) continue;
    if (list.length >= limits.files || bytes + size > limits.totalBytes) {
      rejected.push(attachment);
      continue;
    }
    bytes += size;
    list.push(attachment);
  }
  return { list, rejected };
}
