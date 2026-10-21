import { useCallback, useEffect, useState } from 'react';
import { IconButton, PlusIcon } from './IconButton.jsx';
import { stamp } from '../lib/format.js';

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

export function KnowledgebasePanel({ canPersist = true }) {
  const [learnings, setLearnings] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const refresh = useCallback(async () => {
    if (!canPersist) return;
    try {
      const notes = await api('/learnings');
      setLearnings(notes.learnings || []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [canPersist]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function submitLearning(e) {
    e.preventDefault();
    if (!canPersist || busy) return;
    setBusy(true);
    try {
      await api('/learnings', {
        method: 'POST',
        body: JSON.stringify({ title, body }),
      });
      setTitle('');
      setBody('');
      await refresh();
    } catch (err) {
      window.alert(`Could not add learning: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!canPersist) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold">Knowledgebase</h2>
        <p className="text-sm text-gray-400">
          Open the dashboard over HTTP (<code className="text-sky-300">kusa serve</code>) to browse
          and add Trail learnings.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="mb-1 text-base font-semibold">Knowledgebase</h2>
        <p className="text-xs text-gray-500">
          Trail learnings — team memory from <code className="text-sky-300">.trail/learnings/</code>.
          Agents can list and add these through MCP when the server is on.
        </p>
      </div>
      {loadError ? (
        <p className="text-sm text-rose-400">Could not load learnings: {loadError}</p>
      ) : null}
      <form onSubmit={submitLearning} className="space-y-2 rounded-xl border border-gray-800 bg-gray-900/40 p-3">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          required
          className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-600"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What was decided, tried, or ruled out…"
          required
          rows={3}
          className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-600"
        />
        <div className="flex justify-end">
          <IconButton
            type="submit"
            label="Add learning"
            icon={PlusIcon}
            variant="primary"
            disabled={busy || !title.trim() || !body.trim()}
          />
        </div>
      </form>
      <ul className="space-y-2">
        {learnings.length ? learnings.map((item) => {
          const open = expandedId === item.id;
          return (
            <li key={item.id} className="rounded-xl border border-gray-800">
              <button
                type="button"
                className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left hover:bg-gray-900/60"
                onClick={() => setExpandedId(open ? null : item.id)}
              >
                <div className="min-w-0">
                  <p className="text-sm text-gray-100">{item.title}</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {[item.author, item.date, item.scope].filter(Boolean).join(' · ')}
                    {item.preview && !open ? ` — ${item.preview.slice(0, 120)}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-gray-600">{open ? 'Hide' : 'Show'}</span>
              </button>
              {open ? (
                <div className="border-t border-gray-800 px-3 py-2">
                  <pre className="whitespace-pre-wrap text-xs text-gray-300">{item.body}</pre>
                  {item.path ? (
                    <p className="mt-2 font-mono text-[11px] text-gray-600">{item.path}</p>
                  ) : null}
                  {item.date ? (
                    <p className="mt-1 text-[11px] text-gray-600">{stamp(Date.parse(item.date))}</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        }) : (
          <li className="rounded-xl border border-dashed border-gray-800 px-3 py-6 text-center text-sm text-gray-500">
            No learnings yet. Add one above or run <code className="text-sky-300">trail note</code>.
          </li>
        )}
      </ul>
    </div>
  );
}
