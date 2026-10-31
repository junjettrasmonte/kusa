/**
 * Sidebar › File names — find a workspace file by name.
 *
 * This is the names half of search; the contents half has no pane in the
 * sidebar — the agent answers "which files say this?" with its kusa_grep tool.
 * One pane per question: this one answers "what is this file called?", and a
 * content search must come back as its own id and backend, never as a mode
 * switch on this input.
 *
 * Results come from GET /search (searchWorkspaceFiles in
 * src/features/explorer/search.mjs): the same workspace the Explorer walks, with
 * the same skip rules, but this walk descends into folders the Explorer left as
 * counted stubs, so a name the tree hides behind a click is still found.
 * Matching is a case-insensitive substring of the NAME — or of the path when the
 * query spans folders (`ui/App`) — and the rows are ranked name-prefix first,
 * workspace source above `node_modules`, shallow above deep.
 *
 * The query lives in an input the user types into, and is kept in browser-local
 * storage so reopening the view keeps the last search on screen. The key is
 * names-only by convention: the contents pane must get its own, or the two
 * panes would overwrite each other's last query. Without the console server
 * (file://) there is nothing to search, so the pane says so instead of showing
 * an empty list.
 *
 * The rows below mirror the familiar search widget, but they still answer the
 * names question — Replace previews a rename of the matched NAME and touches
 * nothing on disk (there is no rename endpoint to call), and the include/exclude
 * rows glob the paths the walk returned. The toggles (Aa case, \b whole word,
 * .* regex) refine what the server returned: `GET /search` only does
 * case-insensitive substring matching, so a regex query is sent to it as its
 * longest literal run and the real expression is applied here. That means the
 * toggles and the two glob rows can only ever REMOVE rows — a name the walk
 * never looked at cannot be found by asking for it more strictly.
 */
import { useEffect, useRef, useState } from 'react';

import { FILE_ICONS } from '#ui/shared/FileIcons.jsx';
import { TONES } from '#ui/features/explorer/ExplorerPanel.jsx';
import { readJsonSet, readLocal, writeJsonSet, writeLocal } from '#ui/shared/lib/storage.js';

const QUERY_KEY = 'monitor.searchQuery';
const REPLACE_KEY = 'monitor.searchReplace';
const INCLUDE_KEY = 'monitor.searchInclude';
const EXCLUDE_KEY = 'monitor.searchExclude';
const FLAGS_KEY = 'monitor.searchFlags';
/** Rows the pane renders: the server caps the list, this only guards the DOM. */
const MAX_ROWS = 200;
/** Comma-separated globs one of the include/exclude rows accepts. */
const MAX_PATTERNS = 12;

/** The three toggles, in the order the widget shows them. */
const FLAGS = [
  { id: 'case', label: 'Aa', hint: 'Match case exactly' },
  { id: 'word', label: '\\b', hint: 'Whole words only' },
  { id: 'regex', label: '.*', hint: 'Treat the query as a regular expression' },
];

/** Regex metacharacters, backslash first so it is escaped exactly once. */
const REGEX_META = ['\\', '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '[', ']', '|'];

/** Literal text as a regex source. */
function escapeLiteral(text) {
  let out = String(text || '');
  for (const meta of REGEX_META) out = out.split(meta).join('\\' + meta);
  return out;
}

/** Longest run of literal characters in a regex query — what the server's
 * substring walk can be asked for when the user wants a regex. */
function longestLiteral(query) {
  const source = String(query || '');
  let best = '';
  let run = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      // An escaped metacharacter is a literal character in the pattern.
      run += source[i + 1];
      i += 1;
      continue;
    }
    if ('.*+?^{}()|[]\\'.includes(ch)) {
      if (run.length > best.length) best = run;
      run = '';
      continue;
    }
    run += ch;
  }
  return run.length > best.length ? run : best;
}

/** One glob (*.mjs, src/**, node_modules) as a regex source. */
function globToRegexSource(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        // `**/` also matches at the workspace root, so `**/x` finds `x`.
        if (pattern[i + 1] === '/') {
          out += '/?';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch === '/' ? '\\/' : ('.*+?^{}()|[]\\'.includes(ch) ? '\\' + ch : ch);
  }
  return out;
}

