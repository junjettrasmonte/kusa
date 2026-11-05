import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState } from 'react';
import { CHAT_PROVIDER_GROUPS } from '#ui/shared/lib/format.js';
import { CloseIcon, InfoIcon, IconButton } from '#ui/shared/IconButton.jsx';
import {
  modelFamilyBackLabel,
  modelFamilyOptions,
  modelMenuRows,
} from '#ui/shared/lib/modelFamily.js';
import { WorkflowGraphView } from './WorkflowGraphView.jsx';

/**
 * Composer pickers + action icons — Mode / Agent / Model / Rule dropdowns sit
 * in the composer footer flush left of the context ring, attach, dictate, and
 * live/send controls (or, on a narrow composer, one ComposerOptionsMenu that
 * drills into each picker). Values live in SessionChat state; these
 * components only render and route a selection back through onSelect.
 * Disabled triggers render at 50% opacity.
 *
 * Model menus keep provider (endpoint) headings, then nest multi-model
 * families (Claude / GPT / Gemini / …) as selectable submenus.
 * Mode → Orchestrator is a nested submenu; workflows are the selectable children.
 */
export const AGENT_PROVIDER_OPTIONS = CHAT_PROVIDER_GROUPS.map((group) => ({
  id: group.id,
  label: group.id === 'copilot' ? 'GitHub Copilot' : group.label,
  blurb: group.id === 'kusa'
    ? 'Kusă agent (OpenAI-compatible endpoints).'
    : group.id === 'cursor'
      ? 'Cursor Agent CLI.'
      : 'GitHub Copilot CLI.',
}));

export const AGENT_MODE_OPTIONS = [
  {
    id: 'ask',
    label: 'Ask',
    blurb: 'Read-only — search and read, no edits, no commands.',
  },
  {
    id: 'plan',
    label: 'Plan',
    blurb: 'Read-only — answers with a numbered plan.',
  },
  {
    id: 'agent',
    label: 'Agent',
    blurb: 'Read and write files; commands follow the rules.',
  },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    blurb: 'Pick a workflow — nested submenu.',
    /** Opens as a chevron nested menu; workflows are the selectable children. */
    nested: true,
  },
];

/** Tool-loop modes only — Orchestrator is session kind, not normalizeAgentMode. */
export const AGENT_TOOL_MODE_IDS = new Set(['ask', 'plan', 'agent']);

/**
 * Composer Rules picker options. The ask timeout comes from Settings so the
 * blurbs match the live gate (default: 2m ask-wait). Allow / Deny are sticky:
 * the pick holds for the rest of the session, so no revert window is advertised.
 * @param {{ approvalTimeoutMinutes?: number }} [timing]
 */
export function ruleOptions(timing = {}) {
  const askMins = Math.min(60, Math.max(1, Math.floor(Number(timing.approvalTimeoutMinutes) || 2)));
  const askLabel = askMins === 1 ? '1m' : `${askMins}m`;
  return [
    {
      id: 'ask-deny',
      label: 'Ask · deny on timeout',
      blurb: `Terminal and browser calls need a yes first; no answer within ${askLabel} denies.`,
    },
    {
      id: 'ask-allow',
      label: 'Ask · allow on timeout',
      blurb: `Terminal and browser calls need a yes first; no answer within ${askLabel} allows.`,
    },
    {
      id: 'allow',
      label: 'Allow',
      blurb: 'Terminal and browser calls run as-is; the pick holds for the rest of this session.',
    },
    {
      id: 'deny',
      label: 'Deny',
      blurb: 'Terminal and browser calls are blocked; the pick holds for the rest of this session.',
    },
  ];
}

/** Static snapshot for callers that only need ids (initial rule hydrate). */
export const RULE_OPTIONS = ruleOptions();

/** Rough token budget for the context ring when the endpoint says nothing. */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

function Chevron({ open }) {
  return (
    <svg
      className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 4 10 8 6 12" />
    </svg>
  );
}

/**
 * A picker: shows the current value, and clicking it opens a menu above the
 * composer (the composer sits at the bottom of the panel, so menus open up).
 * @param {string} title
 * @param {Array<{ id: string, label: string, blurb?: string, group?: string }>} options
 *   An option may carry a `group` — the Model list spans every configured
 *   endpoint, and a heading is emitted the first time each group appears, so the
 *   menu reads as one block per endpoint and a pick can never be read as
 *   another endpoint's credentials. Options without a group (Mode / Rule) keep
 *   the flat menu. Model also nests multi-model families as drill-in submenus.
 * @param {string} value
 * @param {(id) => void} [onSelect]
 *
 * The menu is open only while the trigger button holds focus: clicking it focuses the
 * button, and any blur (selecting an option, typing in the composer, tabbing away)
 * closes it automatically — so a picker can never get stuck expanded.
 */
