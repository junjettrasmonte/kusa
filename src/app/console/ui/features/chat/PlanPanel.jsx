import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DRAWER_ICON_BTN, DRAWER_ICON_SIZE, PopupList, PopupToggle } from './PopupList.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { MarkdownBody } from '#ui/shared/MarkdownBody.jsx';
import { previewLine } from '#ui/shared/lib/chatText.js';

export const PLAN_MAX_HEIGHT_PX = 220;

const PLAN_STATUSES = ['draft', 'ready', 'approved', 'executing', 'done', 'cancelled'];

const STATUS_TONE = {
  draft: 'text-gray-500',
  ready: 'text-sky-300/80',
  approved: 'text-emerald-300/80',
  executing: 'text-amber-300/80',
  done: 'text-emerald-300/60',
  cancelled: 'text-gray-600',
};

const SCOPE_OPTIONS = [
  { id: 'session', label: 'This session' },
  { id: 'all', label: 'All plans' },
];

/** True when the plan's planner or orchestrator sits in this session's agent tree. */
export function planBelongsToSession(plan, sessionAgentIds = []) {
  const ids = sessionAgentIds instanceof Set
    ? sessionAgentIds
    : new Set(
      (Array.isArray(sessionAgentIds) ? sessionAgentIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    );
  if (!ids.size || !plan) return false;
  const creator = String(plan.createdByAgentId || '').trim();
  const orch = String(plan.orchestratorAgentId || '').trim();
  return (creator && ids.has(creator)) || (orch && ids.has(orch));
}

/** Plans assigned to this session tree (composer badge count). */
export function countSessionPlans(plans = [], sessionAgentIds = []) {
  const ids = sessionAgentIds instanceof Set
    ? sessionAgentIds
    : new Set(
      (Array.isArray(sessionAgentIds) ? sessionAgentIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    );
  if (!ids.size) return 0;
  return (Array.isArray(plans) ? plans : []).filter((plan) => planBelongsToSession(plan, ids)).length;
}

/**
 * Workspace Plan drawer — list first, click a row to load detail.
 * Plans are cross-Agent (`.kusa/plans/`), so the same list appears on every chat.
 */
export function PlanStack({
  plans = [],
  expanded = true,
  selectedId = null,
  selectedPlan = null,
  busy = false,
  note = '',
  dock = 'bottom',
  sessionId = '',
  sessionAgentIds = null,
  agents = null,
  onDockToggle = null,
  onClose = null,
  onSelect = null,
  onBack = null,
  onContinue = null,
  onRemove = null,
  onRefresh = null,
  onCreate = null,
  onSave = null,
  onSetStatus = null,
  onAssignToSession = null,
  onOpenAgent = null,
}) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('session');
  const [editing, setEditing] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const agentIdSet = useMemo(() => {
    const ids = new Set();
    const sid = String(sessionId || '').trim();
    if (sid) ids.add(sid);
    for (const id of Array.isArray(sessionAgentIds) ? sessionAgentIds : []) {
      const text = String(id || '').trim();
      if (text) ids.add(text);
    }
    return ids;
  }, [sessionId, sessionAgentIds]);

  const allPlans = Array.isArray(plans) ? plans : [];
  const scoped = scopeFilter === 'all' || agentIdSet.size === 0
    ? allPlans
    : allPlans.filter((plan) => {
      const creator = String(plan?.createdByAgentId || '').trim();
      const orch = String(plan?.orchestratorAgentId || '').trim();
      return (creator && agentIdSet.has(creator)) || (orch && agentIdSet.has(orch));
    });
  const filtered = statusFilter === 'all'
    ? scoped
    : scoped.filter((plan) => String(plan?.status || 'draft') === statusFilter);
  const total = filtered.length;
  const detail = selectedId && selectedPlan;
  const inEditor = Boolean(detail && editing);

  if (!expanded) return null;

  const summary = detail
    ? ''
    : (() => {
      const scopeLabel = scopeFilter === 'session' ? 'session' : 'all';
      if (statusFilter === 'all') {
        return `${scoped.length} plan${scoped.length === 1 ? '' : 's'} · ${scopeLabel}`;
      }
      return `${total} of ${scoped.length} · ${statusFilter} · ${scopeLabel}`;
    })();

  function leaveDetail() {
    setEditing(false);
    onBack?.();
  }

  async function startCreate() {
    if (!onCreate) return;
    const plan = await onCreate();
    if (plan?.id) setEditing(true);
  }

  async function startEdit(id) {
    if (!id) return;
    await onSelect?.(id);
    setEditing(true);
  }

  function requestDelete(id, name = '') {
    if (!id) return;
    setPendingDelete({ id, name: name || id });
  }

  async function confirmDelete() {
    if (!pendingDelete?.id) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    await onRemove?.(id, { confirmed: true });
  }

  const headerStart = detail ? (
    <button
      type="button"
      title="All plans"
      aria-label="All plans"
      onClick={leaveDetail}
      className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md pr-1 text-gray-400 hover:bg-gray-800/70 hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
    >
      <LucideIcon name="chevron-left" className={DRAWER_ICON_SIZE} />
      <span className="text-[10px]">All plans</span>
    </button>
  ) : null;

  const headerEnd = !detail ? (
    <>
      <button
        type="button"
        title="New plan"
        aria-label="New plan"
        onClick={() => { void startCreate(); }}
        className={DRAWER_ICON_BTN}
      >
        <LucideIcon name="plus" className={DRAWER_ICON_SIZE} />
      </button>
      <button
        type="button"
        title="Refresh plans"
        aria-label="Refresh plans"
        onClick={() => onRefresh?.()}
        className={DRAWER_ICON_BTN}
      >
        <LucideIcon name="refresh-cw" className={DRAWER_ICON_SIZE} />
      </button>
      <PlanScopeFilter
        open={scopeOpen}
        value={scopeFilter}
        onOpenChange={(open) => {
          setScopeOpen(open);
          if (open) setFilterOpen(false);
        }}
        onChange={setScopeFilter}
      />
      <PlanStatusFilter
        open={filterOpen}
        value={statusFilter}
        onOpenChange={(open) => {
          setFilterOpen(open);
          if (open) setScopeOpen(false);
        }}
        onChange={setStatusFilter}
      />
    </>
  ) : null;

  return (
    <PopupList
      expanded={expanded}
      count={detail ? 1 : Math.max(scoped.length, 1)}
      maxHeightPx={PLAN_MAX_HEIGHT_PX}
      summary={summary}
      headerStart={headerStart}
      headerEnd={headerEnd}
      ariaLabel="Workspace plans"
      dock={dock}
      onDockToggle={onDockToggle}
      onClose={onClose}
    >
      {inEditor ? (
        <PlanEditor
          plan={selectedPlan}
          busy={busy}
          note={note}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            const saved = await onSave?.(selectedPlan.id, patch);
            if (saved) setEditing(false);
          }}
        />
      ) : detail ? (
        <PlanDetail
          plan={selectedPlan}
          busy={busy}
          note={note}
          sessionId={sessionId}
          sessionAgentIds={[...agentIdSet]}
          agents={agents}
          onContinue={onContinue}
          onRemove={() => requestDelete(selectedPlan.id, selectedPlan.name)}
          onOpenAgent={onOpenAgent}
          onEdit={() => setEditing(true)}
          onSetStatus={onSetStatus}
          onAssignToSession={onAssignToSession}
        />
      ) : (
        <>
          {(busy || note) ? (
            <div className="flex flex-wrap items-center gap-1.5 pb-1">
              {busy ? <span className="text-[10px] text-gray-500">Updating…</span> : null}
              {note ? <span className="text-[10px] text-rose-400">{note}</span> : null}
            </div>
          ) : null}
          {allPlans.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-gray-500">
              No plans yet. Use + to add one, or let agents create them with kusa_plan_create.
            </p>
          ) : scoped.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-gray-500">
              No plans for this session. Switch to All plans, or create one.
            </p>
          ) : total === 0 ? (
            <p className="px-1 py-2 text-[11px] text-gray-500">
              No {statusFilter} plans.
            </p>
          ) : (
            filtered.map((plan) => (
              <PlanListRow
                key={plan.id}
                plan={plan}
                onClick={() => { setEditing(false); onSelect?.(plan.id); }}
                onEdit={() => { void startEdit(plan.id); }}
                onRemove={() => requestDelete(plan.id, plan.name)}
              />
            ))
          )}
        </>
      )}
      <DeleteConfirmPopup
        open={Boolean(pendingDelete)}
        name={pendingDelete?.name || ''}
        busy={busy}
        onConfirm={() => { void confirmDelete(); }}
        onDismiss={() => setPendingDelete(null)}
      />
    </PopupList>
  );
}

