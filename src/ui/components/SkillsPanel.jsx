import { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownBody } from './MarkdownBody.jsx';
import {
  CloseIcon,
  CopyIcon,
  ExportIcon,
  IconButton,
  ImportIcon,
  PlusIcon,
  PreviewIcon,
  PublishIcon,
  RefreshIcon,
  RestoreIcon,
  SaveIcon,
  TrashIcon,
} from './IconButton.jsx';
import { stamp } from '../lib/format.js';

const EMPTY_DRAFT = {
  name: '',
  description: '',
  category: 'general',
  body: '# Instructions\n\n',
  skillMd: '',
  rawMode: false,
};

function statusLabel(status) {
  if (status === 'published') return 'Published';
  if (status === 'diverged') return 'Diverged';
  if (status === 'partial') return 'Partial';
  if (status === 'failed') return 'Failed';
  return 'Unpublished';
}

function statusClass(status) {
  if (status === 'published') return 'text-emerald-400';
  if (status === 'diverged') return 'text-amber-400';
  if (status === 'partial' || status === 'failed') return 'text-rose-400';
  return 'text-gray-500';
}

function buildSkillMdFromForm(draft) {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const lines = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`];
  if (draft.category && draft.category !== 'general') {
    lines.push('metadata:');
    lines.push(`  category: ${draft.category}`);
  }
  lines.push('---', '', draft.body.replace(/^\n+/, ''));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

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

export function SkillsPanel({ canPersist = true, embedded = false }) {
  const [skills, setSkills] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [validation, setValidation] = useState(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishKeys, setPublishKeys] = useState([]);
  const [publishPreview, setPublishPreview] = useState(null);
  const [publishOverwrite, setPublishOverwrite] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');

  const dirty = useMemo(() => {
    if (!selectedId && !draft.name && !draft.description && draft.body === EMPTY_DRAFT.body) return false;
    const current = draft.rawMode ? draft.skillMd : buildSkillMdFromForm(draft);
    return current !== baseline;
  }, [draft, baseline, selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      [s.name, s.description, s.category, s.publicationStatus].join(' ').toLowerCase().includes(q),
    );
  }, [skills, query]);

  const refreshList = useCallback(async () => {
    if (!canPersist) return;
    try {
      const data = await api('/skills');
      setSkills(data.skills || []);
      setAgents(data.agents || []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [canPersist]);

  const loadDetail = useCallback(async (id) => {
    if (!id || !canPersist) return;
    setBusy(true);
    try {
      const skill = await api(`/skills/${id}`);
      setDetail(skill);
      setSelectedId(skill.id);
      const next = {
        name: skill.name || '',
        description: skill.description || '',
        category: skill.category || 'general',
        body: skill.body || '',
        skillMd: skill.skillMd || '',
        rawMode: false,
      };
      setDraft(next);
      setBaseline(buildSkillMdFromForm(next));
      setValidation(skill.validation || null);
      setPreviewMode(false);
    } catch (err) {
      window.alert(`Could not load skill: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [canPersist]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  function confirmDiscard() {
    if (!dirty) return true;
    return window.confirm('Discard unsaved changes to this skill?');
  }

  async function selectSkill(id) {
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
    setBaseline(buildSkillMdFromForm(next));
    setValidation(null);
    setPreviewMode(false);
  }

  async function saveDraft() {
    if (!canPersist || busy) return;
    setBusy(true);
    try {
      const payload = draft.rawMode
        ? { skillMd: draft.skillMd }
        : {
            name: draft.name.trim(),
            description: draft.description.trim(),
            category: draft.category.trim() || 'general',
            body: draft.body,
            frontmatter: {
              name: draft.name.trim(),
              description: draft.description.trim(),
            },
          };
      let saved;
      if (selectedId) {
        saved = await api(`/skills/${selectedId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        saved = await api('/skills', { method: 'POST', body: JSON.stringify(payload) });
      }
      setDetail(saved);
      setSelectedId(saved.id);
      const next = {
        name: saved.name || '',
        description: saved.description || '',
        category: saved.category || 'general',
        body: saved.body || '',
        skillMd: saved.skillMd || '',
        rawMode: draft.rawMode,
      };
      setDraft(next);
      setBaseline(draft.rawMode ? saved.skillMd : buildSkillMdFromForm({ ...next, rawMode: false }));
      setValidation(saved.validation || null);
      await refreshList();
    } catch (err) {
      setValidation(err.data?.validation || { ok: false, errors: [err.message], warnings: [] });
      window.alert(`Could not save skill: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeSkill() {
    if (!selectedId || !canPersist) return;
    if (!window.confirm(`Delete skill "${selectedId}"? This removes it from Kusă's canonical store, not from published agent directories.`)) {
      return;
    }
    setBusy(true);
    try {
      await api(`/skills/${selectedId}`, { method: 'DELETE' });
      setSelectedId(null);
      setDetail(null);
      setDraft(EMPTY_DRAFT);
      setBaseline(buildSkillMdFromForm(EMPTY_DRAFT));
      await refreshList();
    } catch (err) {
      window.alert(`Could not delete: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!selectedId || !canPersist) return;
    if (!confirmDiscard()) return;
    setBusy(true);
    try {
      const copy = await api(`/skills/${selectedId}/duplicate`, { method: 'POST', body: '{}' });
      await refreshList();
      await loadDetail(copy.id);
    } catch (err) {
      window.alert(`Could not duplicate: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function restoreDefault() {
    if (!selectedId || !detail?.starterId) return;
    const customized = detail.starterCustomized;
    if (customized && !window.confirm('Restore the starter default and discard your customizations?')) {
      return;
    }
    setBusy(true);
    try {
      const saved = await api(`/skills/${selectedId}/restore`, {
        method: 'POST',
        body: JSON.stringify({ confirmCustomized: true }),
      });
      await refreshList();
      await loadDetail(saved.id);
    } catch (err) {
      window.alert(`Could not restore: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportSkill() {
    if (!selectedId) return;
    try {
      const data = await api(`/skills/${selectedId}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.name || selectedId}.skill.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert(`Export failed: ${err.message}`);
    }
  }

  async function runImport() {
    if (!importText.trim()) return;
    setBusy(true);
    try {
      let files;
      const trimmed = importText.trim();
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        files = parsed.files || [{ rel: 'SKILL.md', content: parsed.skillMd || trimmed }];
      } else {
        files = [{ rel: 'SKILL.md', content: trimmed }];
      }
      const imported = await api('/skills/import', {
        method: 'POST',
        body: JSON.stringify({ files }),
      });
      setImportOpen(false);
      setImportText('');
      await refreshList();
      await loadDetail(imported.id);
    } catch (err) {
      window.alert(`Import failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function openPublish() {
    if (!selectedId) return;
    if (dirty) {
      window.alert('Save the skill before publishing.');
      return;
    }
    const preferred = [];
    for (const agent of agents) {
      if (!agent.detected) continue;
      const dest = agent.destinations.find((d) => d.preferred) || agent.destinations[0];
      if (dest) preferred.push(dest.key);
    }
    setPublishKeys([...new Set(preferred)]);
    setPublishPreview(null);
    setPublishOverwrite(false);
    setPublishOpen(true);
  }

  async function previewPublish() {
    if (!selectedId || !publishKeys.length) return;
    setBusy(true);
    try {
      const result = await api(`/skills/${selectedId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ keys: publishKeys, dryRun: true, overwrite: publishOverwrite }),
      });
      setPublishPreview(result);
    } catch (err) {
      window.alert(`Preview failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPublish({ retryKeys = null } = {}) {
    if (!selectedId) return;
    const keys = retryKeys || publishKeys;
    if (!keys.length) return;
    if (publishOverwrite && !window.confirm('Overwrite destinations that differ from the canonical skill?')) {
      return;
    }
    setBusy(true);
    try {
      const result = await api(`/skills/${selectedId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          keys: retryKeys ? undefined : publishKeys,
          retryKeys,
          dryRun: false,
          overwrite: publishOverwrite,
        }),
      });
      setPublishPreview(result);
      await refreshList();
      await loadDetail(selectedId);
    } catch (err) {
      window.alert(`Publish failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function togglePublishKey(key) {
    setPublishKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    setPublishPreview(null);
  }

  function toggleRawMode(on) {
    if (on) {
      const skillMd = draft.rawMode ? draft.skillMd : buildSkillMdFromForm(draft);
      setDraft((d) => ({ ...d, rawMode: true, skillMd }));
    } else {
      setDraft((d) => ({ ...d, rawMode: false }));
    }
  }

  if (!canPersist) {
    return (
      <div className="space-y-4">
        {embedded ? null : <h2 className="text-base font-semibold">Skills</h2>}
        <p className="text-sm text-gray-400">
          The Skills editor needs the local server (<code className="text-sky-300">kusa serve</code>).
          Open the dashboard over HTTP to create, edit, and publish agent skills.
        </p>
      </div>
    );
  }

  const pubs = detail?.publications || {};

  return (
    <div className="space-y-4">
      {embedded ? null : (
        <div>
          <h2 className="text-base font-semibold">Skills</h2>
          <p className="mt-1 text-xs text-gray-500">
            Canonical store in <code className="text-sky-300">.kusa/skills/</code>. Publish copies into
            agent skill directories without treating those copies as the source of truth.
          </p>
        </div>
      )}

      {loadError ? (
        <p className="text-sm text-rose-400">Could not load skills: {loadError}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
        <section className="min-h-[28rem] rounded-xl border border-gray-800 bg-gray-900/40">
          <div className="flex items-center gap-1.5 border-b border-gray-800 p-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              aria-label="Search skills"
              className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
            />
            <IconButton label="New skill" icon={PlusIcon} disabled={busy} onClick={startCreate} />
            <IconButton label="Import skill" icon={ImportIcon} disabled={busy} onClick={() => setImportOpen(true)} />
            <IconButton label="Refresh" icon={RefreshIcon} disabled={busy} onClick={refreshList} />
          </div>
          <ul className="max-h-[36rem] overflow-y-auto p-1" role="listbox" aria-label="Skills">
            {filtered.map((s) => {
              const on = s.id === selectedId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`panel-list-item w-full rounded-md px-2 py-2 text-left transition-colors ${
                      on ? 'panel-list-item-active' : 'hover:bg-gray-800/80'
                    }`}
                    onClick={() => selectSkill(s.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-gray-100">{s.name}</span>
                      <span className={`shrink-0 text-[10px] uppercase tracking-wide ${statusClass(s.publicationStatus)}`}>
                        {statusLabel(s.publicationStatus)}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{s.description}</p>
                    <p className="mt-1 text-[10px] text-gray-600">{s.category}</p>
                  </button>
                </li>
              );
            })}
            {!filtered.length ? (
              <li className="px-2 py-6 text-center text-xs text-gray-500">No skills match.</li>
            ) : null}
          </ul>
        </section>

        <section className="min-h-[28rem] space-y-4 rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-100">
              {selectedId ? `Edit · ${selectedId}` : 'Create skill'}
              {dirty ? <span className="ml-2 text-xs font-normal text-amber-400">Unsaved</span> : null}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <IconButton label="Save" icon={SaveIcon} variant="primary" disabled={busy || !dirty} onClick={saveDraft} />
              {selectedId ? (
                <>
                  <IconButton label="Publish…" icon={PublishIcon} disabled={busy} onClick={openPublish} />
                  <IconButton label="Duplicate" icon={CopyIcon} disabled={busy} onClick={duplicate} />
                  <IconButton label="Export" icon={ExportIcon} disabled={busy} onClick={exportSkill} />
                  {detail?.starterId ? (
                    <IconButton label="Restore default" icon={RestoreIcon} disabled={busy} onClick={restoreDefault} />
                  ) : null}
                  <IconButton label="Delete" icon={TrashIcon} variant="danger" disabled={busy} onClick={removeSkill} />
                </>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.rawMode}
                onChange={(e) => toggleRawMode(e.target.checked)}
                className="accent-emerald-500"
              />
              Raw SKILL.md
            </label>
            {!draft.rawMode ? (
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={previewMode}
                  onChange={(e) => setPreviewMode(e.target.checked)}
                  className="accent-emerald-500"
                />
                Preview body
              </label>
            ) : null}
          </div>

          {validation && (!validation.ok || (validation.warnings || []).length) ? (
            <div className={`rounded-md border px-3 py-2 text-xs ${validation.ok ? 'border-amber-800/60 text-amber-300' : 'border-rose-800/60 text-rose-300'}`}>
              {(validation.errors || []).map((e) => <div key={e}>Error: {e}</div>)}
              {(validation.warnings || []).map((w) => <div key={w}>Warning: {w}</div>)}
            </div>
          ) : null}

          {draft.rawMode ? (
            <textarea
              value={draft.skillMd}
              onChange={(e) => setDraft((d) => ({ ...d, skillMd: e.target.value }))}
              spellCheck={false}
              aria-label="Raw SKILL.md"
              className="h-[28rem] w-full rounded-md border border-gray-700 bg-gray-950 p-3 font-mono text-xs text-gray-200"
            />
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-gray-400">
                  Name
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder="my-skill"
                    className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-sm text-gray-100"
                  />
                </label>
                <label className="block text-xs text-gray-400">
                  Category
                  <input
                    value={draft.category}
                    onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                    className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100"
                  />
                </label>
              </div>
              <label className="block text-xs text-gray-400">
                Description
                <textarea
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={3}
                  className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100"
                />
              </label>
              <div>
                <div className="mb-1 text-xs text-gray-400">Instructions</div>
                {previewMode ? (
                  <MarkdownBody text={draft.body} />
                ) : (
                  <textarea
                    value={draft.body}
                    onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                    spellCheck={false}
                    aria-label="Skill instructions"
                    className="h-72 w-full rounded-md border border-gray-700 bg-gray-950 p-3 font-mono text-xs text-gray-200"
                  />
                )}
              </div>
            </div>
          )}

          {selectedId && Object.keys(pubs).length ? (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Published destinations</h4>
              <ul className="space-y-1 text-xs text-gray-300">
                {Object.entries(pubs).map(([key, pub]) => (
                  <li key={key} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-gray-800 px-2 py-1.5">
                    <span>
                      <code className="text-sky-300">{key}</code>
                      {pub.skillDir ? <span className="text-gray-500"> → {pub.skillDir}</span> : null}
                    </span>
                    <span className={statusClass(pub.diverged ? 'diverged' : pub.status)}>
                      {pub.diverged ? 'diverged' : pub.status}
                      {pub.lastPublishedAtWall ? ` · ${stamp(pub.lastPublishedAtWall)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {detail?.resources?.length ? (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">Supporting resources</h4>
              <ul className="text-xs text-gray-400">
                {detail.resources.map((r) => (
                  <li key={r.rel}><code className="text-sky-300">{r.rel}</code> · {r.size} B</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>

      {publishOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Publish skill">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-gray-700 bg-gray-950 p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Publish {selectedId}</h3>
              <IconButton label="Close" icon={CloseIcon} onClick={() => setPublishOpen(false)} />
            </div>
            <p className="mb-3 text-xs text-gray-500">
              Prefer <code className="text-sky-300">.agents/skills/</code> when agents share it. Destinations that map to the same path are written once.
            </p>
            <div className="space-y-3">
              {agents.map((agent) => (
                <div key={agent.id} className="rounded-md border border-gray-800 p-2">
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-gray-200">{agent.label}</span>
                    <span className={`text-[10px] uppercase ${agent.detected ? 'text-emerald-400' : 'text-gray-600'}`}>
                      {agent.detected ? 'detected' : 'not detected'}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {agent.destinations.map((d) => (
                      <label key={d.key} className="flex items-start gap-2 text-xs text-gray-300">
                        <input
                          type="checkbox"
                          checked={publishKeys.includes(d.key)}
                          onChange={() => togglePublishKey(d.key)}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <span>
                          <code className="text-sky-300">{d.relRoot}</code>
                          {d.preferred ? <span className="text-gray-500"> · preferred</span> : null}
                          {d.note ? <span className="block text-gray-600">{d.note}</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={publishOverwrite}
                onChange={(e) => setPublishOverwrite(e.target.checked)}
                className="accent-emerald-500"
              />
              Overwrite destinations that diverged from the canonical skill
            </label>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <IconButton
                label="Dry-run preview"
                icon={PreviewIcon}
                disabled={busy || !publishKeys.length}
                onClick={previewPublish}
              />
              <IconButton
                label="Publish"
                icon={PublishIcon}
                variant="primary"
                disabled={busy || !publishKeys.length}
                onClick={() => confirmPublish()}
              />
              {publishPreview?.summary?.failed || publishPreview?.summary?.conflict ? (
                <IconButton
                  label="Retry failed"
                  icon={RefreshIcon}
                  disabled={busy}
                  onClick={() => confirmPublish({
                    retryKeys: (publishPreview.results || [])
                      .filter((r) => r.status === 'failed' || r.status === 'conflict')
                      .map((r) => r.key),
                  })}
                />
              ) : null}
            </div>
            {publishPreview ? (
              <div className="mt-4 space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Results</h4>
                <p className="text-xs text-gray-500">
                  published {publishPreview.summary?.published ?? 0} · skipped {publishPreview.summary?.skipped ?? 0} ·
                  conflict {publishPreview.summary?.conflict ?? 0} · failed {publishPreview.summary?.failed ?? 0} ·
                  dry-run {publishPreview.summary?.dryRun ?? 0}
                </p>
                <ul className="space-y-1 text-xs">
                  {(publishPreview.results || []).map((r) => (
                    <li key={r.key} className="rounded border border-gray-800 px-2 py-1.5">
                      <div className="flex justify-between gap-2">
                        <span><code className="text-sky-300">{r.key}</code> → {r.skillDir}</span>
                        <span className={statusClass(r.status === 'published' || r.status === 'skipped' || r.status === 'dry-run' ? 'published' : r.status === 'conflict' ? 'diverged' : 'failed')}>
                          {r.status}
                        </span>
                      </div>
                      {r.error ? <div className="text-rose-400">{r.error}</div> : null}
                      {r.actions?.length ? (
                        <div className="mt-1 text-gray-500">
                          {r.actions.slice(0, 8).map((a) => `${a.op}:${a.rel}`).join(' · ')}
                          {r.actions.length > 8 ? ' …' : ''}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {importOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Import skill">
          <div className="w-full max-w-xl rounded-xl border border-gray-700 bg-gray-950 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Import skill</h3>
              <IconButton label="Close" icon={CloseIcon} onClick={() => setImportOpen(false)} />
            </div>
            <p className="mb-2 text-xs text-gray-500">
              Paste a full <code className="text-sky-300">SKILL.md</code> or an exported JSON payload. Scripts are not executed.
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              className="h-64 w-full rounded-md border border-gray-700 bg-gray-900 p-2 font-mono text-xs text-gray-200"
              aria-label="Import skill content"
            />
            <div className="mt-3 flex justify-end gap-1.5">
              <IconButton
                label="Import"
                icon={ImportIcon}
                variant="primary"
                disabled={busy || !importText.trim()}
                onClick={runImport}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
