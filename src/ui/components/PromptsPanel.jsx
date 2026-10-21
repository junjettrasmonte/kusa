import { fmt, stamp } from '../lib/format.js';
import { MarkdownBody } from './MarkdownBody.jsx';

const TODO_MARK = {
  completed: <span className="text-emerald-950">✓</span>,
  in_progress: <span className="text-amber-950">●</span>,
  cancelled: <span className="text-gray-600">–</span>,
  pending: <span className="text-gray-700">○</span>,
};

/** Solid badges: bright fill + near-black text for contrast on dark/light themes. */
function Badge({ tone, children }) {
  // Use text-black (not gray-950) so light-theme gray remaps cannot wash out the label.
  const tones = {
    user: 'bg-sky-300 text-black',
    system: 'bg-amber-300 text-black',
    plan: 'bg-violet-300 text-black',
    hasPlan: 'bg-emerald-300 text-black',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tones[tone] || tones.user}`}>
      {children}
    </span>
  );
}

function PromptPlan({ plan, todos }) {
  if (!plan && !(todos && todos.length)) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Plan</h3>
      {plan ? (
        <article className="mt-2 rounded-lg border border-gray-700 bg-gray-950/80 p-3">
          {plan.name ? <h4 className="text-sm font-semibold text-gray-100">{plan.name}</h4> : null}
          {plan.overview ? <p className="mt-1 text-xs text-gray-300">{plan.overview}</p> : null}
          {plan.path || plan.source ? (
            <p className="mt-1.5 text-[11px] text-gray-500">
              {plan.source || ''}
              {plan.path ? (
                <>
                  {plan.source ? ' · ' : ''}
                  <code className="text-sky-300">{plan.path}</code>
                </>
              ) : null}
            </p>
          ) : null}
          {plan.body ? <MarkdownBody text={plan.body} /> : null}
        </article>
      ) : null}
      {todos && todos.length ? (
        <ul className="mt-2 space-y-1.5 text-sm">
          {todos.map((t) => (
            <li
              key={t.id || t.content}
              className={`flex gap-2 rounded-lg border border-gray-700 bg-gray-950/80 px-3 py-2 ${
                t.status === 'completed' ? 'text-gray-500 line-through'
                  : t.status === 'cancelled' ? 'text-gray-600 line-through' : 'text-gray-100'
              }`}
            >
              <span className="mt-0.5 shrink-0">{TODO_MARK[t.status] || TODO_MARK.pending}</span>
              <span className="min-w-0 flex-1">
                {t.content}{' '}
                <span className="text-[10px] uppercase tracking-wide text-gray-500">{t.status}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PromptCard({ prompt: p, open, onToggle }) {
  const preview = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const previewMore = (p.text || '').replace(/\s+/g, ' ').trim().length > 140 || p.truncated ? '…' : '';
  const hasReply = Boolean(p.response) || (p.responseChars > 0);
  const role = p.role === 'plan' || p.role === 'system' ? p.role : 'user';
  const hasPlan = Boolean(p.plan) || (Array.isArray(p.todos) && p.todos.length > 0);

  return (
    <details
      className="rounded-xl border border-gray-800 bg-gray-900"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-gray-400">
          <span className="font-semibold text-gray-200">#{p.index}</span>
          <Badge tone={role}>{role === 'plan' ? 'Plan' : role === 'system' ? 'System' : 'User'}</Badge>
          {hasPlan ? <Badge tone="hasPlan">Has plan</Badge> : null}
          <span className="font-mono">{stamp(p.atWall)}</span>
          <span>{p.open ? <span className="text-amber-300">open</span> : 'done'}</span>
          <span className="tabular-nums">{fmt(p.open ? null : p.durationMs)}</span>
          <span className="tabular-nums">{p.toolAttempts} tools</span>
          <span className="tabular-nums">{p.chars} chars</span>
          {hasReply ? (
            <span className="tabular-nums text-sky-300">
              reply {p.responseChars || (p.response || '').length} chars
            </span>
          ) : (
            <span className="tabular-nums text-gray-600">reply —</span>
          )}
          {p.trailSavedTokens != null ? (
            <span className="tabular-nums text-emerald-400">
              Trail saved ~{Number(p.trailSavedTokens).toLocaleString('en-US')}
            </span>
          ) : (
            <span className="tabular-nums text-gray-600">Trail saved —</span>
          )}
        </div>
        {preview ? (
          <p className="mt-2 text-xs text-gray-400 line-clamp-2">{preview}{previewMore}</p>
        ) : (
          <p className="mt-2 text-xs text-gray-600">(empty prompt)</p>
        )}
        {hasPlan && p.plan?.name ? (
          <p className="mt-1 text-xs font-medium text-emerald-300">Plan: {p.plan.name}</p>
        ) : null}
      </summary>
      <div className="space-y-4 border-t border-gray-800 px-4 py-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {role === 'plan' ? 'Plan execution' : role === 'system' ? 'System prompt' : 'User prompt'}
          </h3>
          {p.text ? (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-950/80 p-3 font-mono text-xs text-gray-200">
              {p.text}{p.truncated ? '\n\n… truncated' : ''}
            </pre>
          ) : (
            <p className="mt-2 text-xs text-gray-500">(empty prompt)</p>
          )}
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Agent response</h3>
          {hasReply ? (
            <MarkdownBody text={p.response || ''} truncated={p.responseTruncated} />
          ) : (
            <p className="mt-2 text-xs text-gray-500">
              {p.open
                ? 'Waiting for agent reply…'
                : 'No reply captured (only Cursor afterAgentResponse sends reply text).'}
            </p>
          )}
        </div>
        {hasPlan ? <PromptPlan plan={p.plan} todos={p.todos} /> : null}
      </div>
    </details>
  );
}

export function PromptsPanel({ prompts, expanded, onToggle }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">Current Session Prompts</h2>
      <p className="mb-3 text-xs text-gray-500">
        Newest first. Badges: User / System / Plan (auto “Implement the plan…”). Plans created in a turn
        (or accepted for execution) appear under that prompt’s agent response. Text is local and gitignored
        (prompts capped at 8000 characters).
      </p>
      <div className="space-y-3 text-sm">
        {prompts.length ? (
          prompts.map((p) => {
            const key = String(p.index);
            return (
              <PromptCard
                key={key}
                prompt={p}
                open={expanded.has(key)}
                onToggle={(next) => onToggle(key, next)}
              />
            );
          })
        ) : (
          <p className="text-gray-500">No prompts yet.</p>
        )}
      </div>
    </section>
  );
}