/** Build the flat/heading row list a picker menu renders (Mode / Rule). */
function optionMenuRows(options) {
  const rows = [];
  let lastGroup = null;
  for (const option of options) {
    const group = String(option?.group || '');
    if (group && group !== lastGroup) {
      rows.push({ heading: group });
      lastGroup = group;
    }
    rows.push({ option });
  }
  return rows;
}

function optionLabel(options, value) {
  const current = options.find((option) => option.id === value) || options[0];
  return current?.label || value || '—';
}

function isPrimaryMouse(e) {
  return !(e && typeof e.button === 'number' && e.button !== 0);
}

function MenuHeading({ label, stickyClass = 'top-0' }) {
  return (
    <p
      className={`sticky ${stickyClass} z-10 px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500 border-b border-gray-800 bg-gray-900`}
    >
      {label}
    </p>
  );
}

function MenuOptionButton({
  option,
  selected,
  onPick,
  role = undefined,
}) {
  const disabled = option?.disabled === true;
  return (
    <button
      type="button"
      role={role}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabled ? (option.disabledReason || option.blurb || 'Unavailable') : undefined}
      onMouseDown={(e) => {
        // Press, not release: the trigger's blur can close the menu before
        // `click` is dispatched, and a released click would then land on
        // whatever sits behind the removed menu. mousedown always fires
        // while the option is still in the DOM, so the selection cannot
        // be lost. Left button only (right-click is a context menu).
        if (disabled || !isPrimaryMouse(e)) return;
        e.preventDefault();
        onPick?.(option.id);
      }}
      className={`block w-full px-2.5 py-1.5 text-[11px] leading-snug text-left ${
        disabled
          ? 'cursor-not-allowed text-gray-600'
          : selected
            ? 'bg-gray-800/70 font-medium text-emerald-300'
            : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
      }`}
    >
      <span className="font-medium break-all">{option.label}</span>
      {option.blurb ? (
        <span className={`ml-1.5 ${disabled ? 'text-gray-600' : 'text-gray-500'}`}>· {option.blurb}</span>
      ) : null}
    </button>
  );
}

