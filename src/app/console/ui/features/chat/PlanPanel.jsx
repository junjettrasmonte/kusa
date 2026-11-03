import { useEffect, useState } from 'react';
import { PopupList, PopupToggle } from './PopupList.jsx';
import { previewLine } from '#ui/shared/lib/chatText.js';

export const PLAN_MAX_HEIGHT_PX = 220;

const STATUS_TONE = {
  draft: 'text-gray-500',
  ready: 'text-sky-300/80',
  approved: 'text-emerald-300/80',
  executing: 'text-amber-300/80',
  done: 'text-emerald-300/60',
  cancelled: 'text-gray-600',
};

/**
 * Workspace Plan drawer — list first, click a row to load detail + Approve.
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
  onDockToggle = null,
  onClose = null,
  onSelect = null,
  onBack = null,
  onApprove = null,
  onContinue = null,
  onRemove = null,
  onRefresh = null,
}) {
  if (!expanded) return null;
  const total = Array.isArray(plans) ? plans.length : 0;
  const detail = selectedId && selectedPlan;
  const summary = detail
    ? `Plan · ${selectedPlan.name || selectedId}`
    : `${total} plan${total === 1 ? '' : 's'}`;

  return (
    <PopupList
      expanded={expanded}
      count={detail ? 1 : Math.max(total, 1)}
      maxHeightPx={PLAN_MAX_HEIGHT_PX}
      summary={summary}
      ariaLabel="Workspace plans"
      dock={dock}
      onDockToggle={onDockToggle}
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center gap-1.5 pb-1">
        {detail ? (
          <button
            type="button"
            onClick={() => onBack?.()}
            className="rounded-md border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-300 hover:bg-gray-800"
          >
            ‹ All plans
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onRefresh?.()}
            className="rounded-md border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          >
            Refresh
          </button>
        )}
        {busy ? <span className="text-[10px] text-gray-500">Updating…</span> : null}
        {note ? <span className="text-[10px] text-rose-400">{note}</span> : null}
      </div>

      {detail ? (
        <PlanDetail
          plan={selectedPlan}
          onApprove={onApprove}
          onContinue={onContinue}
          onRemove={onRemove}
        />
      ) : total === 0 ? (
        <p className="px-1 py-2 text-[11px] text-gray-500">
          No plans yet. Agents create them with kusa_plan_create; they show up here for Approve.
        </p>
      ) : (
        plans.map((plan) => (
          <PlanListRow
            key={plan.id}
            plan={plan}
            onClick={() => onSelect?.(plan.id)}
          />
        ))
      )}
    </PopupList>
  );
}

function PlanListRow({ plan, onClick }) {
  const name = String(plan?.name || plan?.id || 'Untitled').trim();
  const status = String(plan?.status || 'draft');
  const overview = String(plan?.overview || '').trim();
  return (
    <button
      type="button"
      role="listitem"
      title={overview || name}
      onClick={onClick}
      className="flex h-8 w-full items-center gap-1.5 px-1 text-left hover:bg-gray-900/40"
    >
      <p className="min-w-0 flex-1 truncate text-[12px] leading-tight text-gray-200">
        {previewLine(name, 80)}
      </p>
      <span
        className={`ml-auto shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide ${STATUS_TONE[status] || STATUS_TONE.draft}`}
      >
        {status}
      </span>
    </button>
  );
}

function shortAgentId(id) {
  const text = String(id || '').trim();
  if (!text) return '';
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function PlanDetail({ plan, onApprove, onContinue, onRemove }) {
  const status = String(plan?.status || 'draft');
  const canApprove = status === 'draft' || status === 'ready';
  const canContinue = status === 'approved';
  const todos = Array.isArray(plan?.todos) ? plan.todos : [];
  const plannerId = String(plan?.createdByAgentId || '').trim();
  const orchId = String(plan?.orchestratorAgentId || '').trim();
  return (
    <div className="space-y-2 px-1 pb-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold text-gray-100">{plan.name}</h3>
          {plan.overview ? (
            <p className="mt-0.5 text-[11px] text-gray-400">{plan.overview}</p>
          ) : null}
          {plannerId || orchId ? (
            <p className="mt-1 font-mono text-[10px] text-gray-500">
              {plannerId ? `Planner ${shortAgentId(plannerId)}` : null}
              {plannerId && orchId ? ' · ' : null}
              {orchId ? `Agent ${shortAgentId(orchId)}` : null}
            </p>
          ) : null}
        </div>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${STATUS_TONE[status] || STATUS_TONE.draft}`}
        >
          {status}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
      {canApprove ? (
        <button
          type="button"
          onClick={() => onApprove?.(plan.id)}
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20"
        >
          Approve plan
        </button>
      ) : null}
      {canContinue ? (
        <button
          type="button"
          onClick={() => onContinue?.(plan.id)}
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20"
        >
          Continue workflow
        </button>
      ) : null}
        <button
          type="button"
          onClick={() => onRemove?.(plan.id)}
          className="rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1 text-[11px] font-medium text-rose-300/90 hover:bg-rose-500/15"
        >
          Delete plan
        </button>
      </div>
      {plan.body ? (
        <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md border border-gray-800 bg-gray-950/60 p-2 text-[11px] leading-snug text-gray-300">
          {plan.body}
        </pre>
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
  );
}

/** Hook helper: load plan list + detail for SessionChat. */
export function useWorkspacePlans({ enabled = true } = {}) {
  const [plans, setPlans] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const refresh = async () => {
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
  };

  const select = async (id) => {
    if (!id) {
      setSelectedId(null);
      setSelectedPlan(null);
      return;
    }
    setBusy(true);
    setSelectedId(id);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Plan not found');
      const body = await res.json();
      setSelectedPlan(body?.plan || null);
      setNote('');
    } catch (err) {
      setNote(err?.message || 'Could not load plan');
      setSelectedPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id) => {
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      if (!res.ok) throw new Error('Approve failed');
      const body = await res.json();
      setSelectedPlan(body?.plan || null);
      await refresh();
      const continued = body?.continued;
      if (continued?.ok === false) {
        setNote(continued.error || 'Approved, but workflow did not continue');
      } else if (continued?.ok && !continued.skipped) {
        setNote('Approved — execution started');
      } else {
        setNote('');
      }
    } catch (err) {
      setNote(err?.message || 'Approve failed');
    } finally {
      setBusy(false);
    }
  };

  const continueWorkflow = async (id) => {
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/kusa/plans/${encodeURIComponent(id)}/continue`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
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

  const remove = async (id) => {
    if (!id) return;
    if (!window.confirm('Delete this plan? Agents linked to it can be removed afterward.')) return;
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
    if (enabled) void refresh();
  }, [enabled]);

  return {
    plans,
    selectedId,
    selectedPlan,
    busy,
    note,
    refresh,
    select,
    back: () => { setSelectedId(null); setSelectedPlan(null); },
    approve,
    continueWorkflow,
    remove,
  };
}

export { PopupToggle as PlanToggle };
