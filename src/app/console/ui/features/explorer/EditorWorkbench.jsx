/**
 * Left-drawer workspace editor: tab strip + Monaco (textarea fallback).
 * Tabs are opened from Explorer / Search and slide in beside the main pane
 * (chat stays center; plan / other drawers can dock right). Content loads via
 * GET /file.
 *
 * Monaco is uncontrolled after load (`defaultValue` + remount key). Passing a
 * live `value=` prop fights the editor's own model and makes saves look like
 * they revert until a later sync catches up.
 */
import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';

import { basenameOfPath, fileTypeOfPath, languageOfPath } from '#ui/features/explorer/language.js';
import { ensureMonaco } from '#ui/features/explorer/monaco-setup.js';
import { invalidateExplorerCache } from '#ui/features/explorer/tree-cache.js';
import { FILE_ICON_TONES, FileTypeIcon } from '#ui/shared/FileIcons.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

/** Match Sidebar topbar ToolIconButton / ViewButton chrome (18×18 lucide). */
const TAB_ICON_BTN = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors';
const TAB_ICON_SIZE = 'h-[18px] w-[18px]';

/** Set workers before the first <Editor> mount (module load, not useEffect). */
let monacoBootError = null;
try {
  ensureMonaco();
} catch (err) {
  monacoBootError = err?.message || String(err);
}

/**
 * @typedef {{ path: string, name?: string }} EditorTab
 * @typedef {{
 *   content: string,
 *   saved: string,
 *   revision: number,
 *   error?: string,
 *   loading?: boolean,
 * }} EditorDoc
 */

class EditorErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}

/**
 * @param {{
 *   tabs: EditorTab[],
 *   activePath: string | null,
 *   reveal?: { path: string, line: number, column?: number } | null,
 *   theme?: 'dark' | 'light',
 *   onSelectTab: (path: string) => void,
 *   onCloseTab: (path: string) => void,
 *   onRevealHandled?: () => void,
 * }} props
 */