function MenuFamilyButton({
  label,
  selected,
  onOpen,
  role = undefined,
  disabled = false,
  blurb = '',
  title = undefined,
}) {
  return (
    <button
      type="button"
      role={role}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      onMouseDown={(e) => {
        if (disabled || !isPrimaryMouse(e)) return;
        // preventDefault keeps the trigger focused so the deferred blur
        // close never fires while opening a family submenu.
        e.preventDefault();
        onOpen?.();
      }}
      className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-left ${
        disabled
          ? 'cursor-not-allowed text-gray-600'
          : selected
            ? 'bg-gray-800/70 font-medium text-emerald-300'
            : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
      }`}
    >
      <span className="min-w-0 flex-1 truncate font-medium">
        {label}
        {blurb ? (
          <span className={`ml-1.5 font-normal ${disabled ? 'text-gray-600' : 'text-gray-500'}`}>
            · {blurb}
          </span>
        ) : null}
      </span>
      {disabled ? null : <Chevron open />}
    </button>
  );
}

function MenuBackButton({ label, onBack, stickyClass = 'top-0' }) {
  return (
    <button
      type="button"
      role="menuitem"
      onMouseDown={(e) => {
        if (!isPrimaryMouse(e)) return;
        e.preventDefault();
        onBack?.();
      }}
      className={`sticky ${stickyClass} z-10 flex w-full items-center gap-1.5 border-b border-gray-800 bg-gray-900 px-2.5 py-1.5 text-[11px] font-medium text-gray-400 hover:text-gray-200`}
    >
      <span className="inline-flex rotate-180">
        <Chevron open={false} />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/** Compact Orchestrator workflow row: max 2 lines + info affordance. */
function WorkflowMenuRow({ workflow, onSelect, onInfo }) {
  const title = String(workflow?.label || workflow?.id || 'Workflow').trim();
  const description = String(workflow?.description || '').trim();
  return (
    <div
      role="menuitem"
      className="flex w-full items-start gap-1 px-2 py-1.5 text-left hover:bg-gray-800/50"
    >
      <button
        type="button"
        title={description ? `${title} — ${description}` : title}
        onMouseDown={(e) => {
          if (!isPrimaryMouse(e)) return;
          e.preventDefault();
          onSelect?.(workflow);
        }}
        className="min-w-0 flex-1 text-left"
      >
        <p className="line-clamp-2 text-[11px] leading-snug text-gray-200">
          <span className="font-medium">{title}</span>
          {description ? (
            <span className="font-normal text-gray-500">{` — ${description}`}</span>
          ) : null}
        </p>
      </button>
      <button
        type="button"
        title={`About ${title}`}
        aria-label={`About ${title}`}
        onMouseDown={(e) => {
          if (!isPrimaryMouse(e)) return;
          // Keep the Mode menu from blur-closing before the details dialog mounts.
          e.preventDefault();
          e.stopPropagation();
          onInfo?.(workflow);
        }}
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-800 hover:text-sky-300"
      >
        <InfoIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Full workflow details (desc / roles / LangGraph) opened from the info icon. */
function WorkflowDetailsModal({ workflow, onClose }) {
  const titleId = useId();
  const closeRef = useRef(null);
  const title = String(workflow?.label || workflow?.id || 'Workflow').trim();
  const description = String(workflow?.description || '').trim();
  const workflowId = String(workflow?.id || '').trim();
  const isLangGraph = String(workflow?.runtime || '').toLowerCase() === 'langgraph';
  const roleConfigs = workflow?.roleConfigs && typeof workflow.roleConfigs === 'object'
    ? workflow.roleConfigs
    : {};
  const roles = Object.entries(roleConfigs);
  const [graph, setGraph] = useState(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState('');

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!isLangGraph || !workflowId) {
      setGraph(null);
      setGraphError('');
      setGraphLoading(false);
      return undefined;
    }
    let cancelled = false;
    setGraphLoading(true);
    setGraphError('');
    setGraph(null);
    fetch(`/kusa/workflows/${encodeURIComponent(workflowId)}/graph`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        return body?.graph || null;
      })
      .then((next) => {
        if (cancelled) return;
        setGraph(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setGraphError(err?.message || 'Could not load graph');
      })
      .finally(() => {
        if (!cancelled) setGraphLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLangGraph, workflowId]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        // Don't let the backdrop click fall through to the composer menu.
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(92vh,52rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-gray-100">
              {title}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-sky-300">
              {workflowId || '—'}
              {isLangGraph ? (
                <span className="ml-2 font-sans text-gray-500">· LangGraph</span>
              ) : null}
            </p>
          </div>
          <IconButton
            ref={closeRef}
            label="Close"
            icon={CloseIcon}
            onClick={onClose}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {description ? (
            <p className="text-sm leading-relaxed text-gray-300">{description}</p>
          ) : (
            <p className="text-sm text-gray-500">No description for this workflow.</p>
          )}
          {isLangGraph ? (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Graph
              </h3>
              <WorkflowGraphView
                drawable={graph}
                loading={graphLoading}
                error={graphError}
                className="h-[20rem]"
              />
            </div>
          ) : null}
          {roles.length ? (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Roles
              </h3>
              <ul className="space-y-2">
                {roles.map(([roleName, cfg]) => {
                  const provider = String(cfg?.provider || 'kusa').trim() || 'kusa';
                  const mode = String(cfg?.mode || '').trim();
                  const rules = String(cfg?.rules || '').trim();
                  const model = String(cfg?.model || '').trim();
                  const bits = [
                    `provider ${provider}`,
                    mode ? `mode ${mode}` : null,
                    rules ? `rules ${rules}` : null,
                    model ? `model ${model}` : 'model · endpoint default',
                  ].filter(Boolean);
                  return (
                    <li
                      key={roleName}
                      className="rounded-lg border border-gray-800 bg-gray-950/80 px-3 py-2"
                    >
                      <p className="text-[12px] font-medium capitalize text-gray-200">{roleName}</p>
                      <p className="mt-0.5 text-[11px] text-gray-500">{bits.join(' · ')}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function WorkflowMenuList({
  workflows,
  loading,
  onSelect,
  onInfo,
}) {
  if (loading) {
    return <p className="px-2.5 py-2 text-[11px] text-gray-500">Loading workflows…</p>;
  }
  if (!workflows?.length) {
    return (
      <p className="px-2.5 py-2 text-[11px] text-gray-500">
        No workflows yet. Seeded plan-execute appears after serve starts.
      </p>
    );
  }
  return workflows.map((wf) => (
    <WorkflowMenuRow
      key={wf.id}
      workflow={wf}
      onSelect={onSelect}
      onInfo={onInfo}
    />
  ));
}

/** Render Mode/Rule flat rows, or Model provider+family rows.
 *  Mode options may set `nested: true` (Orchestrator) to open as a submenu. */
function PickerMenuBody({
  title,
  options,
  value,
  familyKey,
  onFamilyOpen,
  onSelect,
  onNestedOpen = null,
  headingStickyClass = 'top-0',
  role = undefined,
}) {
  if (title === 'Model' && familyKey) {
    return modelFamilyOptions(options, familyKey).map((option) => (
      <MenuOptionButton
        key={option.id}
        option={option}
        selected={option.id === value}
        onPick={onSelect}
        role={role}
      />
    ));
  }

  const rows = title === 'Model'
    ? modelMenuRows(options, value)
    : optionMenuRows(options);

  return rows.map((row) => {
    if (row.heading) {
      return (
        <MenuHeading
          key={`heading:${row.heading}`}
          label={row.heading}
          stickyClass={headingStickyClass}
        />
      );
    }
    if (row.family) {
      return (
        <MenuFamilyButton
          key={`family:${row.key}`}
          label={row.family}
          selected={row.selected}
          onOpen={() => onFamilyOpen?.(row.key)}
          role={role}
        />
      );
    }
    if (row.option?.nested) {
      return (
        <MenuFamilyButton
          key={row.option.id}
          label={row.option.label}
          blurb={row.option.blurb || ''}
          selected={row.option.id === value}
          disabled={row.option.disabled === true}
          title={row.option.disabled
            ? (row.option.disabledReason || row.option.blurb || 'Unavailable')
            : undefined}
          onOpen={() => onNestedOpen?.(row.option.id)}
          role={role}
        />
      );
    }
    return (
      <MenuOptionButton
        key={row.option.id}
        option={row.option}
        selected={row.option.id === value}
        onPick={onSelect}
        role={role}
      />
    );
  });
}

/**
 * @param {string} title
 * @param {Array<{ id: string, label: string, blurb?: string, group?: string }>} options
 * @param {string} value
 * @param {(id: string) => void} [onSelect]
 * @param {boolean} [disabled]
 * @param {Array<{ id: string, label: string, blurb?: string, roleConfigs?: object, provider?: string }>} [workflowOptions]
 *   Mode → Orchestrator drills into these before converting.
 * @param {boolean} [workflowsLoading]
 * @param {(workflow: object) => void} [onWorkflowSelect]
 */
export function ComposerDropdown({
  title,
  options,
  value,
  onSelect,
  disabled = false,
  workflowOptions = null,
  workflowsLoading = false,
  onWorkflowSelect = null,
  onWorkflowMenuOpen = null,
}) {
  // Focus-driven, not a toggle: blur is the only way the menu closes itself.
  const [open, setOpen] = useState(false);
  // Model-only: null at provider/family list; family key while drilled in.
  const [familyKey, setFamilyKey] = useState(null);
  // Mode-only: 'orchestrator' while picking a workflow under Orchestrator.
  const [modeDrill, setModeDrill] = useState(null);
  // Info icon → workflow details dialog (independent of the menu).
  const [detailsWorkflow, setDetailsWorkflow] = useState(null);
  const rootRef = useRef(null);
  const label = optionLabel(options, value);
  const isModel = title === 'Model';
  const isMode = title === 'Mode';
  const showWorkflowDrill = isMode && modeDrill === 'orchestrator';
  // Nested Orchestrator menu must open even while the list is still loading —
  // an empty array is fine; null means "not available for this session".
  const canDrillOrchestrator = isMode
    && workflowOptions != null
    && typeof onWorkflowSelect === 'function';

  function close() {
    setOpen(false);
    setFamilyKey(null);
    setModeDrill(null);
  }

  function handleSelect(id) {
    const option = options.find((entry) => entry.id === id);
    if (option?.disabled || option?.nested) return;
    close();
    onSelect?.(id);
  }

  function openOrchestratorNest() {
    if (!canDrillOrchestrator) return;
    const option = options.find((entry) => entry.id === 'orchestrator');
    if (option?.disabled) return;
    setModeDrill('orchestrator');
    onWorkflowMenuOpen?.();
  }

  return (
    <div className="relative inline-flex items-center" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          if (disabled) return;
          setOpen(true);
          setFamilyKey(null);
          setModeDrill(null);
          // Focus it explicitly: browsers are inconsistent about moving focus on a
          // mouse click, and without focus there is no blur event to close the menu.
          e.currentTarget.focus();
        }}
        onBlur={() => {
          // Deferred: ignore blur when focus stays inside this picker (nested
          // Orchestrator / Model family clicks). A bare close-on-blur was wiping
          // modeDrill before the workflow list could paint.
          if (!open) return;
          setTimeout(() => {
            if (!rootRef.current?.contains(document.activeElement)) close();
          }, 0);
        }}
        title={disabled ? `${title}: ${label} (locked by workflow)` : `${title}: ${label}`}
        aria-label={title}
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
          disabled
            ? 'cursor-not-allowed text-gray-500 opacity-50'
            : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/70'
        }`}
      >
        <span className="text-gray-600">{title}</span>
        <span className="max-w-[12rem] truncate text-gray-200">{label}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          className={`absolute left-0 bottom-[100%] z-50 max-h-[min(20rem,50vh)] w-[18rem] overflow-y-auto overscroll-contain rounded-lg border border-gray-700 bg-gray-950 shadow-lg ${
            isModel ? 'divide-y divide-gray-800' : ''
          }`}
          onMouseDown={(e) => {
            // Keep the trigger focused for the whole drill (Orchestrator /
            // Model family). Without this, a nested click can blur→close
            // before modeDrill paints the workflow list.
            e.preventDefault();
          }}
        >
          {isModel && familyKey ? (
            <MenuBackButton
              label={modelFamilyBackLabel(familyKey)}
              onBack={() => setFamilyKey(null)}
            />
          ) : null}
          {showWorkflowDrill ? (
            <>
              <MenuBackButton
                label="Orchestrator"
                onBack={() => setModeDrill(null)}
              />
              <WorkflowMenuList
                workflows={workflowOptions}
                loading={workflowsLoading}
                onSelect={(wf) => {
                  close();
                  onWorkflowSelect?.(wf);
                }}
                onInfo={setDetailsWorkflow}
              />
            </>
          ) : (
            <PickerMenuBody
              title={title}
              options={options}
              value={value}
              familyKey={isModel ? familyKey : null}
              onFamilyOpen={setFamilyKey}
              onNestedOpen={(id) => {
                if (id === 'orchestrator') openOrchestratorNest();
              }}
              onSelect={handleSelect}
              headingStickyClass={isModel && familyKey ? 'top-8' : 'top-0'}
            />
          )}
        </div>
      ) : null}
      {detailsWorkflow ? (
        <WorkflowDetailsModal
          workflow={detailsWorkflow}
          onClose={() => setDetailsWorkflow(null)}
        />
      ) : null}
    </div>
  );
}

