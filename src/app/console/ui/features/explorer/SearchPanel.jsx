/**
 * Sidebar › Search — find & replace text inside workspace files.
 *
 * Results come from GET /grep (searchWorkspaceContent). Replace All posts to
 * POST /grep/replace. Clicking a match opens the main-pane editor at that line.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { FILE_ICON_TONES, FileTypeIcon } from '#ui/shared/FileIcons.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { readJsonSet, readLocal, writeJsonSet, writeLocal } from '#ui/shared/lib/storage.js';

const QUERY_KEY = 'monitor.contentSearchQuery';
const REPLACE_KEY = 'monitor.contentSearchReplace';
const INCLUDE_KEY = 'monitor.contentSearchInclude';
const EXCLUDE_KEY = 'monitor.contentSearchExclude';
const FLAGS_KEY = 'monitor.contentSearchFlags';
const REPLACE_OPEN_KEY = 'monitor.contentSearchReplaceOpen';
const FILTERS_OPEN_KEY = 'monitor.contentSearchFiltersOpen';

const FLAGS = [
  { id: 'case', icon: 'case-sensitive', hint: 'Match case' },
  { id: 'word', icon: 'whole-word', hint: 'Match whole word' },
  { id: 'regex', icon: 'regex', hint: 'Use regular expression' },
];

const INPUT_CLASS =
  'min-w-0 flex-1 bg-transparent py-1.5 text-xs text-gray-100 placeholder:text-gray-600 outline-none';

function Field({
  inputRef,
  value,
  setValue,
  storageKey,
  placeholder,
  onSubmit,
  leading = null,
  trailing = null,
  ariaLabel,
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-gray-700 bg-gray-950 px-2">
      {leading}
      <input
        ref={inputRef || undefined}
        type="text"
        value={value}
        aria-label={ariaLabel || placeholder}
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
          if (e.key === 'Enter' && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
      {value ? (
        <button
          type="button"
          title="Clear"
          aria-label="Clear"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-800 hover:text-gray-300"
          onClick={() => {
            setValue('');
            writeLocal(storageKey, '');
            inputRef?.current?.focus?.();
          }}
        >
          <LucideIcon name="x" className="h-3 w-3" />
        </button>
      ) : null}
      {trailing}
    </div>
  );
}

function IconToggle({ pressed, title, onClick, icon, disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed || undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        pressed
          ? 'bg-gray-800 text-emerald-400'
          : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'
      }`}
    >
      <LucideIcon name={icon} className="h-3.5 w-3.5" />
    </button>
  );
}

function MarkedLine({ text, query, flags }) {
  const parts = useMemo(() => {
    const q = String(query || '');
    if (!q || !text) return [{ text: String(text || ''), hit: false }];
    try {
      const source = flags.has('regex')
        ? q
        : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wrapped = flags.has('word') ? `\\b(?:${source})\\b` : source;
      const re = new RegExp(wrapped, flags.has('case') ? 'g' : 'gi');
      const out = [];
      let last = 0;
      let m = re.exec(text);
      while (m) {
        if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
        out.push({ text: m[0], hit: true });
        last = m.index + m[0].length;
        if (!re.global) break;
        m = re.exec(text);
      }
      if (last < text.length) out.push({ text: text.slice(last), hit: false });
      return out.length ? out : [{ text, hit: false }];
    } catch {
      return [{ text, hit: false }];
    }
  }, [text, query, flags]);

  return (
    <span className="font-mono text-[11px] leading-snug text-gray-300">
      {parts.map((part, i) => (
        <span
          key={`${i}-${part.hit}-${part.text.slice(0, 8)}`}
          className={part.hit ? 'rounded-sm bg-amber-500/30 text-amber-100' : undefined}
        >
          {part.text}
        </span>
      ))}
    </span>
  );
}

function FileGroup({
  file,
  query,
  flags,
  collapsed,
  onToggle,
  onOpenMatch,
}) {
  const tone = FILE_ICON_TONES.code || FILE_ICON_TONES.file;
  const name = file.path.split('/').pop() || file.path;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';

  return (
    <div className="mb-0.5">
      <button
        type="button"
        title={file.path}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-gray-800/70"
        onClick={() => onToggle(file.path)}
      >
        <LucideIcon
          name="chevron-right"
          className={`h-3 w-3 shrink-0 text-gray-500 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        <span className={`shrink-0 ${tone}`}>
          <FileTypeIcon type="code" />
        </span>
        <span className="min-w-0 truncate text-xs font-medium text-gray-200">{name}</span>
        {dir ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-gray-600">{dir}</span>
        ) : null}
        <span className="ml-auto shrink-0 rounded-full bg-gray-800 px-1.5 text-[10px] tabular-nums text-gray-400">
          {file.matches.length}
        </span>
      </button>
      {!collapsed ? (
        <div className="ml-3 border-l border-gray-800/80 pl-1">
          {file.matches.map((hit) => (
            <button
              key={`${file.path}:${hit.line}:${hit.col}`}
              type="button"
              title={`${file.path}:${hit.line}`}
              className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left hover:bg-gray-800/60"
              onClick={() => onOpenMatch(file.path, hit.line, hit.col)}
            >
              <span className="w-7 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-gray-600">
                {hit.line}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <MarkedLine text={hit.text} query={query} flags={flags} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * @param {{
 *   onOpenFile?: (path: string, opts?: { line?: number, column?: number }) => void,
 * }} props
 */