/** The include/exclude rows as a matcher, or null when the row is empty.
 * A pattern with no slash is tested against the NAME - it matches anywhere in
 * the tree; one with a slash is tested against the workspace-relative path;
 * a pattern with no glob characters at all also matches a folder prefix, so
 * `node_modules` hides that whole subtree the way the row label reads. */
function compileGlobs(spec) {
  const patterns = String(spec || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, MAX_PATTERNS);
  if (!patterns.length) return null;
  return {
    patterns,
    regexes: patterns.map((pattern) => new RegExp('^' + globToRegexSource(pattern) + '$')),
  };
}

function globMatch({ patterns, regexes }, node) {
  const path = String(node.path || '');
  const name = String(node.name || '');
  for (let i = 0; i < patterns.length; i += 1) {
    const pattern = patterns[i];
    if (!/[*?]/.test(pattern) && !pattern.includes('/')) {
      // A plain word: the name, or any folder along the path.
      if (name.includes(pattern) || path.split('/').some((part) => part.includes(pattern))) {
        return true;
      }
      continue;
    }
    if (pattern.includes('/') ? regexes[i].test(path) : regexes[i].test(name)) return true;
  }
  return false;
}

/** The matcher the toggles ask for, or null when there is no query. The regex
 * carries no g flag: .test would carry lastIndex across rows. */
function buildMatcher({ query, flags }) {
  const q = String(query || '');
  if (!q) return null;
  if (flags.has('regex')) {
    try {
      return { kind: 'regex', re: new RegExp(q) };
    } catch (err) {
      return { kind: 'error', error: err?.message || String(err) };
    }
  }
  const source = flags.has('word') ? '\\b' + escapeLiteral(q) + '\\b' : escapeLiteral(q);
  return { kind: 'literal', re: new RegExp(source, flags.has('case') ? '' : 'i') };
}

function nodeMatches(re, node) {
  return re.test(String(node.name || '')) || re.test(String(node.path || ''));
}

/** The name this row would get if the replace were applied to it, or null when
 * nothing in the name changes. Only the NAME is rewritten: a row matched by its
 * folder path keeps its own name. */
function renameTo(node, matcher, replacement) {
  if (!replacement || !matcher || matcher.kind === 'error') return null;
  const name = String(node.name || '');
  const rx = new RegExp(matcher.re.source, matcher.re.flags);
  // Literal mode must not read a dollar sign in the replacement as a group.
  const next = matcher.kind === 'regex'
    ? name.replace(rx, replacement)
    : name.replace(rx, () => replacement);
  return next === name ? null : next;
}

/** Name with every span the ACTIVE matcher hit marked - the marks show what
 * actually matched, not what the user typed. */
function MarkedText({ text, re }) {
  const s = String(text || '');
  const parts = [];
  if (!re || !String(re.source || '')) return <span>{s}</span>;
  const rx = new RegExp(re.source, re.flags + 'g');
  let i = 0;
  let hit = null;
  while ((hit = rx.exec(s))) {
    if (!hit[0]) {
      rx.lastIndex = hit.index + 1;
      continue;
    }
    if (hit.index > i) parts.push({ text: s.slice(i, hit.index), hit: false });
    parts.push({ text: hit[0], hit: true });
    i = hit.index + hit[0].length;
  }
  if (i < s.length) parts.push({ text: s.slice(i), hit: false });
  return (
    <span>
      {parts.map((part, index) =>
        part.hit
          ? <span key={index} className="rounded-sm bg-emerald-500/30 text-emerald-100">{part.text}</span>
          : part.text
      )}
    </span>
  );
}

/** One result row: the icon the Explorer would show, the name, its folder —
 * plus the rename this row is only previewing. */
