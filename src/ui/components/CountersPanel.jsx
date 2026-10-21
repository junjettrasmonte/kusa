import { clock, fmt } from '../lib/format.js';

export function CountersPanel({ lane, now, sdkListener }) {
  if (!lane) return null;
  const s = lane.summary;
  const session = lane.session;
  const end = session.active ? now : (session.endedAtWall ?? now);
  const elapsed = session.startedAtWall == null ? '—' : clock(end - session.startedAtWall);
  const prompt = session.turnOpen && session.promptStartedAtWall != null
    ? clock(now - session.promptStartedAtWall)
    : (session.promptIndex ? 'done' : '—');
  const turn = session.turnStartedAtWall != null
    ? (session.turnEndedAtWall != null
      ? clock(session.turnEndedAtWall - session.turnStartedAtWall)
      : clock(now - session.turnStartedAtWall))
    : '—';
  const apiAvg = session.apiCallDurationAvgMs != null ? fmt(session.apiCallDurationAvgMs) : '—';
  const idle = session.lastEventAtWall == null ? null : now - session.lastEventAtWall;
  const L = sdkListener || {};
  const timing =
    `Prompt ${session.promptIndex} · turn ${session.turnOpen ? 'open' : 'closed'}` +
    (session.startObserved ? '' : ' · start not observed') +
    ` · idle since last event (${session.lastEventName || '—'}): ${fmt(idle)}` +
    ` · subagents ${lane.subagents.started}/${lane.subagents.stopped}` +
    ` · agent errors ${lane.agentErrors}` +
    (session.endReason ? ` · ended: ${session.endReason}` : '') +
    '.';

  return (
    <section>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Tool calls" value={s.attempts} />
        <Stat label="Session elapsed" value={elapsed} />
        <Stat label="Prompt elapsed" value={prompt} />
        <Stat label="SDK turn elapsed" value={turn} />
        <Stat label="API-call avg" value={apiAvg} />
        <Stat label="Running" value={s.running} />
        <Stat label="Success / Failed / Denied" value={`${s.success} / ${s.failed} / ${s.denied}`} />
      </div>
      <p className="mt-3 text-sm text-gray-400">{timing}</p>
      {(session.currentIntent || session.reasoning?.seen || L.status) ? (
        <p className="mt-2 text-sm text-gray-400">
          {L.status ? (
            <span>
              Listener <span className={listenerClass(L.status)}>{L.status}</span>
              {L.lastEventType ? ` · last ${L.lastEventType}` : ''}
              {' · '}
            </span>
          ) : null}
          {session.currentIntent ? <span>Intent: {session.currentIntent}</span> : <span>Intent: —</span>}
          {session.reasoning?.seen ? (
            <span>
              {' · '}Reasoning {session.reasoning.active ? 'active' : 'idle'}
              {session.reasoning.blocks ? ` · ${session.reasoning.blocks} block(s)` : ''}
              {session.reasoning.textPersisted ? ' · text persisted' : ' · status only'}
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-gray-600">
        API-call avg is from SDK <code className="text-sky-300">assistant.usage.duration</code> when present.
        It is not total turn time. Hook durations remain wall/monotonic deltas between events.
      </p>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function listenerClass(status) {
  if (status === 'connected') return 'text-emerald-400';
  if (status === 'unsupported' || status === 'error') return 'text-amber-400';
  return 'text-gray-300';
}
