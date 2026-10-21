import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IconButton,
  PlusIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
} from './IconButton.jsx';

const EMPTY_DRAFT = {
  name: 'kusa_',
  description: '',
  inputSchemaText: JSON.stringify(
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Input text' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    null,
    2,
  ),
  body: 'Result for {{query}}\n',
  enabled: true,
};

const DEFAULT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function schemaToText(schema) {
  try {
    return JSON.stringify(schema || DEFAULT_SCHEMA, null, 2);
  } catch {
    return JSON.stringify(DEFAULT_SCHEMA, null, 2);
  }
}

function draftFromTool(tool) {
  return {
    name: tool.name || '',
    description: tool.description || '',
    inputSchemaText: schemaToText(tool.inputSchema),
    body: tool.body || '',
    enabled: tool.enabled !== false,
  };
}

function serializeDraft(draft) {
  return JSON.stringify({
    name: draft.name.trim(),
    description: draft.description.trim(),
    inputSchemaText: draft.inputSchemaText.trim(),
    body: draft.body,
    enabled: draft.enabled !== false,
  });
}

export function McpToolsPanel({ canPersist = true }) {
  const [tools, setTools] = useState([]);
  const [serverEnabled, setServerEnabled] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState(() => serializeDraft(EMPTY_DRAFT));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [schemaError, setSchemaError] = useState(null);

  const dirty = useMemo(() => serializeDraft(draft) !== baseline, [draft, baseline]);
  const isBuiltin = Boolean(detail?.builtin);
  const creating = !selectedId;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) =>
      [t.name, t.description, t.builtin ? 'builtin' : 'custom'].join(' ').toLowerCase().includes(q),
    );
  }, [tools, query]);

  const refreshList = useCallback(async () => {
    if (!canPersist) return;
    try {
      const [toolsRes, status] = await Promise.all([api('/mcp/tools'), api('/mcp')]);
      setTools(toolsRes.tools || []);
      setServerEnabled(Boolean(status.enabled));
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [canPersist]);

  const loadDetail = useCallback(async (id) => {
    if (!id || !canPersist) return;
    setBusy(true);
    try {
      const tool = await api(`/mcp/tools/${encodeURIComponent(id)}`);
      setDetail(tool);
      setSelectedId(tool.id || tool.name);
      const next = draftFromTool(tool);
      setDraft(next);
      setBaseline(serializeDraft(next));
      setSchemaError(null);
    } catch (err) {
      window.alert(`Could not load tool: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [canPersist]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  function confirmDiscard() {
    if (!dirty) return true;
    return window.confirm('Discard unsaved changes to this tool?');
  }

  async function selectTool(id) {
    if (id === selectedId) return;
    if (!confirmDiscard()) return;
    await loadDetail(id);
  }

  function startCreate() {
    if (!confirmDiscard()) return;
    setSelectedId(null);
    setDetail(null);
    const next = { ...EMPTY_DRAFT };
    setDraft(next);
    setBaseline(serializeDraft(next));
    setSchemaError(null);
  }

  function parseSchema() {
    try {
      const parsed = draft.inputSchemaText.trim()
        ? JSON.parse(draft.inputSchemaText)
        : DEFAULT_SCHEMA;
      setSchemaError(null);
      return parsed;
    } catch (err) {
      setSchemaError(err.message || 'Invalid JSON');
      return null;
    }
  }

  async function saveDraft() {
    if (!canPersist || busy) return;
    if (isBuiltin) {
      setBusy(true);
      try {
        const saved = await api(`/mcp/tools/${encodeURIComponent(selectedId)}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: draft.enabled !== false }),
        });
        setDetail(saved);
        const next = draftFromTool(saved);
        setDraft(next);
        setBaseline(serializeDraft(next));
        await refreshList();
      } catch (err) {
        window.alert(`Could not update tool: ${err.message}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    const inputSchema = parseSchema();
    if (!inputSchema) {
      window.alert('Fix the input schema JSON before saving.');
      return;
    }
    const name = draft.name.trim();
    const description = draft.description.trim();
    if (!name || !description) {
      window.alert('Name and description are required.');
      return;
    }

    setBusy(true);
    try {
      const payload = {
        name,
        description,
        inputSchema,
        body: draft.body,
        enabled: draft.enabled !== false,
      };
      let saved;
      if (selectedId) {
        saved = await api(`/mcp/tools/${encodeURIComponent(selectedId)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        saved = await api('/mcp/tools', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setDetail(saved);
      setSelectedId(saved.id || saved.name);
      const next = draftFromTool(saved);
      setDraft(next);
      setBaseline(serializeDraft(next));
      await refreshList();
    } catch (err) {
      window.alert(`Could not save tool: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeTool() {
    if (!selectedId || !canPersist || isBuiltin) return;
    if (!window.confirm(`Delete custom tool "${selectedId}"?`)) return;
    setBusy(true);
    try {
      await api(`/mcp/tools/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      setSelectedId(null);
      setDetail(null);
      const next = { ...EMPTY_DRAFT };
      setDraft(next);
      setBaseline(serializeDraft(next));
      await refreshList();
    } catch (err) {
      window.alert(`Could not delete: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(id, enabled) {
    if (!canPersist || busy) return;
    setBusy(true);
    try {
      await api(`/mcp/tools/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      if (selectedId === id) {
        setDraft((d) => ({ ...d, enabled }));
        setBaseline((b) => {
          try {
            const parsed = JSON.parse(b);
            return JSON.stringify({ ...parsed, enabled });
          } catch {
            return b;
          }
        });
        setDetail((d) => (d ? { ...d, enabled } : d));
      }
      await refreshList();
    } catch (err) {
      window.alert(`Could not update tool: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!canPersist) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          The Tools editor needs the local server (<code className="text-sky-300">kusa serve</code>).
          Open the dashboard over HTTP to create and manage MCP tools.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">MCP tools</h2>
        <p className="mt-1 text-xs text-gray-500">
          Built-in and custom tools for <code className="text-sky-300">kusa mcp</code>.
          Custom tools live in <code className="text-sky-300">.kusa/custom-tools.json</code>
          and return a templated body (<code className="text-sky-300">{'{{arg}}'}</code>).
          Disabled tools are omitted from <code className="text-sky-300">tools/list</code>.
          {serverEnabled === false ? (
            <>
              {' '}The MCP server is off — turn it on under{' '}
              <span className="text-gray-300">Harness → MCP</span>.
            </>
          ) : null}
        </p>
      </div>

      {loadError ? (
        <p className="text-sm text-rose-400">Could not load tools: {loadError}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
        <section className="min-h-[28rem] rounded-xl border border-gray-800 bg-gray-900/40">
          <div className="flex items-center gap-1.5 border-b border-gray-800 p-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools…"
              aria-label="Search tools"
              className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
            />
            <IconButton label="New tool" icon={PlusIcon} disabled={busy} onClick={startCreate} />
            <IconButton label="Refresh" icon={RefreshIcon} disabled={busy} onClick={refreshList} />
          </div>
          <ul className="max-h-[36rem] overflow-y-auto p-1" role="listbox" aria-label="Tools">
            {filtered.map((t) => {
              const on = t.id === selectedId || t.name === selectedId;
              return (
                <li key={t.id || t.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`panel-list-item w-full rounded-md px-2 py-2 text-left transition-colors ${
                      on ? 'panel-list-item-active' : 'hover:bg-gray-800/80'
                    }`}
                    onClick={() => selectTool(t.id || t.name)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-gray-100">{t.name}</span>
                      <span className={`shrink-0 text-[10px] uppercase tracking-wide ${
                        t.builtin ? 'text-sky-300' : 'text-emerald-400'
                      }`}
                      >
                        {t.builtin ? 'Built-in' : 'Custom'}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{t.description}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={`text-[10px] uppercase tracking-wide ${
                          t.enabled !== false ? 'text-emerald-400' : 'text-gray-500'
                        }`}
                      >
                        {t.enabled !== false ? 'Enabled' : 'Disabled'}
                      </span>
                      <span
                        role="presentation"
                        className="inline-flex"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="h-3 w-3 rounded border-gray-600 bg-gray-800 accent-emerald-500"
                          checked={t.enabled !== false}
                          disabled={busy}
                          aria-label={`Enable ${t.name}`}
                          onChange={(e) => toggleEnabled(t.id || t.name, e.target.checked)}
                        />
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
            {!filtered.length ? (
              <li className="px-2 py-6 text-center text-xs text-gray-500">No tools match.</li>
            ) : null}
          </ul>
        </section>

        <section className="min-h-[28rem] space-y-4 rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-100">
              {creating ? 'Create tool' : isBuiltin ? `Built-in · ${selectedId}` : `Edit · ${selectedId}`}
              {dirty ? <span className="ml-2 text-xs font-normal text-amber-400">Unsaved</span> : null}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <IconButton label="Save" icon={SaveIcon} variant="primary" disabled={busy || !dirty} onClick={saveDraft} />
              {selectedId && !isBuiltin ? (
                <IconButton label="Delete" icon={TrashIcon} variant="danger" disabled={busy} onClick={removeTool} />
              ) : null}
            </div>
          </div>

          {isBuiltin ? (
            <p className="text-xs text-gray-500">
              Built-in tools are read-only here. You can enable or disable them for MCP advertisement.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              Names must match <code className="text-sky-300">kusa_[a-z][a-z0-9_]*</code>.
              Use <code className="text-sky-300">{'{{arg}}'}</code> in the body to substitute call arguments.
            </p>
          )}

          <label className="inline-flex items-center gap-1.5 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={draft.enabled !== false}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              className="accent-emerald-500"
            />
            Advertise on MCP <code className="text-sky-300">tools/list</code>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-gray-400 sm:col-span-2">
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                disabled={isBuiltin}
                placeholder="kusa_my_tool"
                className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-sm text-gray-100 disabled:opacity-60"
              />
            </label>
            <label className="block text-xs text-gray-400 sm:col-span-2">
              Description
              <textarea
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                disabled={isBuiltin}
                rows={3}
                className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100 disabled:opacity-60"
              />
            </label>
          </div>

          <label className="block text-xs text-gray-400">
            Input schema (JSON)
            <textarea
              value={draft.inputSchemaText}
              onChange={(e) => {
                setDraft((d) => ({ ...d, inputSchemaText: e.target.value }));
                setSchemaError(null);
              }}
              disabled={isBuiltin}
              spellCheck={false}
              aria-label="Tool input schema"
              className="mt-1 h-40 w-full rounded-md border border-gray-700 bg-gray-950 p-3 font-mono text-xs text-gray-200 disabled:opacity-60"
            />
            {schemaError ? <span className="mt-1 block text-rose-400">Invalid JSON: {schemaError}</span> : null}
          </label>

          {!isBuiltin ? (
            <label className="block text-xs text-gray-400">
              Response body template
              <textarea
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                spellCheck={false}
                aria-label="Tool response body"
                className="mt-1 h-48 w-full rounded-md border border-gray-700 bg-gray-950 p-3 font-mono text-xs text-gray-200"
              />
            </label>
          ) : null}
        </section>
      </div>
    </div>
  );
}
