import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmt } from '../lib/format.js';
import { CloseIcon, IconButton, RefreshIcon } from './IconButton.jsx';

const TOOL_GROUP_LABELS = {
  file: 'File',
  trail: 'Trail',
  task: 'Tasks',
  terminal: 'Terminal',
  browser: 'Browser',
};

async function fetchSessionTools() {
  const res = await fetch('/kusa/tools', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  if (!raw) return null;
  return JSON.parse(raw);
}

function groupRows(rows) {
  const groups = [];
  for (const row of rows || []) {
    if (row.depth && groups.length) groups[groups.length - 1].children.push(row);
    else groups.push({ row, children: [] });
  }
  return groups;
}

export function ToolsPanel({ lane, toolWarnMs, now, expandedTools, onToggleTool }) {
  const [available, setAvailable] = useState(null);
  const [availableError, setAvailableError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        setAvailable(await fetchSessionTools());
        setAvailableError(null);
      } catch (err) {
        setAvailableError(err?.message || 'Could not load the session tool list');
      }
    };
    void load();
  }, []);

  const refreshTools = useCallback(async () => {
    try {
      setAvailable(await fetchSessionTools());
      setAvailableError(null);
    } catch (err) {
      setAvailableError(err?.message || 'Could not load the session tool list');
    }
  }, []);

  if (!lane) return null;
  const usedNames = new Set((lane.rows || []).map((row) => String(row.name || '')));
  const overdueOpen = (lane.open || []).filter((inv) => now - inv.startedWall >= toolWarnMs);
  const overdueTools = new Set(overdueOpen.map((inv) => inv.toolName));
  const overdueCommands = new Set(overdueOpen.map((inv) => inv.subName).filter(Boolean));
  const groups = groupRows(lane.rows);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-2 text-base font-semibold">Tool Call Statistics</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-xs uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Tool</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">Running</th>
                <th className="px-3 py-2 text-right font-medium">Success</th>
                <th className="px-3 py-2 text-right font-medium">Failed</th>
                <th className="px-3 py-2 text-right font-medium">Denied</th>
                <th className="px-3 py-2 text-right font-medium">Incomplete</th>
                <th className="px-3 py-2 text-right font-medium">Avg</th>
                <th className="px-3 py-2 text-right font-medium">Max</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {groups.length ? groups.map(({ row, children }) => {
                const open = expandedTools.has(row.name);
                const overdue = overdueTools.has(row.name);
                return (
                  <ToolGroup
                    key={row.name}
                    row={row}
                    childrenRows={children}
                    open={open}
                    overdue={overdue}
                    overdueCommands={overdueCommands}
                    onToggle={() => onToggleTool(row.name)}
                  />
                );
              }) : (
                <tr><td colSpan={9} className="px-3 py-3 text-gray-500">No tool calls yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold">In flight</h2>
        <ul className="space-y-1 text-sm">
          {(lane.open || []).length ? lane.open.map((inv) => {
            const age = now - inv.startedWall;
            const overdue = age >= toolWarnMs;
            return (
              <li key={inv.id} className={overdue ? 'text-amber-300' : ''}>
                <code className="text-sky-300">{inv.toolName}</code>{' '}
                {inv.subName ? <code className="text-xs text-gray-300">{inv.subName}</code> : null}{' '}
                <span className="text-gray-500">{inv.id}</span> · {fmt(age)}
                {overdue ? ' · long-running' : ''}
                {inv.callId ? '' : ' · no call id'}
              </li>
            );
          }) : (
            <li className="text-gray-500">None.</li>
          )}
        </ul>
      </section>
      <AvailableTools
        available={available}
        loadError={availableError}
        usedNames={usedNames}
        onRefresh={refreshTools}
      />
    </div>
  );
}

function AvailableTools({ available, loadError, usedNames, onRefresh }) {
  const groups = Array.isArray(available?.groups) ? available.groups : [];
  const total = groups.reduce((sum, entry) => sum + (entry.tools || []).length, 0);

  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">
        Available tools
        <span className="ml-2 text-xs font-normal text-gray-500">{total}</span>
      </h2>
      <div className="flex items-center justify-between gap-3 mb-2 text-xs text-gray-500">
        <p>
          Every tool the Kusă agent can call in this session, as advertised by{' '}
          <code className="text-sky-300">GET /kusa/tools</code> for the current settings.
          Badges: <span className="text-emerald-400">used</span> in this session ·{' '}
          <span className="text-amber-400">approval-gated</span> (needs a user yes first).
        </p>
        <IconButton label="Reload tool list" icon={RefreshIcon} onClick={onRefresh} />
      </div>
      {available ? (
        <>
          <p className="mt-1 text-xs text-gray-500">
            Backend <code className="text-sky-300">{available.backend || 'native'}</code> ·{' '}
            model <code className="text-sky-300">{available.model || '—'}</code> ·{' '}
            approval <code className="text-sky-300">{available.approvalModeLabel || available.approvalMode || 'ask-deny'}</code>
            {available.trailEnforced ? ' · Trail enforcement is on (file tools need kusa_trail_ask first)' : ''}
            {available.note ? ` ${available.note}` : ''}
          </p>
          <div className="mt-2 overflow-x-auto rounded-xl border border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-xs uppercase tracking-wide text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Tool</th>
                  <th className="px-3 py-2 text-left font-medium">Group</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2 text-left font-medium">Session</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {groups.flatMap((entry) => (entry.tools || []).map((tool) => (
                  <AvailableToolRow
                    key={`${entry.group}:${tool.name}`}
                    group={entry.group}
                    tool={tool}
                    used={usedNames.has(tool.name)}
                  />
                )))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-gray-500">
          {loadError ? `Could not load the tool list: ${loadError}` : 'Loading tool list…'}{' '}
          The list needs the local console server (<code className="text-sky-300">kusa serve</code>).
        </p>
      )}
    </section>
  );
}

