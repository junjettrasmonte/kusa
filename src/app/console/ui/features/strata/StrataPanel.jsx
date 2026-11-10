import { useCallback, useEffect, useRef, useState } from 'react';
import { stamp } from '#ui/shared/lib/format.js';
import { IconButton } from '#ui/shared/IconButton.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

const POLL_MS = 10_000;
const PROBE_IDS = ['metrics', 'status', 'slots', 'props'];
const ICON_18 = 'h-[18px] w-[18px]';

function LucideRefreshIcon({ className = ICON_18 }) {
  return <LucideIcon name="refresh-cw" className={className} />;
}

function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  if (Math.abs(rounded) >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (Math.abs(rounded) >= 10_000) return `${(rounded / 1000).toFixed(1)}k`;
  return rounded.toLocaleString('en-US');
}

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (abs >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MiB`;
  return `${Math.round(n)} B`;
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n)}%`;
}

function formatFixed(value, digits, suffix = '') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}${suffix}`;
}

function hostLabel(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return String(baseUrl || '').trim();
  }
}

function fileName(path) {
  const text = String(path || '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

function ratioOf(used, limit) {
  const u = Number(used);
  const m = Number(limit);
  if (!Number.isFinite(u) || !Number.isFinite(m) || m <= 0) return null;
  return Math.max(0, Math.min(1, u / m));
}

function percentRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n / 100));
}

function pressureClass(ratio) {
  if (ratio == null) return 'bg-gray-600';
  if (ratio >= 0.9) return 'bg-rose-400';
  if (ratio >= 0.7) return 'bg-amber-400';
  return 'bg-emerald-400';
}

function stateMeta(state, loaded) {
  if (loaded === false || state === 'unloaded') {
    return { label: 'Unloaded', tone: 'text-amber-300 bg-amber-400/10' };
  }
  if (state === 'generating') return { label: 'Generating', tone: 'text-emerald-300 bg-emerald-400/10' };
  if (state === 'reading') return { label: 'Reading prompt', tone: 'text-sky-300 bg-sky-400/10' };
  // Idle / no live phase while the model is resident — not an update state.
  if (state === 'idle' || loaded === true) {
    return { label: 'Loaded', tone: 'text-emerald-300 bg-emerald-400/10' };
  }
  return { label: 'Unknown', tone: 'text-gray-400 bg-gray-800' };
}

function probeCaption(probe) {
  if (!probe) return 'waiting';
  if (probe.ok) return 'live';
  if (probe.error === 'not-json') return 'not JSON';
  if (probe.error === 'unreachable') return 'unreachable';
  if (probe.status) return `HTTP ${probe.status}`;
  return 'down';
}

async function postControl(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function Sparkline({ values, className = 'text-emerald-400' }) {
  const pts = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const w = 120;
  const h = 28;
  const d = pts.map((value, index) => {
    const x = (index / (pts.length - 1)) * w;
    const y = h - ((value - min) / span) * (h - 2) - 1;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`mt-2 h-7 w-full ${className}`} fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Meter({ label, value, ratio, hint, icon }) {
  const width = ratio == null ? 0 : Math.round(ratio * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 text-gray-400">
          {icon ? <LucideIcon name={icon} className="h-3 w-3 text-gray-500" strokeWidth={2.25} /> : null}
          {label}
        </span>
        <span className="tabular-nums text-gray-100">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-800">
        <div className={`h-full rounded-full ${pressureClass(ratio)}`} style={{ width: `${width}%` }} />
      </div>
      {hint ? <p className="mt-1 text-[10px] leading-snug text-gray-600">{hint}</p> : null}
    </div>
  );
}

function Section({ title, source, icon, children, actions = null }) {
  return (
    <section className="rounded-lg border border-gray-800 bg-gray-950/50 p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {icon ? <LucideIcon name={icon} className="h-3.5 w-3.5 text-emerald-400/80" strokeWidth={2.25} /> : null}
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
          </div>
          {source ? <code className="mt-0.5 block text-[10px] text-gray-600">{source}</code> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ContextSlots({ slots, maxContext }) {
  if (!slots.length) {
    return (
      <p className="text-xs text-gray-500">
        {maxContext
          ? `Configured window ${formatTokens(maxContext)}. No slot is reporting prompt tokens.`
          : 'No slot is reporting prompt tokens.'}
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {slots.map((slot) => {
        const limit = slot.nCtx || maxContext;
        const ratio = ratioOf(slot.used, limit);
        const pct = ratio == null ? null : Math.round(ratio * 100);
        return (
          <li key={slot.id}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-gray-300">
                Slot {slot.id}
                {slot.state && slot.state !== 'idle' ? (
                  <span className="ml-2 text-emerald-300">{slot.state}</span>
                ) : slot.processing ? (
                  <span className="ml-2 text-emerald-300">processing</span>
                ) : null}
                {slot.tokS != null ? (
                  <span className="ml-2 tabular-nums text-gray-500">{formatFixed(slot.tokS, 0)} tok/s</span>
                ) : null}
              </span>
              <span className="tabular-nums text-gray-100">
                {formatTokens(slot.used)}
                <span className="text-gray-500"> / {formatTokens(limit)}</span>
                {pct != null ? <span className="ml-2 text-gray-400">{pct}%</span> : null}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-gray-800">
              <div
                className={`h-full rounded-full ${pressureClass(ratio)}`}
                style={{ width: `${ratio == null ? 0 : Math.round(ratio * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function InferenceVisual({ live, tokHistory }) {
  const reading = live?.state === 'reading' && live.promptTotal;
  const generating = live?.state === 'generating';
  const capped = generating && live.maxTokens != null && live.maxTokens > 0;
  const ratio = reading
    ? ratioOf(live.promptRead, live.promptTotal)
    : (capped ? ratioOf(live.generated, live.maxTokens) : null);
  const headline = reading
    ? `${formatTokens(live.promptRead)} / ${formatTokens(live.promptTotal)} prompt tokens`
    : generating
      ? `${formatTokens(live.generated)} generated${capped ? ` / ${formatTokens(live.maxTokens)}` : ''}`
      : (live?.phase || 'Waiting for the next request');
  return (
    <div className="space-y-3">
      <p className="text-sm tabular-nums text-gray-100">{headline}</p>
      <div className="h-2 overflow-hidden rounded-full bg-gray-800">
        <div
          className={`h-full rounded-full ${ratio == null ? 'w-0' : pressureClass(ratio)}`}
          style={ratio == null ? undefined : { width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <dt className="text-gray-500">Tokens / s</dt>
          <dd className="tabular-nums text-gray-100">{formatFixed(live?.tokS, 1)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Elapsed</dt>
          <dd className="tabular-nums text-gray-100">{formatFixed(live?.elapsedS, 1, ' s')}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Queued</dt>
          <dd className="tabular-nums text-gray-100">{live?.queued ?? 0}</dd>
        </div>
      </dl>
      <Sparkline values={tokHistory} />
    </div>
  );
}

function RequestBars({ requests }) {
  const rows = (requests || []).filter((row) => row.decodeTokS != null);
  if (!rows.length) return null;
  const peak = Math.max(...rows.map((row) => row.decodeTokS), 1);
  return (
    <div className="mt-3">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-600">Recent decode</p>
      <div className="flex h-14 items-end gap-1" aria-hidden="true">
        {rows.map((row, index) => (
          <div
            key={`${row.finish}-${index}`}
            title={`${formatFixed(row.decodeTokS, 1)} tok/s · ${formatTokens(row.outputTokens)} out`}
            className="min-w-0 flex-1 rounded-sm bg-emerald-400/80"
            style={{ height: `${Math.max(8, Math.round((row.decodeTokS / peak) * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function decodeRate(totals) {
  if (!totals || totals.outputTokens == null || !(totals.decodeMs > 0)) return null;
  return totals.outputTokens / (totals.decodeMs / 1000);
}

function ActionButton({ label, icon, onClick, disabled, tone = 'default' }) {
  const toneClass = tone === 'danger'
    ? 'border-rose-800/60 text-rose-300 hover:bg-rose-950/40'
    : tone === 'accent'
      ? 'border-emerald-700/50 text-emerald-300 hover:bg-emerald-950/40'
      : 'border-gray-700 text-gray-300 hover:bg-gray-800/70';
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      <LucideIcon name={icon} className="h-3.5 w-3.5" strokeWidth={2.25} />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

export function StrataPanel({ canLiveRefresh = false }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [actionNote, setActionNote] = useState('');
  const abortRef = useRef(null);

  const refresh = useCallback(async (force = false) => {
    if (!canLiveRefresh) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const res = await fetch(force ? '/kusa/strata?force=1' : '/kusa/strata', {
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail || `HTTP ${res.status}`);
      }
      setData(await res.json());
      setLoadError(null);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setLoadError(err?.message || String(err));
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  }, [canLiveRefresh]);

  useEffect(() => {
    if (!canLiveRefresh) {
      setData(null);
      return undefined;
    }
    refresh(true);
    const id = setInterval(() => refresh(false), POLL_MS);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [canLiveRefresh, refresh]);

  const runAction = useCallback(async (key, fn) => {
    if (!canLiveRefresh || actionBusy) return;
    setActionBusy(key);
    setActionNote('');
    try {
      const result = await fn();
      setActionNote(result?.update?.summary
        || result?.body?.message
        || result?.error
        || (key === 'load' ? 'Model load requested.'
          : key === 'unload' ? 'Model unload requested.'
            : key === 'check' ? 'Update check finished.'
              : 'Update started.'));
      await refresh(true);
    } catch (err) {
      setActionNote(err?.message || String(err));
    } finally {
      setActionBusy('');
    }
  }, [actionBusy, canLiveRefresh, refresh]);

  if (!canLiveRefresh) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <LucideIcon name="layers" className="h-4 w-4 text-emerald-400" />
          <h2 className="text-base font-semibold text-gray-100">Strata</h2>
        </div>
        <p className="text-sm text-gray-400">
          Serve with <code className="text-sky-300">npm run kusa:serve</code> to probe the Kusă endpoint.
        </p>
      </div>
    );
  }

  const confirmed = data?.strata === true;
  const loaded = data?.loaded;
  const state = stateMeta(data?.live?.state, loaded);
  const hardware = data?.hardware || {};
  const props = data?.props;
  const update = data?.update;
  // Only lock controls while an action is in flight — never during the 2s poll.
  const controlsBusy = Boolean(actionBusy);

  return (
    <div className="space-y-4 text-sm text-gray-300">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <LucideIcon name="layers" className="h-4 w-4 text-emerald-400" />
            <h2 className="text-base font-semibold text-gray-100">Strata</h2>
            {confirmed ? (
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${state.tone}`}>{state.label}</span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {data?.baseUrl
              ? hostLabel(data.baseUrl)
              : 'Kusă agent endpoint'}
            {confirmed && data.model ? ` · ${data.model}` : ''}
            {data?.checkedAt ? ` · ${stamp(data.checkedAt)}` : ''}
            {busy ? ' · refreshing' : ''}
          </p>
        </div>
        <IconButton label="Refresh" icon={LucideRefreshIcon} disabled={busy || Boolean(actionBusy)} onClick={() => refresh(true)} />
      </div>

      {loadError ? <p className="text-xs text-amber-400">Probe failed: {loadError}</p> : null}
      {actionNote ? <p className="text-xs text-sky-300">{actionNote}</p> : null}

      {!data && !loadError ? (
        <p className="text-sm text-gray-400">Checking the Kusă endpoint…</p>
      ) : null}

      {data && !confirmed ? (
        <section className="rounded-lg border border-gray-800 bg-gray-950/50 p-4">
          <p className="text-sm text-gray-300">
            {data.reason === 'no-endpoint'
              ? 'Add a Kusă agent base URL under Settings → Agent. Once that host confirms as Strata, this page draws /metrics, /status, /slots, and /props.'
              : 'Waiting for this Kusă endpoint to confirm as Strata. After /health matches, the page draws context, inference, and hardware from /metrics, /status, /slots, and /props.'}
          </p>
        </section>
      ) : null}

      {confirmed ? (
        <>
          <div className="flex flex-wrap gap-2">
            {PROBE_IDS.map((id) => {
              const probe = data.probes?.[id];
              const ok = probe?.ok === true;
              return (
                <span
                  key={id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${
                    ok
                      ? 'border-emerald-400/30 text-emerald-300'
                      : 'border-amber-400/30 text-amber-300'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  /{id}
                  <span className="text-gray-500">{probeCaption(probe)}</span>
                </span>
              );
            })}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Section title="Context" source="GET /slots" icon="layers">
              <ContextSlots slots={data.slots || []} maxContext={data.maxContext} />
              {props?.nCtx ? (
                <p className="mt-3 text-[11px] text-gray-500">
                  Configured window {formatTokens(props.nCtx)}
                  {props.totalSlots != null ? ` · ${props.totalSlots} slot${props.totalSlots === 1 ? '' : 's'}` : ''}
                </p>
              ) : null}
            </Section>
            <Section title="Inference" source="GET /status" icon="activity">
              <InferenceVisual live={data.live} tokHistory={hardware.history?.tokS} />
              <RequestBars requests={data.requests} />
            </Section>
          </div>

          <Section title="Hardware" source="GET /metrics" icon="cpu">
            {hardware.gpuName || hardware.cpuName ? (
              <p className="mb-3 text-[11px] text-gray-400">
                {[hardware.gpuName, hardware.cpuName].filter(Boolean).join(' · ')}
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <Meter label="GPU load" icon="gauge" value={formatPct(hardware.gpuUtil)} ratio={percentRatio(hardware.gpuUtil)} />
                <Sparkline values={hardware.history?.gpuUtil} />
              </div>
              <div>
                <Meter
                  label="VRAM"
                  icon="memory-stick"
                  value={`${formatBytes(hardware.gpuMemUsed)} / ${formatBytes(hardware.gpuMemTotal)}`}
                  ratio={ratioOf(hardware.gpuMemUsed, hardware.gpuMemTotal)}
                />
                <Sparkline values={hardware.history?.gpuMemUsed} className="text-sky-300" />
              </div>
              <div>
                <Meter
                  label="GPU power"
                  icon="gauge"
                  value={hardware.gpuPowerLimit
                    ? `${formatFixed(hardware.gpuPower, 0, ' W')} / ${formatFixed(hardware.gpuPowerLimit, 0, ' W')}`
                    : formatFixed(hardware.gpuPower, 0, ' W')}
                  ratio={ratioOf(hardware.gpuPower, hardware.gpuPowerLimit)}
                  hint={hardware.gpuTemp != null ? `${formatFixed(hardware.gpuTemp, 0, ' °C')}` : ''}
                />
                <Sparkline values={hardware.history?.gpuPower} className="text-amber-300" />
              </div>
              <div>
                <Meter label="CPU" icon="cpu" value={formatPct(hardware.cpu)} ratio={percentRatio(hardware.cpu)} />
                <Meter
                  label="RAM"
                  icon="memory-stick"
                  value={`${formatBytes(hardware.ramUsed)} / ${formatBytes(hardware.ramTotal)}`}
                  ratio={ratioOf(hardware.ramUsed, hardware.ramTotal)}
                />
                <Sparkline values={hardware.history?.cpu} className="text-gray-300" />
              </div>
            </div>
            {hardware.gpuNote ? (
              <p className="mt-3 text-[11px] text-gray-500">{hardware.gpuNote}</p>
            ) : null}
            {Array.isArray(hardware.gpus) && hardware.gpus.length > 1 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {hardware.gpus.map((gpu) => (
                  <li key={gpu.index} className="rounded-md border border-gray-800 px-2 py-1.5 text-[11px]">
                    <p className="text-gray-300">{gpu.name || `GPU ${gpu.index}`}</p>
                    <p className="tabular-nums text-gray-500">
                      {formatPct(gpu.util)} · {formatBytes(gpu.memUsed)} / {formatBytes(gpu.memTotal)}
                      {gpu.temp != null ? ` · ${formatFixed(gpu.temp, 0, ' °C')}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>

          <div className="grid gap-3 lg:grid-cols-2">
            <Section
              title="Model"
              source="GET /props · POST /load · POST /unload"
              icon="package"
              actions={(
                <div className="flex flex-wrap gap-1.5">
                  <ActionButton
                    label={actionBusy === 'load' ? 'Loading…' : 'Load'}
                    icon="download"
                    tone="accent"
                    disabled={controlsBusy || loaded === true}
                    onClick={() => void runAction('load', () => postControl('/kusa/strata/load', {
                      model: data.model || '',
                    }))}
                  />
                  <ActionButton
                    label={actionBusy === 'unload' ? 'Unloading…' : 'Unload'}
                    icon="upload"
                    tone="danger"
                    disabled={controlsBusy || loaded === false}
                    onClick={() => {
                      if (!window.confirm('Unload the Strata model and free GPU VRAM? Active requests will be refused until it is loaded again.')) {
                        return;
                      }
                      void runAction('unload', () => postControl('/kusa/strata/unload', {
                        wait: true,
                        model: data.model || '',
                      }));
                    }}
                  />
                </div>
              )}
            >
              {props ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                  <div>
                    <dt className="text-gray-500">Alias</dt>
                    <dd className="text-gray-100">{props.modelAlias || data.model || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Build</dt>
                    <dd className="text-gray-100">{props.buildInfo || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Context</dt>
                    <dd className="tabular-nums text-gray-100">{formatTokens(props.nCtx)}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Temperature</dt>
                    <dd className="tabular-nums text-gray-100">{formatFixed(props.temperature, 2)}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">top_p / top_k</dt>
                    <dd className="tabular-nums text-gray-100">
                      {formatFixed(props.topP, 2)} / {props.topK ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Vision</dt>
                    <dd className="text-gray-100">{props.vision || data.engine?.images ? 'on' : 'off'}</dd>
                  </div>
                  {props.modelPath ? (
                    <div className="col-span-2">
                      <dt className="text-gray-500">Weights</dt>
                      <dd className="truncate text-gray-100" title={props.modelPath}>{fileName(props.modelPath)}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="text-xs text-gray-500">Properties did not come back as JSON.</p>
              )}
            </Section>

            <Section title="Since start" source="GET /metrics" icon="activity">
              {data.totals ? (
                <dl className="grid grid-cols-2 gap-3">
                  {[
                    ['Requests', data.totals.requests],
                    ['Prompt tokens', formatTokens(data.totals.promptTokens)],
                    ['Output tokens', formatTokens(data.totals.outputTokens)],
                    ['Reused', formatTokens(data.totals.reused)],
                    ['Decode', formatFixed(decodeRate(data.totals), 1, ' tok/s')],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] text-gray-500">{label}</dt>
                      <dd className="text-lg font-semibold tabular-nums text-gray-100">{value ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-xs text-gray-500">Metrics did not include session totals.</p>
              )}
            </Section>
          </div>

          <Section
            title="Updates"
            source="GET /update · POST /update"
            icon="circle-arrow-up"
            actions={update?.supported === false ? null : (
              <div className="flex flex-wrap gap-1.5">
                <ActionButton
                  label={actionBusy === 'check' ? 'Checking…' : 'Check for updates'}
                  icon="search"
                  disabled={controlsBusy}
                  onClick={() => void runAction('check', () => postControl('/kusa/strata/update', { action: 'check' }))}
                />
                <ActionButton
                  label={actionBusy === 'install' ? 'Updating…' : 'Update and restart'}
                  icon="circle-arrow-up"
                  tone="accent"
                  disabled={controlsBusy}
                  onClick={() => {
                    if (!window.confirm('Drain inference, unload the model, run strata update, then restart the server in place? This can take several minutes.')) {
                      return;
                    }
                    void runAction('install', () => postControl('/kusa/strata/update', { action: 'install' }));
                  }}
                />
              </div>
            )}
          >
            {update?.supported === false ? (
              <p className="text-xs text-gray-400">
                {update.reason === 'not-found' || /404|not.?found/i.test(String(update.reason || ''))
                  ? 'This Strata build does not expose /update yet (self-update needs a newer server). Use `strata update` in a terminal, or upgrade Strata.'
                  : (update.reason || 'This Strata server cannot self-update from the API (for example when started via strata serve / launch, on Windows, or without strata on PATH). Run `strata update` in a terminal instead.')}
              </p>
            ) : (
              <div className="space-y-1 text-xs text-gray-400">
                <p>
                  {update?.summary
                    || 'Check the signed feed, then install and restart in place when an update is available.'}
                </p>
                {update?.busy ? (
                  <p className="text-amber-300">Update in progress — inference may return 503 while the server drains and restarts.</p>
                ) : null}
              </div>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}