function PlanMenuFilter({
  open,
  value,
  onOpenChange,
  onChange,
  options,
  title,
  icon,
  active,
  menuLabel,
}) {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        onOpenChange?.(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') onOpenChange?.(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative inline-flex h-6 w-6 shrink-0">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onOpenChange?.(!open)}
        className={`${DRAWER_ICON_BTN} ${active || open ? 'text-violet-300 hover:text-violet-200' : ''}`}
      >
        <LucideIcon name={icon} className={DRAWER_ICON_SIZE} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={menuLabel}
          className="absolute right-0 top-full z-30 mt-1 min-w-[9.5rem] overflow-hidden rounded-md border border-gray-700 bg-gray-950 py-1 shadow-lg shadow-black/40"
        >
          {options.map((option) => {
            const selected = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  onChange?.(option.id);
                  onOpenChange?.(false);
                }}
                className={`block w-full px-2.5 py-1.5 text-left text-[11px] capitalize ${
                  selected
                    ? 'bg-gray-800/70 font-medium text-violet-300'
                    : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PlanStatusFilter({ open, value, onOpenChange, onChange }) {
  const options = useMemo(
    () => [{ id: 'all', label: 'All statuses' }, ...PLAN_STATUSES.map((id) => ({ id, label: id }))],
    [],
  );
  return (
    <PlanMenuFilter
      open={open}
      value={value}
      onOpenChange={onOpenChange}
      onChange={onChange}
      options={options}
      title="Filter by status"
      icon="filter"
      active={value !== 'all'}
      menuLabel="Filter plans by status"
    />
  );
}

function PlanScopeFilter({ open, value, onOpenChange, onChange }) {
  return (
    <PlanMenuFilter
      open={open}
      value={value}
      onOpenChange={onOpenChange}
      onChange={onChange}
      options={SCOPE_OPTIONS}
      title="This session or all plans"
      icon="folders"
      active={value !== 'session'}
      menuLabel="Filter plans by session"
    />
  );
}

function DeleteConfirmPopup({ open, name = '', busy = false, onConfirm, onDismiss }) {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        onDismiss?.();
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') onDismiss?.();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="plan-delete-title"
      className="sticky bottom-0 z-40 mt-2 rounded-md border border-rose-500/40 bg-gray-950 p-2.5 shadow-lg shadow-black/50"
    >
      <p id="plan-delete-title" className="text-[12px] font-medium text-rose-200">
        Delete this plan?
      </p>
      <p className="mt-1 truncate text-[11px] text-gray-400">
        {name || 'Untitled plan'}
      </p>
      <p className="mt-1 text-[10px] text-gray-500">
        Agents linked to it can be removed afterward.
      </p>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDismiss?.()}
          className="rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm?.()}
          className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
        >
          <LucideIcon name="trash-2" className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>
    </div>
  );
}

function PlanListRow({ plan, onClick, onEdit, onRemove }) {
  const name = String(plan?.name || plan?.id || 'Untitled').trim();
  const status = String(plan?.status || 'draft');
  const overview = String(plan?.overview || '').trim();
  return (
    <div
      role="listitem"
      className="group flex h-8 w-full items-center gap-1 px-1 hover:bg-gray-900/40"
    >
      <button
        type="button"
        title={overview || name}
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <p className="min-w-0 flex-1 truncate text-[12px] leading-tight text-gray-200">
          {previewLine(name, 80)}
        </p>
        <span
          className={`shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide ${STATUS_TONE[status] || STATUS_TONE.draft}`}
        >
          {status}
        </span>
      </button>
      <button
        type="button"
        title="Edit plan"
        aria-label={`Edit ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onEdit?.();
        }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-gray-600 opacity-70 hover:bg-gray-800 hover:text-gray-200 group-hover:opacity-100"
      >
        <LucideIcon name="pencil" className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Delete plan"
        aria-label={`Delete ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onRemove?.();
        }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-gray-600 opacity-70 hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
      >
        <LucideIcon name="trash-2" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function shortAgentId(id) {
  const text = String(id || '').trim();
  if (!text) return '';
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function agentLabel(agent) {
  if (!agent) return '';
  return String(agent.title || agent.name || agent.id || '').trim() || shortAgentId(agent.id);
}

function PlanEditor({ plan, busy = false, note = '', onCancel, onSave }) {
  const [name, setName] = useState(() => String(plan?.name || ''));
  const [overview, setOverview] = useState(() => String(plan?.overview || ''));
  const [body, setBody] = useState(() => String(plan?.body || ''));
  const [executionPrompt, setExecutionPrompt] = useState(() => String(plan?.executionPrompt || ''));

  useEffect(() => {
    setName(String(plan?.name || ''));
    setOverview(String(plan?.overview || ''));
    setBody(String(plan?.body || ''));
    setExecutionPrompt(String(plan?.executionPrompt || ''));
  }, [plan?.id, plan?.name, plan?.overview, plan?.body, plan?.executionPrompt]);

  const field =
    'w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-[12px] text-gray-100 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none';

  return (
    <div className="space-y-2 px-1 pb-2">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-1.5 border-b border-gray-800/80 bg-gray-950/95 px-1 pb-2 pt-0.5 backdrop-blur-sm">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave?.({ name, overview, body, executionPrompt })}
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
        >
          Save plan
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onCancel?.()}
          className="rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
        >
          Cancel
        </button>
        {busy ? <span className="text-[10px] text-gray-500">Saving…</span> : null}
        {note ? <span className="text-[10px] text-rose-400">{note}</span> : null}
      </div>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={field}
          placeholder="Plan title"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Overview</span>
        <input
          type="text"
          value={overview}
          onChange={(event) => setOverview(event.target.value)}
          className={field}
          placeholder="One-line summary"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Execution prompt</span>
        <textarea
          value={executionPrompt}
          onChange={(event) => setExecutionPrompt(event.target.value)}
          rows={3}
          className={`${field} resize-y text-[11px] leading-relaxed`}
          placeholder="Prompt sent when this plan is approved (editable even for workflow plans)"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Body</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={10}
          spellCheck={false}
          className={`${field} min-h-[10rem] resize-y font-mono text-[11px] leading-relaxed`}
          placeholder="Markdown plan body"
        />
      </label>
    </div>
  );
}

function planAssignmentState(plan, sessionAgentIds = []) {
  const ids = new Set(
    (Array.isArray(sessionAgentIds) ? sessionAgentIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const creator = String(plan?.createdByAgentId || '').trim();
  const orch = String(plan?.orchestratorAgentId || '').trim();
  if (!creator && !orch) {
    return { kind: 'unassigned', label: 'Unassigned', ownerId: '' };
  }
  if (planBelongsToSession(plan, ids)) {
    return { kind: 'this', label: 'This session', ownerId: creator || orch };
  }
  const ownerId = orch || creator;
  return {
    kind: 'other',
    label: `Other · ${shortAgentId(ownerId)}`,
    ownerId,
  };
}

function PlanDetail({
  plan,
  busy = false,
  note = '',
  sessionId = '',
  sessionAgentIds = null,
  agents = null,
  onContinue,
  onRemove,
  onOpenAgent = null,
  onEdit = null,
  onSetStatus = null,
  onAssignToSession = null,
}) {
  const status = String(plan?.status || 'draft');
  const canContinue = status === 'approved';
  const todos = Array.isArray(plan?.todos) ? plan.todos : [];
  const plannerId = String(plan?.createdByAgentId || '').trim();
  const workflowId = String(plan?.workflowId || '').trim();
  const assignment = planAssignmentState(plan, sessionAgentIds);
  const assignedHere = assignment.kind === 'this';
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignConfirm, setAssignConfirm] = useState(false);

  useEffect(() => {
    setAssignConfirm(false);
  }, [plan?.id]);

  const sessionAgent = useMemo(() => {
    const list = Array.isArray(agents) ? agents : [];
    const sid = String(sessionId || '').trim();
    return list.find((agent) => agent?.id === sid) || null;
  }, [agents, sessionId]);

  const wouldDetachWorkflow = Boolean(workflowId) && !assignedHere;

  async function submitAssign({ forceDetach = false } = {}) {
    if (wouldDetachWorkflow && !forceDetach) {
      setAssignConfirm(true);
      return;
    }
    setAssignConfirm(false);
    await onAssignToSession?.(plan.id, {
      detachWorkflow: Boolean(wouldDetachWorkflow || forceDetach),
    });
  }

  const actionBtn =
    'inline-flex h-7 items-center justify-center rounded-md border px-2 text-[11px] font-medium disabled:opacity-50';
  const iconBtn =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-50';
  const chipBtn =
    'inline-flex max-w-[min(100%,14rem)] items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] focus:outline-none focus-visible:ring-2';

  const assignmentTone = assignment.kind === 'this'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200 focus-visible:ring-emerald-500/40'
    : assignment.kind === 'unassigned'
      ? 'border-gray-600/50 bg-gray-800/40 text-gray-400 focus-visible:ring-gray-500/40'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200 focus-visible:ring-amber-500/40';

  return (
    <div className="relative px-1 pb-2">
      <div className="sticky top-0 z-10 -mx-1 space-y-2 border-b border-gray-800/80 bg-gray-950/95 px-1 pb-2 pt-0.5 backdrop-blur-sm">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[13px] font-semibold text-gray-100">{plan.name}</h3>
            {plan.overview ? (
              <p className="mt-0.5 text-[11px] text-gray-400">{plan.overview}</p>
            ) : null}
          </div>
          <PlanStatusReset
            open={statusOpen}
            value={status}
            busy={busy}
            onOpenChange={setStatusOpen}
            onChange={(next) => onSetStatus?.(plan.id, next)}
          />
        </div>

        {/* Planner + assignment chips left; assign / edit / delete flushed right */}
        <div className="flex flex-wrap items-center gap-1.5">
          {plannerId ? (
            <button
              type="button"
              title={`Open planner ${plannerId}`}
              aria-label={`Open planner ${plannerId}`}
              onClick={() => onOpenAgent?.(plannerId)}
              className={`${chipBtn} border-violet-500/30 bg-violet-500/10 text-violet-200 hover:border-violet-400/50 hover:bg-violet-500/20 focus-visible:ring-violet-500/40`}
            >
              <span className="text-violet-400/80">Planner</span>
              <span className="truncate">{shortAgentId(plannerId)}</span>
            </button>
          ) : (
            <span className={`${chipBtn} border-gray-700/60 bg-gray-900/40 text-gray-500`}>
              No planner
            </span>
          )}
          <span
            title={
              assignment.kind === 'this'
                ? 'Assigned to this session'
                : assignment.kind === 'unassigned'
                  ? 'Not assigned to any session'
                  : `Assigned to ${assignment.ownerId}`
            }
            className={assignmentTone.replace('focus-visible:ring-2', '') + ' ' + chipBtn}
          >
            <span className="opacity-70">Assigned</span>
            <span className="truncate">{assignment.label}</span>
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {!assignedHere ? (
              <button
                type="button"
                title="Assign plan to this session"
                aria-label="Assign plan to this session"
                disabled={busy || !sessionId}
                onClick={() => { void submitAssign(); }}
                className="inline-flex h-7 shrink-0 items-center rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                Assign to this session
              </button>
            ) : null}
            <button
              type="button"
              title="Edit plan"
              aria-label="Edit plan"
              disabled={busy}
              onClick={() => onEdit?.()}
              className={iconBtn}
            >
              <LucideIcon name="pencil" className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Delete plan"
              aria-label="Delete plan"
              disabled={busy}
              onClick={() => onRemove?.()}
              className={`${iconBtn} hover:border-rose-500/40 hover:bg-rose-500/15 hover:text-rose-300`}
            >
              <LucideIcon name="trash-2" className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {assignConfirm ? (
          <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-2">
            <p className="text-[11px] font-medium text-amber-100">Detach from workflow?</p>
            <p className="mt-1 text-[10px] leading-snug text-amber-200/80">
              This plan is linked to workflow{workflowId ? ` “${workflowId}”` : ''}. Assigning it to
              {sessionAgent ? ` ${agentLabel(sessionAgent)}` : ' this session'} detaches it from that
              workflow.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => { void submitAssign({ forceDetach: true }); }}
                className={`${actionBtn} border-amber-500/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25`}
              >
                Detach &amp; assign
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAssignConfirm(false)}
                className={`${actionBtn} border-gray-700 text-gray-300 hover:bg-gray-800`}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {(canContinue || busy || note) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {canContinue ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onContinue?.(plan.id)}
                className={`${actionBtn} border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20`}
              >
                Continue workflow
              </button>
            ) : null}
            {busy ? <span className="text-[10px] text-gray-500">Updating…</span> : null}
            {note ? <span className="text-[10px] text-rose-400">{note}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="space-y-2 pt-2">
        {plan.body ? (
          <MarkdownBody
            text={plan.body}
            className="markdown-body rounded-md border border-gray-800 bg-gray-950/60 p-2"
          />
        ) : null}
        {todos.length ? (
          <ul className="space-y-1">
            {todos.map((todo) => (
              <li key={todo.id || todo.content} className="flex gap-1.5 text-[11px] text-gray-400">
                <span className="text-gray-600">·</span>
                <span className="min-w-0 flex-1">{todo.content}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function PlanStatusReset({ open, value, busy = false, onOpenChange, onChange }) {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        onOpenChange?.(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') onOpenChange?.(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title="Reset plan status"
        aria-label={`Plan status ${value}. Click to change.`}
        aria-expanded={open}
        disabled={busy}
        onClick={() => onOpenChange?.(!open)}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${STATUS_TONE[value] || STATUS_TONE.draft} border border-gray-700/80 hover:bg-gray-800/70 disabled:opacity-50`}
      >
        {value}
        <LucideIcon name="chevron-down" className="h-3 w-3 opacity-70" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Reset plan status"
          className="absolute right-0 top-full z-30 mt-1 min-w-[8.5rem] overflow-hidden rounded-md border border-gray-700 bg-gray-950 py-1 shadow-lg shadow-black/40"
        >
          {PLAN_STATUSES.map((id) => {
            const selected = id === value;
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  onChange?.(id);
                  onOpenChange?.(false);
                }}
                className={`block w-full px-2.5 py-1.5 text-left text-[11px] capitalize ${
                  selected
                    ? 'bg-gray-800/70 font-medium text-violet-300'
                    : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                }`}
              >
                {id}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Hook helper: load plan list + detail for SessionChat. */
export function useWorkspacePlans({ enabled = true } = {}) {
  const [plans, setPlans] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // Workspace plans are written by agent tools / other sessions — poll so the
  // drawer badge and list pick up creates without a manual Refresh.
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch('/kusa/plans', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Failed to load plans');
      const body = await res.json();
      setPlans(Array.isArray(body?.plans) ? body.plans : []);
      setNote('');
    } catch (err) {
      setNote(err?.message || 'Could not load plans');
    }
  }, [enabled]);

  const select = async (id) => {
    if (!id) {
      setSelectedId(null);
      setSelectedPlan(null);
      return null;
    }
    setBusy(true);
    setSelectedId(id);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Plan not found');
      const body = await res.json();
      const plan = body?.plan || null;
      setSelectedPlan(plan);
      setNote('');
      return plan;
    } catch (err) {
      setNote(err?.message || 'Could not load plan');
      setSelectedPlan(null);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const create = async (opts = {}) => {
    setBusy(true);
    try {
      const res = await fetch('/kusa/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: 'Untitled plan',
          body: '',
          status: 'draft',
          ...(opts.createdByAgentId ? { createdByAgentId: opts.createdByAgentId } : {}),
          ...(opts.orchestratorAgentId ? { orchestratorAgentId: opts.orchestratorAgentId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Create failed');
      const plan = body?.plan || null;
      setSelectedId(plan?.id || null);
      setSelectedPlan(plan);
      await refresh();
      setNote('');
      return plan;
    } catch (err) {
      setNote(err?.message || 'Create failed');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async (id, patch = {}) => {
    if (!id) return null;
    setBusy(true);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: patch.name,
          overview: patch.overview,
          body: patch.body,
          executionPrompt: patch.executionPrompt,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Save failed');
      const plan = body?.plan || null;
      setSelectedPlan(plan);
      await refresh();
      setNote('');
      return plan;
    } catch (err) {
      setNote(err?.message || 'Save failed');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id, status) => {
    if (!id || !status) return null;
    setBusy(true);
    try {
      // Non-approved resets must not continue. Approved stays approved unless
      // the server finds a linked plan-execute orchestrator already awaiting.
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(
          status === 'approved'
            ? { status }
            : { status, continue: false },
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Status update failed');
      const plan = body?.plan || null;
      setSelectedPlan(plan);
      await refresh();
      const continued = body?.continued;
      if (status === 'approved' && continued?.ok && !continued.skipped) {
        setNote('Approved — waiting orchestrator resumed');
      } else {
        setNote(`Status set to ${status}`);
      }
      return plan;
    } catch (err) {
      setNote(err?.message || 'Status update failed');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const assignToSession = async (id, opts = {}) => {
    if (!id || !opts.sessionId) return null;
    setBusy(true);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          assignToSessionId: opts.sessionId,
          ...(opts.detachWorkflow ? { detachWorkflow: true } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Assign failed');
      const plan = body?.plan || null;
      setSelectedPlan(plan);
      await refresh();
      const continued = body?.continued;
      if (continued?.ok && !continued.skipped) {
        setNote('Assigned — workflow continued');
      } else if (continued?.ok === false) {
        setNote(continued.error || 'Assigned, but workflow did not continue');
      } else {
        setNote('Assigned to this session');
      }
      return plan;
    } catch (err) {
      setNote(err?.message || 'Assign failed');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id, opts = {}) => {
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          status: 'approved',
          ...(typeof opts.prompt === 'string' ? { prompt: opts.prompt, executionPrompt: opts.prompt } : {}),
          ...(opts.assignToAgentId ? { assignToAgentId: opts.assignToAgentId } : {}),
          ...(opts.detachWorkflow ? { detachWorkflow: true } : {}),
        }),
      });
      if (!res.ok) throw new Error('Approve failed');
      const body = await res.json();
      setSelectedPlan(body?.plan || null);
      await refresh();
      const continued = body?.continued;
      if (continued?.ok === false) {
        setNote(continued.error || 'Approved, but workflow did not continue');
      } else if (continued?.ok && !continued.skipped) {
        setNote(continued.detached ? 'Approved — detached & execution started' : 'Approved — execution started');
      } else {
        setNote('');
      }
    } catch (err) {
      setNote(err?.message || 'Approve failed');
    } finally {
      setBusy(false);
    }
  };

  const continueWorkflow = async (id, opts = {}) => {
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          ...(typeof opts.prompt === 'string' ? { prompt: opts.prompt } : {}),
          ...(opts.assignToAgentId ? { assignToAgentId: opts.assignToAgentId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || body?.continued?.error || 'Continue failed');
      setSelectedPlan(body?.plan || null);
      await refresh();
      setNote(body?.continued?.skipped ? 'Execution already running' : 'Execution started');
    } catch (err) {
      setNote(err?.message || 'Continue failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, opts = {}) => {
    if (!id) return;
    // Caller shows the context popup; `confirmed` skips the legacy window.confirm.
    if (!opts.confirmed && !window.confirm('Delete this plan? Agents linked to it can be removed afterward.')) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Delete failed');
      setSelectedId(null);
      setSelectedPlan(null);
      await refresh();
      setNote('Plan deleted');
    } catch (err) {
      setNote(err?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const id = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(id);
  }, [enabled, refresh]);

  return {
    plans,
    selectedId,
    selectedPlan,
    busy,
    note,
    refresh,
    select,
    create,
    save,
    setStatus,
    assignToSession,
    back: () => { setSelectedId(null); setSelectedPlan(null); },
    approve,
    continueWorkflow,
    remove,
  };
}

export { PopupToggle as PlanToggle };