function AvailableToolRow({ group, tool, used }) {
  const name = String(tool.name || '');
  return (
    <tr className="text-xs text-gray-400">
      <td className="px-3 py-2">
        <code className="text-sky-300">{name}</code>
      </td>
      <td className="px-3 py-2 text-gray-500">
        {TOOL_GROUP_LABELS[group] || group}
      </td>
      <td className="px-3 py-2 line-clamp-2 text-gray-500">{tool.description || '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <span className="flex items-center gap-1.5">
          {used ? <span className="text-emerald-400">used</span> : null}
          {tool.approvalGated ? <span className="text-amber-400">gated</span> : null}
          {!used && !tool.approvalGated ? <span className="text-gray-600">idle</span> : null}
        </span>
      </td>
    </tr>
  );
}

function CommandModal({ name, commands, onClose }) {
  const titleId = useId();
  const closeRef = useRef(null);

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

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(80vh,40rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-4 py-3">
          <h2 id={titleId} className="truncate text-sm font-semibold text-gray-100">
            Command · <code className="font-mono text-sky-300">{name}</code>
          </h2>
          <IconButton
            ref={closeRef}
            label="Close"
            icon={CloseIcon}
            onClick={onClose}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {commands.map((command) => (
            <pre
              key={command}
              className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-xs leading-relaxed text-gray-100 whitespace-pre-wrap break-all"
            >
              <code>{`$ ${command}`}</code>
            </pre>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CommandRow({ row, overdue }) {
  const commands = Array.isArray(row.commands) ? row.commands : [];
  const [open, setOpen] = useState(false);
  return (
    <tr className={`child text-xs text-gray-400 ${overdue ? 'overdue bg-amber-950/40 text-amber-200' : ''}`}>
      <td className="px-3 py-2 pl-10">
        {commands.length ? (
          <button
            type="button"
            className="cursor-pointer text-left"
            aria-haspopup="dialog"
            aria-expanded={open}
            title="Show the full command"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
            }}
          >
            <code className="text-xs text-sky-300 underline decoration-dotted underline-offset-2">{row.name}</code>
          </button>
        ) : (
          <code className="text-xs text-sky-300">{row.name}</code>
        )}
        {open ? (
          <CommandModal
            name={row.name}
            commands={commands}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </td>
      <Cells row={row} />
    </tr>
  );
}

function Cells({ row }) {
  return (
    <>
      {[row.total, row.running, row.success, row.failed, row.denied, row.incomplete, fmt(row.avg), fmt(row.max)].map((cell, i) => (
        <td key={i} className="px-3 py-2 text-right tabular-nums">{cell}</td>
      ))}
    </>
  );
}

function ToolGroup({ row, childrenRows, open, overdue, overdueCommands, onToggle }) {
  return (
    <>
      <tr
        data-tool={childrenRows.length ? row.name : undefined}
        aria-expanded={childrenRows.length ? open : undefined}
        className={`${childrenRows.length ? 'tool-group cursor-pointer select-none hover:bg-gray-800/60 ' : ''}${overdue ? 'overdue bg-amber-950/40 text-amber-200' : ''}`}
        onClick={childrenRows.length ? onToggle : undefined}
      >
        <td className="px-3 py-2">
          {childrenRows.length ? (
            <svg className={`mr-1.5 inline h-3 w-3 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 4l4 4-4 4z" />
            </svg>
          ) : (
            <span className="mr-1.5 inline-block w-3" />
          )}
          <span className="font-medium">{row.name}</span>
          {childrenRows.length ? (
            <span className="ml-1 rounded-full bg-gray-800 px-1.5 text-[10px] text-gray-400">{childrenRows.length}</span>
          ) : null}
        </td>
        <Cells row={row} />
      </tr>
      {open && childrenRows.map((child) => (
        <CommandRow
          key={child.name}
          row={child}
          overdue={overdueCommands.has(child.name)}
        />
      ))}
    </>
  );
}
