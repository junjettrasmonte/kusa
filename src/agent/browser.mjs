/**
 * Browser tool for the Kusă agent: fetch one http(s) URL and return readable
 * text. Approval-gated like the terminal tool — leaving the workspace is a
 * side effect the user should consent to.
 */
import { createApprovalGate } from './approval.mjs';

const MAX_FETCH_BYTES = 200_000;
const MAX_BROWSER_TEXT = 12_000;
const MAX_BROWSER_LINKS = 20;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_TIMEOUT_MS = 30_000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export const BROWSER_TOOL_DEFS = [
  {
    name: 'kusa_browse',
    description:
      'Fetch one http(s) URL and return its title, readable text, and links (approval-gated: the user must allow it first). '
      + 'Use for docs, error messages, and library references. Not for file:// or binary downloads.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL' },
        query: {
          type: 'string',
          description: 'Optional filter: return only paragraphs/lines mentioning this text',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&copy;': '©',
};

/**
 * @param {{ approval?: object }} [options]
 */
export function createBrowserTools({ approval = createApprovalGate() } = {}) {
  async function browse(args = {}) {
    const rawUrl = String(args.url || '').trim();
    if (!rawUrl) return { ok: false, error: 'url is required' };

    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, error: `invalid url: ${rawUrl}` };
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return { ok: false, error: `only http(s) allowed, got ${url.protocol}` };
    }

    const requested = args.timeoutMs != null ? Number(args.timeoutMs) : DEFAULT_FETCH_TIMEOUT_MS;
    const timeout = Math.min(
      Math.max(Number.isFinite(requested) ? requested : DEFAULT_FETCH_TIMEOUT_MS, 1_000),
      MAX_FETCH_TIMEOUT_MS,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        signal: controller.signal,
      });
    } catch (err) {
      return {
        ok: false,
        error: err?.name === 'AbortError' ? `timed out after ${timeout}ms` : (err?.message || String(err)),
        url: url.toString(),
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} for ${url.toString()}`,
        url: url.toString(),
        status: response.status,
      };
    }

    const contentType = String(response.headers.get('content-type') || '');
    const raw = await response.text();
    const bodyTruncated = raw.length > MAX_FETCH_BYTES;
    const body = raw.slice(0, MAX_FETCH_BYTES);

    if (contentType.includes('application/json')) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
      return {
        ok: true,
        url: url.toString(),
        status: response.status,
        contentType,
        json: parsed,
        truncated: bodyTruncated,
      };
    }

    const looksHtml = contentType.includes('html') || /<\s*(html|body|div|p|h\d)\b/i.test(body);
    const text = looksHtml ? htmlToText(body) : body;
    const query = String(args.query || '').trim().toLowerCase();
    let textOut = text;
    let filtered = false;
    if (query) {
      const kept = text
        .split(/\n{2,}/)
        .filter((block) => block.toLowerCase().includes(query));
      filtered = true;
      textOut = kept.join('\n\n') || `(no paragraph matched ${query})`;
    }
    const textTruncated = textOut.length > MAX_BROWSER_TEXT;

    return {
      ok: true,
      url: url.toString(),
      status: response.status,
      contentType,
      title: looksHtml ? (titleFromHtml(body) || '') : '',
      links: looksHtml ? linksFromHtml(body) : [],
      text: textOut.slice(0, MAX_BROWSER_TEXT),
      filtered,
      truncated: bodyTruncated || textTruncated,
    };
  }

  async function call(name, args = {}, callId = null) {
    if (name !== 'kusa_browse' && name !== 'browse') {
      return { ok: false, error: `unknown browser tool: ${name}` };
    }
    const verdict = await approval.request({ name, args, callId });
    if (!verdict.allowed) {
      // The gate always settles, so this is a real denial — say which rule
      // settled it and whether a retry is even possible (an unattended run has
      // no user to allow the call, so retrying would just deny again).
      const reason = verdict?.reason || `${name} was not approved`;
      const byRule = String(verdict?.decision || '').endsWith('-default');
      return {
        ok: false,
        denied: true,
        approval: verdict,
        error: verdict?.unattended === true
          ? `DENIED before fetching: no approver is wired for this run, so the rule default applied — ${reason}. Retrying will be denied again; ask the user to switch the approval rule to Allow if this must run.`
          : byRule
            ? `DENIED before fetching: nobody answered in time, so the rule default applied — ${reason}. The URL was NOT fetched. Say which URL you want to open and why, then retry once the user allows it.`
            : `DENIED by the user before fetching: ${reason} — the URL was not fetched.`,
      };
    }
    return browse(args);
  }

  return { defs: BROWSER_TOOL_DEFS, call, browse, approval };
}

function htmlToText(html = '') {
  let out = String(html);
  out = out.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  out = out.replace(/<\/(?:p|div|li|tr|h\d|section|blockquote|pre|code|dd|dt)>/gi, '\n');
  out = out.replace(/<(?:p|div|li|tr|h\d|section|blockquote|pre|ul|ol|table|dd|dt)[^>]*>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.split(entity).join(char);
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function titleFromHtml(html = '') {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return match ? htmlToText(match[1]).slice(0, 200) : '';
}

function linksFromHtml(html = '') {
  const seen = new Set();
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html))) && links.length < MAX_BROWSER_LINKS) {
    const href = match[1].trim();
    const label = htmlToText(match[2]).slice(0, 120);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, label });
  }
  return links;
}
