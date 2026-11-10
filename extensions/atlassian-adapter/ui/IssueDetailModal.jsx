/**
 * Full-screen ticket popup: fields, status transitions, dates, description, comments.
 */
import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState } from 'react';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

function statusTone(category) {
  if (category === 'done') return 'bg-emerald-500/20 text-emerald-300';
  if (category === 'indeterminate') return 'bg-sky-500/20 text-sky-300';
  return 'bg-gray-700/60 text-gray-300';
}

function stamp(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function toDateInput(iso) {
  if (!iso) return '';
  const s = String(iso);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * @param {{
 *   open: boolean,
 *   issueKey: string | null,
 *   detail: object | null,
 *   transitions?: object[],
 *   comments?: object[],
 *   members?: object[],
 *   loading?: boolean,
 *   busy?: boolean,
 *   error?: string | null,
 *   onClose: () => void,
 *   onTransition: (transitionId: string) => void | Promise<void>,
 *   onSave: (patch: object) => void | Promise<void>,
 *   onComment: (body: string) => void | Promise<void>,
 * }} props
 */
function sameLabelSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  return left.every((v, i) => v === right[i]);
}

export function IssueDetailModal({
  open,
  issueKey,
  detail,
  transitions = [],
  comments = [],
  members = [],
  labelOptions = [],
  loading = false,
  busy = false,
  error = null,
  onClose,
  onTransition,
  onSave,
  onComment,
}) {
  const titleId = useId();
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [duedate, setDuedate] = useState('');
  const [assigneeAccountId, setAssigneeAccountId] = useState('');
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [localError, setLocalError] = useState(null);

  // Focus trap setup only when the modal opens — not when parent re-creates
  // onClose (that was yanking focus back to the X while typing / using selects).
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!detail) return;
    setSummary(detail.summary || '');
    setDescription(detail.description || '');
    setDuedate(toDateInput(detail.duedate));
    setAssigneeAccountId(detail.assigneeAccountId || '');
    setSelectedLabels(Array.isArray(detail.labels) ? detail.labels.map(String) : []);
    setCommentDraft('');
    setLocalError(null);
  }, [
    detail?.key,
    detail?.updated,
    detail?.summary,
    detail?.description,
    detail?.duedate,
    detail?.assigneeAccountId,
    // Stable string form — array identity changes every fetch.
    Array.isArray(detail?.labels) ? detail.labels.join('\0') : '',
  ]);

  if (!open || typeof document === 'undefined') return null;

  const detailLabels = Array.isArray(detail?.labels) ? detail.labels.map(String) : [];
  const labelChoices = (() => {
    const set = new Set([
      ...labelOptions.map(String),
      ...detailLabels,
      ...selectedLabels,
    ].map((v) => v.trim()).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  })();

  const dirty = detail && (
    summary !== (detail.summary || '')
    || description !== (detail.description || '')
    || duedate !== toDateInput(detail.duedate)
    || assigneeAccountId !== (detail.assigneeAccountId || '')
    || !sameLabelSet(selectedLabels, detailLabels)
  );

  function toggleLabel(label) {
    setSelectedLabels((prev) => (
      prev.includes(label)
        ? prev.filter((x) => x !== label)
        : [...prev, label]
    ));
  }

  async function saveFields(event) {
    event?.preventDefault?.();
    if (!detail || !dirty || busy) return;
    setLocalError(null);
    try {
      await onSave?.({
        summary,
        description,
        duedate: duedate || null,
        assigneeAccountId: assigneeAccountId || null,
        labels: selectedLabels,
      });
    } catch (err) {
      setLocalError(err?.message || String(err));
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    const text = commentDraft.trim();
    if (!text || busy) return;
    setLocalError(null);
    try {
      await onComment?.(text);
      setCommentDraft('');
    } catch (err) {
      setLocalError(err?.message || String(err));
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        // Only the real backdrop — native <select>/<input type="date"> menus can
        // land events on this overlay; treating those as dismiss broke focus.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(44rem,92vh)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-950 shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-gray-800 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span id={titleId} className="font-mono text-sm text-sky-300">
                {detail?.key || issueKey || 'Issue'}
              </span>
              {detail?.status ? (
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${statusTone(detail.statusCategory)}`}>
                  {detail.status}
                </span>
              ) : null}
              {detail?.issuetype ? (
                <span className="text-[10px] text-gray-500">{detail.issuetype}</span>
              ) : null}
              {detail?.priority ? (
                <span className="text-[10px] text-gray-500">{detail.priority}</span>
              ) : null}
              {detail?.url ? (
                <a
                  href={detail.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-gray-500 underline hover:text-gray-300"
                >
                  Open in Jira
                  <LucideIcon name="external-link" className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            <p className="truncate text-xs text-gray-500">
              {detail?.assignee ? `${detail.assignee} · ` : 'Unassigned · '}
              {detail?.epicKey ? `${detail.epicKey} · ` : ''}
              {detail?.updated ? `updated ${stamp(detail.updated)}` : ''}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-900 hover:text-gray-100"
            aria-label="Close ticket"
            title="Close"
          >
            <LucideIcon name="x" className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {loading && !detail ? (
            <p className="py-10 text-center text-xs text-gray-500">Loading {issueKey}…</p>
          ) : null}

          {(error || localError) ? (
            <p className="text-xs text-rose-400">{localError || error}</p>
          ) : null}

          {detail ? (
            <>
              <form className="space-y-3" onSubmit={(e) => void saveFields(e)}>
                <label className="block space-y-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Summary
                  </span>
                  <input
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-sm text-gray-100 disabled:opacity-50"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                      Assignee
                    </span>
                    <select
                      value={assigneeAccountId}
                      onChange={(e) => setAssigneeAccountId(e.target.value)}
                      disabled={busy}
                      className="w-full rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-100 disabled:opacity-50"
                    >
                      <option value="">Unassigned</option>
                      {detail.assigneeAccountId
                        && !members.some((m) => m.accountId === detail.assigneeAccountId) ? (
                          <option value={detail.assigneeAccountId}>
                            {detail.assignee || detail.assigneeAccountId}
                          </option>
                        ) : null}
                      {members.map((member) => (
                        <option key={member.accountId} value={member.accountId}>
                          {member.displayName || member.accountId}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                      Due date
                    </span>
                    <input
                      type="date"
                      value={duedate}
                      onChange={(e) => setDuedate(e.target.value)}
                      disabled={busy}
                      className="w-full rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-100 disabled:opacity-50"
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Description
                  </span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={6}
                    disabled={busy}
                    placeholder="No description."
                    className="w-full rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-100 placeholder:text-gray-600 disabled:opacity-50"
                  />
                </label>

                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Labels
                  </p>
                  {labelChoices.length === 0 ? (
                    <p className="text-xs text-gray-600">No Jira labels detected yet.</p>
                  ) : (
                    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-md border border-gray-800 bg-gray-950/50 p-2">
                      {labelChoices.map((label) => {
                        const on = selectedLabels.includes(label);
                        return (
                          <button
                            key={label}
                            type="button"
                            disabled={busy}
                            aria-pressed={on}
                            onClick={() => toggleLabel(label)}
                            className={`rounded-full px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                              on
                                ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/50'
                                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    disabled={busy || !dirty}
                    className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                  {dirty ? (
                    <span className="text-[11px] text-amber-300/80">Unsaved changes</span>
                  ) : null}
                  <span className="text-[11px] text-gray-600">
                    Created {stamp(detail.created) || '—'}
                    {detail.reporter ? ` · ${detail.reporter}` : ''}
                  </span>
                </div>
              </form>

              <div className="space-y-2 border-t border-gray-800 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Status
                </p>
                {transitions.length === 0 ? (
                  <p className="text-xs text-gray-600">No transitions available.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {transitions.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        disabled={busy}
                        onClick={() => void onTransition?.(t.id)}
                        className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-200 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50"
                        title={t.to ? `→ ${t.to}` : t.name}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2 border-t border-gray-800 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Comments
                </p>
                <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {comments.length === 0 ? (
                    <li className="text-xs text-gray-600">No comments yet.</li>
                  ) : (
                    comments.map((c) => (
                      <li key={c.id} className="rounded-md border border-gray-800 bg-gray-900/60 px-2.5 py-1.5">
                        <p className="text-[10px] text-gray-500">
                          {c.author || 'Unknown'}
                          {c.created ? ` · ${stamp(c.created)}` : ''}
                        </p>
                        <p className="whitespace-pre-wrap text-xs text-gray-300">{c.body}</p>
                      </li>
                    ))
                  )}
                </ul>
                <form onSubmit={(e) => void submitComment(e)} className="flex flex-col gap-2">
                  <textarea
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    rows={3}
                    disabled={busy}
                    placeholder="Add a comment…"
                    className="w-full rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-100 placeholder:text-gray-600 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={busy || !commentDraft.trim()}
                    className="self-start rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    Add comment
                  </button>
                </form>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