export function SearchPanel({ onOpenFile = null, collapsed = false } = {}) {
  const canServe = typeof location !== 'undefined' && location.protocol !== 'file:';
  const [query, setQuery] = useState(() => readLocal(QUERY_KEY, ''));
  const [replacement, setReplacement] = useState(() => readLocal(REPLACE_KEY, ''));
  const [includeSpec, setIncludeSpec] = useState(() => readLocal(INCLUDE_KEY, ''));
  const [excludeSpec, setExcludeSpec] = useState(() => readLocal(EXCLUDE_KEY, ''));
  const [flags, setFlags] = useState(() => readJsonSet(FLAGS_KEY));
  const [replaceOpen, setReplaceOpen] = useState(() => readLocal(REPLACE_OPEN_KEY, '0') === '1');
  const [filtersOpen, setFiltersOpen] = useState(() => readLocal(FILTERS_OPEN_KEY, '0') === '1');
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [replaceNote, setReplaceNote] = useState(null);
  const [collapsedFiles, setCollapsedFiles] = useState(() => new Set());
  const inputRef = useRef(null);
  const searchGen = useRef(0);

  async function runSearch(q = query) {
    const trimmed = String(q || '').trim();
    if (!canServe || !trimmed) {
      setPayload(null);
      setLoadError(null);
      return;
    }
    const gen = ++searchGen.current;
    setBusy(true);
    setReplaceNote(null);
    try {
      const params = new URLSearchParams({ q: trimmed });
      if (flags.has('case')) params.set('case', '1');
      if (flags.has('word')) params.set('word', '1');
      if (flags.has('regex')) params.set('regex', '1');
      if (includeSpec.trim()) params.set('include', includeSpec.trim());
      if (excludeSpec.trim()) params.set('exclude', excludeSpec.trim());
      const res = await fetch(`/grep?${params}`, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (gen !== searchGen.current) return;
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setPayload(body);
      setLoadError(null);
      setCollapsedFiles(new Set());
    } catch (err) {
      if (gen !== searchGen.current) return;
      setLoadError(err?.message || String(err));
      setPayload(null);
    } finally {
      if (gen === searchGen.current) setBusy(false);
    }
  }

  useEffect(() => {
    const q = String(query || '').trim();
    if (!q) {
      setPayload(null);
      setLoadError(null);
      return undefined;
    }
    const t = setTimeout(() => void runSearch(q), 280);
    return () => clearTimeout(t);
    // flags / include / exclude intentionally included
  }, [query, flags, includeSpec, excludeSpec, canServe]);

  useEffect(() => {
    if (!canServe) return undefined;
    requestAnimationFrame(() => inputRef.current?.focus());
    return undefined;
  }, [canServe]);

  async function replaceAll() {
    const trimmed = String(query || '').trim();
    if (!canServe || !trimmed || replaceBusy) return;
    const matchCount = Number(payload?.matchCount || 0);
    const fileCount = Number(payload?.fileCount || 0);
    if (!matchCount) return;
    const ok = window.confirm(
      `Replace ${matchCount} match${matchCount === 1 ? '' : 'es'} across ${fileCount} file${fileCount === 1 ? '' : 's'}?`,
    );
    if (!ok) return;
    setReplaceBusy(true);
    setReplaceNote(null);
    try {
      const res = await fetch('/grep/replace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: trimmed,
          replacement,
          regex: flags.has('regex'),
          matchCase: flags.has('case'),
          wholeWord: flags.has('word'),
          include: includeSpec.trim(),
          exclude: excludeSpec.trim(),
          dryRun: false,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setReplaceNote(
        `Replaced ${body.replacements || 0} in ${body.changedFiles || 0} file${(body.changedFiles || 0) === 1 ? '' : 's'}`,
      );
      await runSearch(trimmed);
    } catch (err) {
      setReplaceNote(err?.message || String(err));
    } finally {
      setReplaceBusy(false);
    }
  }

  function openMatch(path, line, column) {
    if (typeof onOpenFile !== 'function') return;
    onOpenFile(path, { line, column });
  }

  function toggleFlag(id) {
    const next = new Set(flags);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFlags(next);
    writeJsonSet(FLAGS_KEY, next);
  }

  const files = payload?.files || [];
  const q = String(query || '').trim();
  const filtersActive = Boolean(includeSpec.trim() || excludeSpec.trim());

  return (
    <nav
      id="sidebar-panel-search"
      role="tabpanel"
      aria-labelledby="sidebar-view-search"
      className="flex min-h-0 flex-1 flex-col overflow-hidden text-sm"
      aria-label="Workspace content search"
    >
      {!collapsed ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-gray-800 px-2 sidebar-label">
          <span className="truncate pl-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Search
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              title="Re-run search"
              aria-label="Re-run search"
              disabled={!canServe || !q || busy}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                busy
                  ? 'text-emerald-400'
                  : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'
              }`}
              onClick={() => void runSearch()}
            >
              <LucideIcon
                name="refresh-cw"
                className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`}
              />
            </button>
          </div>
        </div>
      ) : null}

      {canServe && !collapsed ? (
        <div className="shrink-0 space-y-1.5 border-b border-gray-800/70 px-3 py-2">
          <div className="flex items-center gap-1">
            <Field
              inputRef={inputRef}
              value={query}
              setValue={setQuery}
              storageKey={QUERY_KEY}
              placeholder="Search"
              ariaLabel="Search workspace contents"
              onSubmit={() => void runSearch()}
              leading={<LucideIcon name="search" className="h-3.5 w-3.5 shrink-0 text-gray-500" />}
            />
            {FLAGS.map((flag) => (
              <IconToggle
                key={flag.id}
                icon={flag.icon}
                title={flag.hint}
                pressed={flags.has(flag.id)}
                onClick={() => toggleFlag(flag.id)}
              />
            ))}
            <IconToggle
              icon="replace"
              title={replaceOpen ? 'Hide replace' : 'Toggle replace'}
              pressed={replaceOpen}
              onClick={() => {
                const next = !replaceOpen;
                setReplaceOpen(next);
                writeLocal(REPLACE_OPEN_KEY, next ? '1' : '0');
              }}
            />
          </div>

          {replaceOpen ? (
            <div className="flex items-center gap-1">
              <Field
                value={replacement}
                setValue={setReplacement}
                storageKey={REPLACE_KEY}
                placeholder="Replace"
                ariaLabel="Replacement text"
                leading={<LucideIcon name="replace" className="h-3.5 w-3.5 shrink-0 text-gray-500" />}
              />
              <button
                type="button"
                disabled={!payload?.matchCount || replaceBusy || !q}
                title="Replace all matches"
                aria-label="Replace all matches"
                className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-gray-700 px-2 text-[11px] font-medium text-gray-300 disabled:cursor-not-allowed disabled:opacity-40 hover:border-emerald-600/50 hover:text-emerald-300"
                onClick={() => void replaceAll()}
              >
                <LucideIcon
                  name={replaceBusy ? 'loader-circle' : 'replace-all'}
                  className={`h-3.5 w-3.5 ${replaceBusy ? 'animate-spin' : ''}`}
                />
                <span className="sidebar-label">All</span>
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className="flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-600 hover:text-gray-400 sidebar-label"
            aria-expanded={filtersOpen}
            onClick={() => {
              const next = !filtersOpen;
              setFiltersOpen(next);
              writeLocal(FILTERS_OPEN_KEY, next ? '1' : '0');
            }}
          >
            <LucideIcon
              name="chevron-right"
              className={`h-3 w-3 transition-transform ${filtersOpen ? 'rotate-90' : ''}`}
            />
            <LucideIcon name="filter" className="h-3 w-3" />
            <span>Files to include</span>
            {filtersActive ? (
              <span className="ml-auto rounded-full bg-emerald-950/60 px-1.5 text-[9px] font-medium normal-case tracking-normal text-emerald-400/90">
                on
              </span>
            ) : null}
          </button>

          {filtersOpen ? (
            <div className="space-y-1.5 pl-0.5">
              <Field
                value={includeSpec}
                setValue={setIncludeSpec}
                storageKey={INCLUDE_KEY}
                placeholder="e.g. *.mjs, src/**"
                ariaLabel="Files to include"
              />
              <Field
                value={excludeSpec}
                setValue={setExcludeSpec}
                storageKey={EXCLUDE_KEY}
                placeholder="e.g. *.min.js, dist/**"
                ariaLabel="Files to exclude"
              />
            </div>
          ) : null}

          {replaceNote ? (
            <p className="truncate text-[10px] text-emerald-400/90 sidebar-label" title={replaceNote}>
              {replaceNote}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {canServe && loadError ? (
          <p className="px-1 text-[11px] text-rose-400 sidebar-label">Search failed: {loadError}</p>
        ) : null}
        {canServe && q && !payload && !loadError ? (
          <p className="px-1 text-[11px] text-gray-500 sidebar-label">Searching the workspace…</p>
        ) : null}
        {canServe && payload && !files.length ? (
          <p className="px-1 text-[11px] text-gray-500 sidebar-label">No matches for {q}.</p>
        ) : null}
        {canServe && files.map((file) => (
          <FileGroup
            key={file.path}
            file={file}
            query={q}
            flags={flags}
            collapsed={collapsedFiles.has(file.path)}
            onToggle={(path) => {
              setCollapsedFiles((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
            onOpenMatch={openMatch}
          />
        ))}
        {!canServe ? (
          <p className="px-1 text-[11px] text-gray-500 sidebar-label">
            Open the dashboard over HTTP (
            <code className="text-sky-300">kusa serve</code>) to search workspace contents.
          </p>
        ) : null}
      </div>
    </nav>
  );
}