/** lucide `sliders-horizontal` — Mode / Rule / Model merged into one glyph. */
function ComposerOptionsIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 5H3" />
      <path d="M12 19H3" />
      <path d="M14 3v4" />
      <path d="M16 17v4" />
      <path d="M21 12h-9" />
      <path d="M21 19h-5" />
      <path d="M21 5h-7" />
      <path d="M8 10v4" />
      <path d="M8 12H3" />
    </svg>
  );
}

/**
 * Narrow-composer Mode / Agent / Model / Rule control. One icon opens a menu
 * whose first level is the pickers; each picker's options are a drill-in
 * submenu. Mode → Orchestrator opens a nested workflow submenu. Wide composers
 * keep ComposerDropdowns in the footer instead — SessionChat swaps on a
 * container query so a narrow chat column collapses even when the window
 * itself is wide.
 *
 * Focus-driven like ComposerDropdown: the trigger holds focus, menu presses
 * use mousedown + preventDefault so drilling in never blurs the trigger shut,
 * and blur (typing in the composer, tabbing away) still closes everything.
 */
export function ComposerOptionsMenu({
  agent = '',
  agentOptions = AGENT_PROVIDER_OPTIONS,
  onAgentSelect = null,
  agentDisabled = false,
  mode,
  modeOptions,
  onModeSelect,
  modeDisabled = false,
  rule,
  ruleOptions: ruleOpts,
  onRuleSelect,
  ruleDisabled = false,
  model,
  modelOptions,
  onModelSelect,
  modelDisabled = false,
  workflowOptions = null,
  workflowsLoading = false,
  onWorkflowSelect = null,
  onWorkflowMenuOpen = null,
}) {
  const [open, setOpen] = useState(false);
  // null = top level; otherwise which picker's options.
  const [panel, setPanel] = useState(null);
  // Model-only: family drill-in under the Model panel.
  const [familyKey, setFamilyKey] = useState(null);
  // Mode-only: workflow list under Orchestrator.
  const [modeDrill, setModeDrill] = useState(null);
  const [detailsWorkflow, setDetailsWorkflow] = useState(null);
  const rootRef = useRef(null);

  const pickers = [
    {
      id: 'mode',
      title: 'Mode',
      value: mode,
      options: modeOptions,
      onSelect: onModeSelect,
      disabled: modeDisabled,
    },
    ...(onAgentSelect
      ? [{
        id: 'agent',
        title: 'Agent',
        value: agent,
        options: agentOptions,
        onSelect: onAgentSelect,
        disabled: agentDisabled,
      }]
      : []),
    {
      id: 'model',
      title: 'Model',
      value: model,
      options: modelOptions,
      onSelect: onModelSelect,
      disabled: modelDisabled,
    },
    {
      id: 'rule',
      title: 'Rule',
      value: rule,
      options: ruleOpts,
      onSelect: onRuleSelect,
      disabled: ruleDisabled,
    },
  ];
  const active = pickers.find((picker) => picker.id === panel) || null;
  const tip = [
    `Mode: ${optionLabel(modeOptions, mode)}`,
    onAgentSelect ? `Agent: ${optionLabel(agentOptions, agent)}` : null,
    `Model: ${optionLabel(modelOptions, model)}`,
    `Rule: ${optionLabel(ruleOpts, rule)}`,
  ].filter(Boolean).join(' · ');
  const canDrillOrchestrator = workflowOptions != null
    && typeof onWorkflowSelect === 'function';
  const showWorkflowDrill = active?.id === 'mode' && modeDrill === 'orchestrator';

  function close() {
    setOpen(false);
    setPanel(null);
    setFamilyKey(null);
    setModeDrill(null);
  }

  function backFromActive() {
    if (showWorkflowDrill) {
      setModeDrill(null);
      return;
    }
    if (active?.id === 'model' && familyKey) {
      setFamilyKey(null);
      return;
    }
    setPanel(null);
    setFamilyKey(null);
    setModeDrill(null);
  }

  const backLabel = showWorkflowDrill
    ? 'Orchestrator'
    : active?.id === 'model' && familyKey
      ? modelFamilyBackLabel(familyKey)
      : (active?.title || '');

  return (
    <div className="relative inline-flex items-center" ref={rootRef}>
      <button
        type="button"
        onClick={(e) => {
          setOpen(true);
          setPanel(null);
          setFamilyKey(null);
          setModeDrill(null);
          e.currentTarget.focus();
        }}
        onBlur={() => {
          if (!open) return;
          setTimeout(() => {
            if (!rootRef.current?.contains(document.activeElement)) close();
          }, 0);
        }}
        title={tip}
        aria-label="Mode, Agent, Model, and Rule"
        aria-expanded={open}
        aria-haspopup="menu"
        className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
          open
            ? 'bg-gray-800/70 text-gray-200'
            : 'text-gray-500 hover:bg-gray-800/70 hover:text-gray-200'
        }`}
      >
        <ComposerOptionsIcon />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Mode, Agent, Model, and Rule"
          className="absolute left-0 bottom-[100%] z-50 max-h-[min(20rem,50vh)] w-[16rem] overflow-y-auto overscroll-contain rounded-lg border border-gray-700 bg-gray-950 shadow-lg"
          onMouseDown={(e) => {
            // Same as ComposerDropdown: nested Orchestrator / Mode clicks must
            // not blur the trigger or the menu closes before the list paints.
            e.preventDefault();
          }}
        >
          {active ? (
            <>
              <MenuBackButton label={backLabel} onBack={backFromActive} />
              {showWorkflowDrill ? (
                <WorkflowMenuList
                  workflows={workflowOptions}
                  loading={workflowsLoading}
                  onSelect={(wf) => {
                    close();
                    onWorkflowSelect?.(wf);
                  }}
                  onInfo={setDetailsWorkflow}
                />
              ) : (
                <PickerMenuBody
                  title={active.title}
                  options={active.options}
                  value={active.value}
                  familyKey={active.id === 'model' ? familyKey : null}
                  onFamilyOpen={setFamilyKey}
                  onNestedOpen={(id) => {
                    if (active.id !== 'mode' || id !== 'orchestrator') return;
                    const option = active.options?.find((entry) => entry.id === id);
                    if (option?.disabled || !canDrillOrchestrator) return;
                    setModeDrill('orchestrator');
                    onWorkflowMenuOpen?.();
                  }}
                  onSelect={(id) => {
                    const option = active.options?.find((entry) => entry.id === id);
                    if (option?.disabled || option?.nested) return;
                    close();
                    active.onSelect?.(id);
                  }}
                  headingStickyClass="top-8"
                  role="menuitem"
                />
              )}
            </>
          ) : (
            pickers.map((picker) => (
              <button
                key={picker.id}
                type="button"
                role="menuitem"
                disabled={picker.disabled}
                onMouseDown={(e) => {
                  if (picker.disabled || !isPrimaryMouse(e)) return;
                  // preventDefault keeps the trigger focused so the deferred blur
                  // close never fires while opening a submenu.
                  e.preventDefault();
                  setFamilyKey(null);
                  setModeDrill(null);
                  setPanel(picker.id);
                }}
                className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-left ${
                  picker.disabled
                    ? 'cursor-not-allowed text-gray-500 opacity-50'
                    : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                }`}
                title={picker.disabled ? 'Locked by workflow' : undefined}
              >
                <span className="w-10 shrink-0 text-gray-600">{picker.title}</span>
                <span className={`min-w-0 flex-1 truncate font-medium ${picker.disabled ? 'text-gray-500' : 'text-gray-200'}`}>
                  {optionLabel(picker.options, picker.value)}
                </span>
                {picker.disabled ? null : <Chevron open />}
              </button>
            ))
          )}
        </div>
      ) : null}
      {detailsWorkflow ? (
        <WorkflowDetailsModal
          workflow={detailsWorkflow}
          onClose={() => setDetailsWorkflow(null)}
        />
      ) : null}
    </div>
  );
}