function SearchRow({ node, re, rename = null }) {
  const isDir = node.kind === 'dir';
  const tone = TONES[node.type] || TONES[isDir ? 'folder' : 'file'];
  const icon = FILE_ICONS[node.type] || FILE_ICONS[isDir ? 'folder' : 'file'];
  const count = Number(node.childCount ?? 0);
  return (
    <div className="relative flex w-full shrink-0 items-center gap-1 py-0.5 text-left rounded hover:bg-gray-800/60">
      <span className={`h-3.5 w-3.5 shrink-0 ${tone}`}>{icon}</span>
      <span className="min-w-0 truncate text-xs font-medium text-gray-200">
        <MarkedText text={node.name} re={re} />
      </span>
      {rename ? (
        <span className="shrink-0 ml-1 rounded-sm bg-emerald-500/20 px-1 text-[10px] font-mono text-emerald-300">
          → {rename}
        </span>
      ) : null}
      <span className="ml-1 truncate text-[10px] font-mono text-gray-600">
        {node.dir ? `${node.dir}/` : '.'}
      </span>
      {isDir && count > 0 ? (
        <span className="shrink-0 ml-1 rounded-full bg-gray-800 px-1.5 text-[10px] tabular-nums text-gray-400">
          {count}
        </span>
      ) : null}
    </div>
  );
}