export function EditorWorkbench({
  tabs,
  activePath,
  reveal = null,
  theme = 'dark',
  onSelectTab,
  onCloseTab,
  onRevealHandled = null,
}) {
  /** @type {[Record<string, EditorDoc>, Function]} */
  const [docs, setDocs] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [monacoReady] = useState(() => !monacoBootError);
  const [monacoError] = useState(() => monacoBootError);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  /** Latest doc map for save — avoids stale closures mid-request. */
  const docsRef = useRef(docs);
  docsRef.current = docs;
  /** Ignore stale GET responses after a newer load/save for the same path. */
  const loadGenRef = useRef(/** @type {Record<string, number>} */ ({}));
  const editorRef = useRef(null);
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  /** Horizontal tab strip — overflow is revealed with chevrons, not scrollbars. */
  const tabStripRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const active = activePath ? docs[activePath] : null;
  const dirty = Boolean(active && active.content !== active.saved && !active.loading && !active.error);

  const updateTabScrollState = useCallback(() => {
    const el = tabStripRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  function scrollTabs(direction) {
    const el = tabStripRef.current;
    if (!el) return;
    const step = Math.max(140, Math.floor(el.clientWidth * 0.65));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  }

  useLayoutEffect(() => {
    const el = tabStripRef.current;
    if (!el) return undefined;
    updateTabScrollState();
    const onScroll = () => updateTabScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updateTabScrollState())
      : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [tabs, updateTabScrollState]);

  // Keep the active tab visible when selection or the tab set changes.
  useLayoutEffect(() => {
    const el = tabStripRef.current;
    if (!el || !activePath) return;
    const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape
      : (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const tabEl = el.querySelector(`[data-editor-tab="${escape(activePath)}"]`);
    tabEl?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    updateTabScrollState();
  }, [activePath, tabs, updateTabScrollState]);

  const loadFile = useCallback(async (path) => {
    if (!path) return;
    const existing = docsRef.current[path];
    // Already loaded (or dirty) — do not refetch and clobber the buffer.
    if (existing && !existing.error && !existing.loading) return;

    const gen = (loadGenRef.current[path] || 0) + 1;
    loadGenRef.current[path] = gen;

    setDocs((prev) => {
      const cur = prev[path];
      if (cur && !cur.error && !cur.loading) return prev;
      return {
        ...prev,
        [path]: { content: '', saved: '', revision: gen, loading: true },
      };
    });

    try {
      const res = await fetch(`/file?path=${encodeURIComponent(path)}`, {
        headers: { Accept: 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const content = String(body.content ?? '');
      setDocs((prev) => {
        if (loadGenRef.current[path] !== gen) return prev;
        const cur = prev[path];
        // A save or edit landed while we were fetching — keep the buffer.
        if (cur && !cur.loading && cur.content !== cur.saved) return prev;
        if (cur && !cur.loading && cur.revision > gen) return prev;
        return {
          ...prev,
          [path]: { content, saved: content, revision: gen, loading: false },
        };
      });
    } catch (err) {
      setDocs((prev) => {
        if (loadGenRef.current[path] !== gen) return prev;
        return {
          ...prev,
          [path]: {
            content: '',
            saved: '',
            revision: gen,
            loading: false,
            error: err?.message || String(err),
          },
        };
      });
    }
  }, []);

  useEffect(() => {
    for (const tab of tabs) void loadFile(tab.path);
  }, [tabs, loadFile]);

  const updateContent = useCallback((path, next) => {
    if (!path) return;
    setDocs((prev) => {
      const cur = prev[path];
      if (!cur || cur.loading) return prev;
      if (cur.content === next) return prev;
      return { ...prev, [path]: { ...cur, content: next } };
    });
    setSaveError(null);
  }, []);

  const saveActive = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    const doc = docsRef.current[path];
    if (!doc || doc.loading || doc.error) return;
    const snapshot = doc.content;
    if (snapshot === doc.saved) return;

    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/file?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ contents: snapshot }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      // Mark the exact bytes we wrote as saved — do not rewrite `content`
      // (the user may have typed more while the PUT was in flight).
      setDocs((prev) => {
        const cur = prev[path];
        if (!cur) return prev;
        return { ...prev, [path]: { ...cur, saved: snapshot } };
      });
      // New paths bump the server tree rev; nudge Explorer immediately.
      if (body.created) invalidateExplorerCache('editor-create');
    } catch (err) {
      setSaveError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    function onKey(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        if (activePathRef.current) {
          event.preventDefault();
          void saveActive();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveActive]);

  function closeTab(path, event) {
    event?.stopPropagation();
    const doc = docsRef.current[path];
    if (doc && doc.content !== doc.saved && !doc.error) {
      const ok = window.confirm(`Discard unsaved changes to ${basenameOfPath(path)}?`);
      if (!ok) return;
    }
    setDocs((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    onCloseTab(path);
  }

  function applyReveal(editor) {
    const target = revealRef.current;
    if (!editor || !target || target.path !== activePathRef.current) return;
    const line = Math.max(1, Number(target.line) || 1);
    const column = Math.max(1, Number(target.column) || 1);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
    onRevealHandled?.();
  }

  useEffect(() => {
    if (!reveal || reveal.path !== activePath) return undefined;
    const editor = editorRef.current;
    if (editor) applyReveal(editor);
    return undefined;
  }, [reveal, activePath, active?.revision]);

  function renderPlainEditor() {
    if (!activePath || !active || active.loading || active.error) return null;
    return (
      <textarea
        key={`${activePath}:${active.revision}`}
        className="h-full w-full resize-none border-0 bg-gray-950 px-3 py-2 font-mono text-[13px] leading-relaxed text-gray-100 outline-none"
        spellCheck={false}
        defaultValue={active.content}
        onChange={(event) => updateContent(activePath, event.target.value)}
        ref={(node) => {
          if (!node || !reveal || reveal.path !== activePath) return;
          const line = Math.max(1, Number(reveal.line) || 1);
          const lines = active.content.split('\n');
          let pos = 0;
          for (let i = 0; i < Math.min(line - 1, lines.length); i += 1) pos += lines[i].length + 1;
          node.focus();
          node.setSelectionRange(pos, pos);
          onRevealHandled?.();
        }}
      />
    );
  }

  function renderMonaco() {
    if (!activePath || !active || active.loading || active.error) return null;
    if (!monacoReady) {
      return monacoError
        ? renderPlainEditor()
        : <p className="px-4 py-3 text-xs text-gray-500">Starting editor…</p>;
    }
    // Remount only when the path changes or a fresh disk load lands (revision).
    // Do not remount on each keystroke — that is what made saves look like a revert.
    return (
      <EditorErrorBoundary fallback={() => renderPlainEditor()}>
        <Editor
          key={`${activePath}:${active.revision}`}
          height="100%"
          path={activePath}
          language={languageOfPath(activePath)}
          theme={theme === 'light' ? 'vs' : 'vs-dark'}
          defaultValue={active.content}
          onChange={(value) => updateContent(activePath, value ?? '')}
          onMount={(editor) => {
            editorRef.current = editor;
            applyReveal(editor);
          }}
          options={{
            automaticLayout: true,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            renderWhitespace: 'selection',
            padding: { top: 8, bottom: 8 },
          }}
          loading={<p className="px-4 py-3 text-xs text-gray-500">Starting editor…</p>}
        />
      </EditorErrorBoundary>
    );
  }

  if (!tabs.length) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-gray-400">No files open</p>
        <p className="text-xs text-gray-600">
          Pick a file in the sidebar Explorer or File names search.
        </p>
      </div>
    );
  }

  return (
    <div
      data-kusa-editor="true"
      aria-label="Workspace editor"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-gray-950"
    >
      {/* h-12 matches Sidebar topbar so border-b lines up across the split. */}
      <div className="flex h-12 shrink-0 items-stretch border-b border-gray-800 bg-gray-900">
        {canScrollLeft ? (
          <div className="flex shrink-0 items-center border-r border-gray-800 px-1">
            <button
              type="button"
              title="Show earlier tabs"
              aria-label="Show earlier tabs"
              className={`${TAB_ICON_BTN} text-gray-500 hover:bg-gray-800 hover:text-gray-200`}
              onClick={() => scrollTabs(-1)}
            >
              <LucideIcon name="chevron-left" className={TAB_ICON_SIZE} />
            </button>
          </div>
        ) : null}
        <div
          ref={tabStripRef}
          role="tablist"
          aria-label="Open files"
          className="editor-tab-strip flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        >
          {tabs.map((tab) => {
            const on = tab.path === activePath;
            const doc = docs[tab.path];
            const isDirty = Boolean(doc && doc.content !== doc.saved && !doc.loading && !doc.error);
            const label = tab.name || basenameOfPath(tab.path);
            const fileType = fileTypeOfPath(tab.path);
            const tone = FILE_ICON_TONES[fileType] || FILE_ICON_TONES.file;
            return (
              <div
                key={tab.path}
                data-editor-tab={tab.path}
                role="tab"
                aria-selected={on || undefined}
                title={tab.path}
                className={`group flex max-w-[14rem] shrink-0 items-center gap-1.5 border-r border-gray-800 px-2.5 text-xs ${
                  on
                    ? 'bg-gray-950 text-gray-100'
                    : 'bg-transparent text-gray-500 hover:bg-gray-950/60 hover:text-gray-300'
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1 text-left"
                  onClick={() => onSelectTab(tab.path)}
                >
                  <span className={`relative shrink-0 ${on ? tone : 'text-gray-600'}`}>
                    <FileTypeIcon type={fileType} className="h-3.5 w-3.5" />
                    {isDirty ? (
                      <span
                        className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400"
                        aria-label="Unsaved changes"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 truncate">{label}</span>
                </button>
                <button
                  type="button"
                  title={`Close ${label}`}
                  aria-label={`Close ${label}`}
                  className={`${TAB_ICON_BTN} h-6 w-6 text-gray-600 opacity-0 hover:bg-gray-800 hover:text-gray-200 group-hover:opacity-100 focus-visible:opacity-100 ${
                    on ? 'opacity-70' : ''
                  }`}
                  onClick={(event) => closeTab(tab.path, event)}
                >
                  <LucideIcon name="x" className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        {canScrollRight ? (
          <div className="flex shrink-0 items-center border-l border-gray-800 px-1">
            <button
              type="button"
              title="Show more tabs"
              aria-label="Show more tabs"
              className={`${TAB_ICON_BTN} text-gray-500 hover:bg-gray-800 hover:text-gray-200`}
              onClick={() => scrollTabs(1)}
            >
              <LucideIcon name="chevron-right" className={TAB_ICON_SIZE} />
            </button>
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-1 border-l border-gray-800 px-2">
          {saveError ? (
            <span className="max-w-[10rem] truncate text-[10px] text-rose-400" title={saveError}>
              {saveError}
            </span>
          ) : null}
          <button
            type="button"
            disabled={!dirty || saving}
            title={saving ? 'Saving…' : dirty ? 'Save (Ctrl/Cmd+S)' : 'Saved'}
            aria-label={saving ? 'Saving' : dirty ? 'Save file' : 'Saved'}
            className={`${TAB_ICON_BTN} disabled:cursor-not-allowed disabled:opacity-40 ${
              dirty
                ? 'text-emerald-400 hover:bg-gray-800'
                : 'text-gray-600'
            }`}
            onClick={() => void saveActive()}
          >
            <LucideIcon
              name={saving ? 'loader-circle' : 'save'}
              className={`${TAB_ICON_SIZE}${saving ? ' animate-spin' : ''}`}
            />
          </button>
        </div>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-gray-800/80 px-3">
        <span className="truncate font-mono text-[10px] text-gray-500" title={activePath || ''}>
          {activePath || ''}
        </span>
        {monacoError ? (
          <span className="truncate text-[10px] text-amber-400" title={monacoError}>
            Monaco unavailable — plain editor
          </span>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        {active?.loading ? (
          <p className="px-4 py-3 text-xs text-gray-500">Loading…</p>
        ) : active?.error ? (
          <p className="px-4 py-3 text-xs text-rose-400">Could not open file: {active.error}</p>
        ) : (
          renderMonaco()
        )}
      </div>
    </div>
  );
}