function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * Context window usage as a ring; counts live in the tooltip.
 * Deliberately neutral: the meter is a readout, not an alert, so it uses the
 * gray ramp (track = the same gray at low opacity, arc = the full gray) instead
 * of the kusa-blue brand accent. Only real pressure escalates.
 * When `source` is "strata", the tip names the live server meter.
 */
export function ContextRing({ used, limit = DEFAULT_CONTEXT_LIMIT, source = '' }) {
  const max = Number(limit) > 0 ? Number(limit) : DEFAULT_CONTEXT_LIMIT;
  const usedN = Math.max(0, Math.round(Number(used) || 0));
  const ratio = Math.min(1, Math.max(0, usedN / max));
  const pct = Math.round(ratio * 100);
  const circumference = 2 * Math.PI * 6.5;
  const arc = ratio * circumference;
  // Neutral gray by default. Strata uses Tailwind `green-*` (not emerald): this
  // console remaps every emerald-* token to the brand blue ramp in index.css,
  // so emerald would read as blue and look "not green" even when live.
  // Pressure still escalates to amber/rose either way.
  const idle = source === 'strata' ? 'text-green-400' : 'text-gray-400';
  const tone = ratio >= 0.9 ? 'text-rose-400' : ratio >= 0.7 ? 'text-amber-400' : idle;
  const label = source === 'strata' ? 'Strata context' : 'Context';
  const tip = `${label} ${formatTokens(usedN)} / ${formatTokens(max)} (${pct}%)`;
  return (
    <span
      className={`inline-flex h-8 w-8 items-center justify-center ${tone}`}
      title={tip}
      aria-label={tip}
    >
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" strokeWidth="2.25" opacity="0.22" />
        <circle
          cx="10"
          cy="10"
          r="6.5"
          strokeWidth="2.25"
          strokeDasharray={`${arc} ${circumference - arc}`}
          strokeDashoffset={circumference / 4}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** Shared stroke wrapper for composer footer icons. */
function ComposerSvg({ children }) {
  return (
    <svg
      className="h-[18px] w-[18px]"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Attachment — classic diagonal paperclip (the usual “attach file” glyph).
 * Own viewBox so the long open wire stays legible at 18px; stroke weight is
 * matched to the other composer footer icons.
 */
export function AttachmentIcon() {
  return (
    <svg
      className="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/**
 * What the paperclip's context menu offers. Two ways a file can enter a
 * message, and only these two: the OS file dialog hands over a real file the
 * browser can read, and the clipboard hands over what the user just cut or
 * screenshotted. Everything else (drag-and-drop, a typed path) the browser
 * cannot see as a file, so it is not offered.
 */
export const ATTACHMENT_ACTIONS = [
  {
    id: 'files',
    label: 'Add Files',
    hint: 'Choose a file from your computer — the operating system opens its own dialog.',
    icon: FileChooseIcon,
  },
  {
    id: 'clipboard',
    label: 'Paste From Clipboard',
    hint: 'Take the image or text the clipboard is holding now — where the browser cannot read it without asking, paste it and this takes that paste.',
    icon: ClipboardIcon,
  },
];

/** A sheet of paper — the OS file dialog. */
function FileChooseIcon() {
  return (
    <ComposerSvg>
      <path strokeLinejoin="round" d="M4 2.5h5.5l2.5 2.5v10h-8v-12.5z" />
      <path strokeLinejoin="round" d="M9.5 2.5l2.5 2.5M9.5 2.5v2.5h2.5" />
      <path strokeLinecap="round" d="M5.5 7h4M5.5 9.5h4" />
    </ComposerSvg>
  );
}

/** A clipboard with a clipped sheet — the clipboard paste. */
function ClipboardIcon() {
  return (
    <ComposerSvg>
      <rect x="3.5" y="3.5" width="9" height="11" rx="1.5" />
      <path strokeLinejoin="round" d="M6 2.5h4v1.5h-4z" />
      <path strokeLinecap="round" d="M6 7h4M6 9.5h4" />
    </ComposerSvg>
  );
}

/**
 * The paperclip and its context menu. Hovering the paperclip (or tabbing to
 * one of its options) reveals the two ways a file can enter this message; the
 * menu itself is always in the DOM and only hidden by CSS (.chat-attach-menu /
 * .chat-attach-group in index.css), the same mechanism the rail submenus use,
 * so a screenshot script or a keyboard user can still reach an option they
 * have not hovered yet. It opens UPWARD and hangs to the LEFT of the paperclip
 * (`right-0 bottom-[100%]`): the composer sits against the bottom-right of the
 * panel, so a menu that grew down or to the right would always run past the
 * viewport.
 *
 * State stays with SessionChat — this component only routes which action the
 * user picked, exactly like ComposerDropdown routes a picker selection.
 * @param {Array<{ id, label, hint, icon }>} actions
 * @param {(id: string) => void} onAction
 */
export function AttachmentPicker({ actions = ATTACHMENT_ACTIONS, onAction }) {
  return (
    <div className="chat-attach-group relative inline-flex h-8 w-8 items-center justify-center">
      <span
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400"
        title="Attach a file to this message — hover for its options"
      >
        <AttachmentIcon />
      </span>
      <div
        role="menu"
        aria-label="Attach a file to this message"
        className="chat-attach-menu absolute right-0 bottom-[100%] z-50 w-[15rem] rounded-lg border border-gray-700 bg-gray-950 shadow-lg divide-y divide-gray-800"
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            title={action.hint}
            aria-label={action.label}
            onClick={() => onAction?.(action.id)}
            className="flex w-full h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-left transition-colors text-gray-400 hover:bg-gray-800 hover:text-gray-100"
          >
            {action.icon}
            <span className="whitespace-nowrap">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Dictation placeholder — microphone, no speech capture yet. */
export function DictateIcon() {
  return (
    <ComposerSvg>
      <rect x="6" y="1.75" width="4" height="7" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7.75a4 4 0 0 0 8 0M8 11.75v2.5" />
    </ComposerSvg>
  );
}

/** Live voice — waveform bars for the empty-composer primary action. */
export function VoiceIcon() {
  return (
    <ComposerSvg>
      <path strokeLinecap="round" d="M3 6.5v3M5.5 4.5v7M8 3v10M10.5 5.5v5M13 7v2" />
    </ComposerSvg>
  );
}
