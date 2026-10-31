/**
 * Pure text-patch helpers shared by kusa_patch_file (see files.mjs).
 * Kept separate so the patch algorithm is unit-testable without a workspace.
 */

/** @param {string} haystack @param {string} needle */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** @param {string} haystack @param {string} needle @param {string} replacement */
export function replaceOccurrences(haystack, needle, replacement) {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

/** Re-express a snippet using the line endings the target file already uses. */
export function matchLineEndings(snippet, targetText) {
  const crlf = targetText.includes('\r\n');
  if (crlf) return snippet.replace(/\r?\n/g, '\r\n');
  if (targetText.includes('\r\n')) return snippet;
  return snippet.replace(/\r\n/g, '\n');
}

/**
 * Apply ordered search/replace edits to a text buffer.
 * Edits are validated against the evolving text; the first failing edit aborts
 * the patch so callers can write atomically (nothing half-applied is returned).
 * @param {string} text
 * @param {Array<{ oldText: string, newText: string, replaceAll?: boolean }>} edits
 * @returns {{ text: string, applied: number, matches: number } | { error: string }}
 */
export function applyEdits(text, edits) {
  let out = String(text ?? '');
  let applied = 0;
  let matches = 0;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] || {};
    const rawOld = String(edit.oldText ?? '');
    const rawNew = String(edit.newText ?? '');
    const replaceAll = Boolean(edit.replaceAll);
    const label = `edit #${i + 1}`;
    if (!rawOld) {
      return { error: `${label}: oldText is required (an empty oldText is ambiguous)` };
    }
    let oldText = rawOld;
    let newText = rawNew;
    let count = countOccurrences(out, oldText);
    if (count === 0) {
      const altOld = matchLineEndings(oldText, out);
      const altNew = matchLineEndings(newText, out);
      const altCount = altOld === oldText ? 0 : countOccurrences(out, altOld);
      if (altCount > 0) {
        oldText = altOld;
        newText = altNew;
        count = altCount;
      }
    }
    if (count === 0) {
      return { error: `${label}: oldText not found — re-read the file and copy the exact text` };
    }
    if (!replaceAll && count > 1) {
      return {
        error:
          `${label}: oldText matched ${count} times — add surrounding context to make it unique, or set replaceAll=true`,
      };
    }
    out = replaceOccurrences(out, oldText, newText);
    applied += 1;
    matches += count;
  }
  return { text: out, applied, matches };
}

/**
 * Cheap line-change summary for patch results: trims the shared head/tail.
 * @param {string} before @param {string} after
 */
export function diffLineCounts(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { removed: a.length - head - tail, added: b.length - head - tail };
}