export function SearchPanel() {
  const canServe = typeof location !== 'undefined' && location.protocol !== 'file:';
  const [query, setQuery] = useState(() => readLocal(QUERY_KEY, ''));
  const [replacement, setReplacement] = useState(() => readLocal(REPLACE_KEY, ''));
  const [includeSpec, setIncludeSpec] = useState(() => readLocal(INCLUDE_KEY, ''));
  const [excludeSpec, setExcludeSpec] = useState(() => readLocal(EXCLUDE_KEY, ''));
  const [flags, setFlags] = useState(() => readJsonSet(FLAGS_KEY));
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  /** One shared input row: typing re-runs the search, Escape clears the row
   * rather than leaving a half-typed pattern the user backspaces over. */
  function Field({ inputRef, value, setValue, storageKey, placeholder, ...props }) {
    return (
      <input
        ref={inputRef || undefined}
        type="text"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (next === value) return;
          setValue(next);
          writeLocal(storageKey, next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            setValue('');
            writeLocal(storageKey, '');
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 placeholder:text-gray-600"
        {...props}
      />
    );
  }

  /** Toggle one search mode: the pressed button is the active mode. */
  function ModeToggle({ flag, ...props }) {
    const on = flags.has(flag.id);
    return (
      <button
        type="button"
        title={flag.hint}
        aria-label={flag.hint}
        aria-pressed={on || undefined}
        onClick={() => {
          const next = new Set(flags);
          if (next.has(flag.id)) next.delete(flag.id);
          else next.add(flag.id);
          setFlags(next);
          writeJsonSet(FLAGS_KEY, next);
        }}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors font-mono text-[10px] ${on ? 'bg-gray-800 text-emerald-400' : 'text-gray-600 hover:bg-gray-800 hover:text-gray-200'}`}
        {...props}
      >
        {flag.label}
      </button>
    );
  }

  /** What the walk is asked for. It has no regex engine, so a regex query is
   * sent as its longest literal run and the real expression is applied to
   * whatever comes back — the toggles can only ever remove rows. */
  function serverQuery(q) {
    if (!flags.has('regex')) return q;
    return longestLiteral(q) || q;
  }

  /** Ask the server for one query. The last search wins: a newer keystroke
   * supersedes the request still in flight, so no stale list is ever shown. */
  async function runSearch(q) {
    if (!canServe || !q) return;
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/search?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || !Array.isArray(body.matches)) throw new Error('no results in response');
      setPayload(body);
      setLoadError(null);
    } catch (err) {
      setLoadError(err?.message || String(err));
      setPayload(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const q = String(query || '').trim();
    if (!q) {
      setPayload(null);
      setLoadError(null);
      return undefined;
    }
    void runSearch(serverQuery(q));
    return undefined;
  }, [query, flags, canServe]);

  useEffect(() => {
    if (!canServe) return undefined;
    // The pane opens with the input ready to type into — no click needed.
    requestAnimationFrame(() => inputRef.current?.focus());
    return undefined;
  }, [canServe]);

  const q = String(query || '').trim();
  const matcher = q ? buildMatcher({ query: q, flags }) : null;
  const regexError = matcher?.kind === 'error' ? matcher.error : null;
  const include = compileGlobs(includeSpec);
  const exclude = compileGlobs(excludeSpec);
  const matches = payload?.matches || [];
  const kept = matches.filter((node) => {
    if (include && !globMatch(include, node)) return false;
    if (exclude && globMatch(exclude, node)) return false;
    if (matcher) return nodeMatches(matcher.re, node);
    return true;
  });
  // The rename is computed once per row: the rows render it, the header counts
  // how many of them would actually change.
  const rows = kept.map((node) => ({ node, rename: renameTo(node, matcher, replacement) }));
  const shown = rows.slice(0, MAX_ROWS);
  const renamedCount = rows.reduce((sum, row) => sum + (row.rename ? 1 : 0), 0);
  const filteredOut = Math.max(0, Number(payload?.matched ?? 0) - kept.length);

  return (
    <nav
      id="sidebar-panel-search-names"
      role="tabpanel"
      aria-labelledby="sidebar-view-search-names"
      className="flex-1 overflow-y-auto py-1 text-sm"
      aria-label="Workspace file and folder name search"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 px-3 pb-1">
        <span className="truncate text-[10px] tabular-nums text-gray-500">
          {canServe
            ? payload
              ? `${kept.length} match${kept.length === 1 ? '' : 'es'}${
                  filteredOut ? ` · ${filteredOut} filtered out` : ''
                }${payload.truncated ? ' · capped' : ''}${
                  replacement && renamedCount ? ` · ${renamedCount} renameable` : ''
                }`
              : regexError
                ? `Invalid regex: ${regexError}`
                : q
                  ? 'Searching the workspace…'
                  : 'Type a file or folder name'
            : 'No workspace search without kusa serve'}
        </span>
      </div>

      {canServe ? (
        <>
          <div className="flex flex-wrap items-center gap-1 px-3 py-1">
            <Field
              inputRef={inputRef}
              value={query}
              setValue={setQuery}
              storageKey={QUERY_KEY}
              placeholder="Search file and folder names…"
            />
            {FLAGS.map((flag) => (
              <ModeToggle key={flag.id} flag={flag} />
            ))}
          </div>

          <div className="flex items-center gap-1 px-3 py-1">
            <Field
              value={replacement}
              setValue={setReplacement}
              storageKey={REPLACE_KEY}
              placeholder="Replacement — leave empty to search only…"
            />
            <span className="shrink-0 ml-1 text-[10px] text-gray-500">
              preview only — names are not renamed here
            </span>
          </div>

          <div className="flex items-center gap-1 px-3 py-1">
            <Field
              value={includeSpec}
              setValue={setIncludeSpec}
              storageKey={INCLUDE_KEY}
              placeholder="files to include — e.g. *.mjs, src/app/**…"
            />
            <span className="shrink-0 ml-1 text-[10px] text-gray-500">keep these paths</span>
          </div>

          <div className="flex items-center gap-1 px-3 py-1">
            <Field
              value={excludeSpec}
              setValue={setExcludeSpec}
              storageKey={EXCLUDE_KEY}
              placeholder="files to exclude — e.g. node_modules, *.min.js…"
            />
            <span className="shrink-0 ml-1 text-[10px] text-gray-500">drop these paths</span>
          </div>
        </>
      ) : null}

      {canServe && q && !payload ? (
        <p className="px-3 text-[11px] text-gray-500">
          {loadError ? `Could not search the workspace: ${loadError}` : 'Searching the workspace…'}
        </p>
      ) : null}

      {canServe && regexError ? (
        <p className="px-3 text-[11px] text-amber-400">
          The query is not a valid regular expression: {regexError}. The list still shows what the
          walk returned for the literal part of it.
        </p>
      ) : null}

      {canServe && payload && !kept.length ? (
        <p className="px-3 text-[11px] text-gray-500">
          {payload.matched
            ? `${payload.matched} name${payload.matched === 1 ? '' : 's'} matched, but the include/exclude rows filtered them all out.`
            : `No file or folder name matches ${q}. This pane searches names — text inside files is not searched here; ask the agent, which has kusa_grep.`}
        </p>
      ) : null}

      {canServe && shown.length ? (
        <div className="px-1">
          {shown.map((row) => (
            <SearchRow
              key={row.node.path}
              node={row.node}
              re={matcher?.re}
              rename={row.rename}
            />
          ))}
        </div>
      ) : null}

      {!canServe ? (
        <p className="px-3 text-[11px] text-gray-500">
          Open the dashboard over HTTP (
          <code className="text-sky-300">kusa serve</code>) to search workspace files.
        </p>
      ) : null}
    </nav>
  );
}
