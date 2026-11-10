/**
 * Strata (and llama.cpp-compatible) discovery helpers.
 *
 * OpenAI chat lives under `/v1`, but Strata's meter endpoints sit on the server
 * root: `/health`, `/props`, `/slots`, `/status`, `/metrics`. Clients read the
 * context ring as `n_prompt_tokens / n_ctx` from `GET /slots`.
 *
 * Once `detectStrata` confirms the host, `probeStrataMonitor` reads the four
 * monitor endpoints and returns a view the Dev Tools page can draw. Raw bodies
 * stay on the server: prompt tails and chat templates are not forwarded.
 *
 * Control actions (load / unload / self-update) are also proxied from here so
 * the browser never hits Strata with a foreign Origin — Strata only accepts
 * those POSTs as JSON without a page Origin (or from its own page).
 *
 * @see https://github.com/Niko1221/Strata/blob/main/docs/DETAILS.md
 */

const PROBE_TIMEOUT_MS = 5_000;
const CONTROL_TIMEOUT_MS = 120_000;
const UNLOAD_WAIT_TIMEOUT_MS = 310_000;
const UPDATE_INSTALL_TIMEOUT_MS = 600_000;
const DETECT_TTL_MS = 60_000;

/** @type {Map<string, { at: number, ok: boolean, maxContext: number|null, model: string }>} */
const detectCache = new Map();

/**
 * OpenAI-compatible base URLs end in `/v1`; Strata discovery is one level up.
 * @param {string} baseUrl
 * @returns {string}
 */
export function strataRootFromBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/\/v1$/i, '');
}

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, json: any }>}
 */
async function fetchJson(url, headers = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { ...headers, Accept: 'application/json' },
      signal: controller.signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, raw };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      raw: '',
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'unreachable'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST JSON to a Strata control route. Always sends `Content-Type: application/json`
 * (required even for an empty body) and never an Origin header.
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @param {unknown} [body]
 * @param {number} [timeoutMs]
 */
async function postJson(url, headers = {}, body = {}, timeoutMs = CONTROL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, raw };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      raw: '',
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'unreachable'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirm the root looks like Strata (or a llama.cpp meter host).
 * Prefers `/health.service === "strata"`; falls back to `/props` + `/slots`
 * shapes when health omits the service field.
 * @param {string} root
 * @param {Record<string, string>} [headers]
 * @param {{ force?: boolean }} [opts]
 */
export async function detectStrata(root, headers = {}, opts = {}) {
  const key = String(root || '').trim();
  if (!key) return { ok: false, maxContext: null, model: '' };
  const now = Date.now();
  if (!opts.force) {
    const hit = detectCache.get(key);
    if (hit && (now - hit.at) < DETECT_TTL_MS) {
      return { ok: hit.ok, maxContext: hit.maxContext, model: hit.model };
    }
  }

  const health = await fetchJson(`${key}/health`, headers);
  if (health.ok && health.json && typeof health.json === 'object') {
    const service = String(health.json.service || '').trim().toLowerCase();
    if (service === 'strata') {
      const maxContext = Number(health.json.max_context);
      const model = String(health.json.model || '').trim();
      const result = {
        ok: true,
        maxContext: Number.isFinite(maxContext) && maxContext > 0 ? Math.round(maxContext) : null,
        model,
      };
      detectCache.set(key, { at: now, ...result });
      return result;
    }
  }

  // Fallback fingerprint: the four discovery endpoints the user listed. Props
  // must expose a context window; slots must be a (possibly empty) array.
  const [props, slots] = await Promise.all([
    fetchJson(`${key}/props`, headers),
    fetchJson(`${key}/slots`, headers),
  ]);
  const nCtx = Number(
    props.json?.default_generation_settings?.n_ctx
    ?? props.json?.n_ctx
    ?? 0,
  );
  const slotsOk = slots.ok && Array.isArray(slots.json);
  const propsOk = props.ok && Number.isFinite(nCtx) && nCtx > 0;
  const result = propsOk && slotsOk
    ? {
      ok: true,
      maxContext: Math.round(nCtx),
      model: String(props.json?.model_alias || '').trim(),
    }
    : { ok: false, maxContext: null, model: '' };
  detectCache.set(key, { at: now, ...result });
  return result;
}

/**
 * Live context usage from `GET /slots` (`n_prompt_tokens` / `n_ctx`).
 * @param {string} root
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ used: number, limit: number, processing: boolean }|null>}
 */
export async function readStrataSlots(root, headers = {}) {
  const key = String(root || '').trim();
  if (!key) return null;
  const slots = await fetchJson(`${key}/slots`, headers);
  if (!slots.ok || !Array.isArray(slots.json) || !slots.json.length) return null;
  const preferred = slots.json.find((slot) => slot && slot.is_processing)
    || slots.json[0];
  if (!preferred || typeof preferred !== 'object') return null;
  const used = Number(preferred.n_prompt_tokens);
  const limit = Number(preferred.n_ctx);
  if (!Number.isFinite(used) || used < 0) return null;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return {
    used: Math.round(used),
    limit: Math.round(limit),
    processing: preferred.is_processing === true,
  };
}

/**
 * Resolve whether an OpenAI-compatible endpoint is Strata and, if so, return
 * the live context meter. Non-Strata endpoints yield `{ strata: false }`.
 * @param {string} baseUrl
 * @param {Record<string, string>} [headers]
 */
export async function readStrataContext(baseUrl, headers = {}) {
  const root = strataRootFromBaseUrl(baseUrl);
  if (!root) return { strata: false };
  const detected = await detectStrata(root, headers);
  if (!detected.ok) return { strata: false };

  const usage = await readStrataSlots(root, headers);
  if (usage) {
    return {
      strata: true,
      used: usage.used,
      limit: usage.limit,
      processing: usage.processing,
      model: detected.model,
    };
  }

  // Confirmed Strata but slots empty (engine down / unloaded) — still report
  // the configured window so the ring limit is real; leave used unset so the
  // UI can fall back to its local estimate.
  return {
    strata: true,
    used: null,
    limit: detected.maxContext,
    processing: false,
    model: detected.model,
  };
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{ ok: boolean, status: number, json: any }} result
 * @param {'object'|'array'} expect
 */
function probeMeta(result, expect) {
  const parsed = expect === 'array'
    ? Array.isArray(result.json)
    : Boolean(result.json) && typeof result.json === 'object' && !Array.isArray(result.json);
  let error = null;
  if (!result.ok) error = result.status ? `http-${result.status}` : 'unreachable';
  else if (!parsed) error = 'not-json';
  return { ok: result.ok && parsed, status: result.status, error };
}

/**
 * @param {unknown} values
 * @returns {Array<number|null>}
 */
function series(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(-60).map((value) => num(value));
}

/**
 * @param {any} metrics
 * @param {any} status
 */
function liveFrom(metrics, status) {
  const live = metrics && typeof metrics === 'object' && !Array.isArray(metrics)
    && metrics.live && typeof metrics.live === 'object'
    ? metrics.live
    : null;
  const st = status && typeof status === 'object' && !Array.isArray(status) ? status : null;
  const phaseText = String(live?.phase ?? (st?.busy ? st.phase : '') ?? '').trim();
  let state = live?.state ? String(live.state) : '';
  if (!state && st) {
    if (st.busy) state = /read/i.test(phaseText) ? 'reading' : 'generating';
    else state = 'idle';
  }
  return {
    state: state || null,
    busy: live
      ? live.state === 'reading' || live.state === 'generating'
      : st?.busy === true,
    queued: num(live?.queued ?? st?.queued) ?? 0,
    phase: phaseText || null,
    promptTokens: num(live?.prompt_tokens ?? st?.prompt_tokens),
    promptRead: num(live?.prompt_read),
    promptTotal: num(live?.prompt_total),
    generated: num(live?.generated ?? st?.generated),
    maxTokens: num(live?.max_tokens ?? st?.max_tokens),
    elapsedS: num(live?.elapsed_s ?? st?.elapsed_s),
    tokS: num(live?.tok_s ?? st?.tokens_per_s),
    prefillTokS: num(live?.prefill_tok_s_mean),
  };
}

/**
 * @param {any} json
 * @returns {Array<{ id: number, nCtx: number|null, used: number|null, processing: boolean }>}
 */
function slotsFrom(json) {
  if (!Array.isArray(json)) return [];
  return json.slice(0, 16).map((slot, index) => ({
    id: num(slot?.id) ?? index,
    nCtx: num(slot?.n_ctx),
    used: num(slot?.n_prompt_tokens),
    processing: slot?.is_processing === true,
    state: null,
    generated: null,
    tokS: null,
  }));
}

/**
 * `/metrics` live slots carry reading/decoding and tok/s. Attach those to the
 * `/slots` rows (the prompt-token meter) when the ids match.
 * @param {ReturnType<typeof slotsFrom>} rows
 * @param {any} metrics
 */
function mergeSlotActivity(rows, metrics) {
  const live = Array.isArray(metrics?.live?.slots) ? metrics.live.slots : [];
  if (!live.length) return rows;
  const byId = new Map();
  for (const row of live) {
    const id = num(row?.slot);
    if (id != null) byId.set(id, row);
  }
  return rows.map((slot) => {
    const extra = byId.get(slot.id);
    if (!extra) return slot;
    const state = String(extra.state || '').trim();
    return {
      ...slot,
      state: state || null,
      generated: num(extra.generated),
      tokS: num(extra.tok_s),
      processing: slot.processing || (state !== '' && state !== 'idle'),
    };
  });
}

/**
 * @param {any} json
 */
function propsFrom(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const settings = json.default_generation_settings
    && typeof json.default_generation_settings === 'object'
    ? json.default_generation_settings
    : {};
  const nested = settings.params && typeof settings.params === 'object' ? settings.params : {};
  const params = { ...nested };
  for (const key of ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'n_predict']) {
    if (params[key] == null && settings[key] != null) params[key] = settings[key];
  }
  return {
    nCtx: num(settings.n_ctx ?? json.n_ctx),
    totalSlots: num(json.total_slots),
    modelAlias: String(json.model_alias || '').trim(),
    modelPath: String(json.model_path || '').trim(),
    buildInfo: String(json.build_info || '').trim(),
    vision: json.modalities?.vision === true,
    sleeping: json.is_sleeping === true,
    temperature: num(params.temperature),
    topP: num(params.top_p),
    topK: num(params.top_k),
    minP: num(params.min_p),
    repeatPenalty: num(params.repeat_penalty ?? params.repetition_penalty),
    nPredict: num(params.n_predict),
  };
}

/**
 * @param {any} metrics
 */
function hardwareFrom(metrics) {
  const now = metrics?.hardware && typeof metrics.hardware === 'object' ? metrics.hardware : {};
  const stat = metrics?.hardware_static && typeof metrics.hardware_static === 'object'
    ? metrics.hardware_static
    : {};
  const hist = metrics?.history && typeof metrics.history === 'object' ? metrics.history : {};
  const gpus = Array.isArray(now.gpus)
    ? now.gpus.slice(0, 8).map((gpu, index) => ({
      index: num(gpu?.index) ?? index,
      name: String(gpu?.name || '').trim(),
      util: num(gpu?.util),
      memUsed: num(gpu?.mem_used),
      memTotal: num(gpu?.mem_total),
      temp: num(gpu?.temp),
      power: num(gpu?.power),
    }))
    : [];
  return {
    gpuName: String(stat.gpu_name || gpus[0]?.name || '').trim(),
    cpuName: String(stat.cpu_name || '').trim(),
    gpuNote: String(stat.gpu_note || '').trim(),
    gpuUtil: num(now.gpu_util),
    gpuMemUsed: num(now.gpu_mem_used),
    gpuMemTotal: num(now.gpu_mem_total),
    gpuTemp: num(now.gpu_temp),
    gpuPower: num(now.gpu_power),
    gpuPowerLimit: num(now.gpu_power_limit),
    cpu: num(now.cpu),
    ramUsed: num(now.ram_used),
    ramTotal: num(now.ram_total),
    gpus,
    history: {
      gpuUtil: series(hist.gpu_util),
      gpuMemUsed: series(hist.gpu_mem_used),
      gpuPower: series(hist.gpu_power),
      cpu: series(hist.cpu),
      ramUsed: series(hist.ram_used),
      tokS: series(hist.tok_s),
    },
  };
}

/**
 * @param {any} metrics
 */
function totalsFrom(metrics) {
  const raw = metrics?.totals && typeof metrics.totals === 'object' ? metrics.totals : null;
  if (!raw) return null;
  return {
    requests: num(raw.requests),
    promptTokens: num(raw.prompt_tokens),
    outputTokens: num(raw.output_tokens),
    reused: num(raw.reused),
    promptMs: num(raw.prompt_ms),
    decodeMs: num(raw.decode_ms),
  };
}

/**
 * @param {any} metrics
 */
function requestsFrom(metrics) {
  if (!Array.isArray(metrics?.requests)) return [];
  return metrics.requests.slice(0, 8).map((row) => ({
    finish: String(row?.finish || '').trim(),
    promptTokens: num(row?.prompt_tokens),
    outputTokens: num(row?.output_tokens),
    decodeTokS: num(row?.decode_tok_s),
    durationS: num(row?.duration_s),
  }));
}

/**
 * Normalize `GET /update` / `POST /update` payloads into a small view the
 * Dev Tools card can draw. Unknown shapes still surface a reason/summary.
 * @param {any} json
 * @param {{ ok?: boolean, status?: number, error?: string }} [meta]
 */
function updateReasonText(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    return String(value.message || value.reason || value.detail || '').trim();
  }
  return String(value).trim();
}

function updateFrom(json, meta = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    const status = Number(meta.status) || 0;
    let reason = updateReasonText(meta.error);
    if (!reason && status === 404) reason = 'not-found';
    else if (!reason && status) reason = `HTTP ${status}`;
    else if (!reason) reason = 'Update endpoint unavailable';
    return {
      supported: false,
      available: false,
      reason,
      state: null,
      busy: false,
      summary: null,
      check: null,
    };
  }
  const reason = updateReasonText(
    json.reason || json.unsupported_reason
    || (json.unsupported === true ? 'unsupported' : null)
    || json.error,
  ) || null;
  const supported = json.supported === true
    || json.can_update === true
    || (json.supported !== false && json.can_update !== false && !reason && meta.ok !== false);
  const state = String(json.state || json.phase || '').trim() || null;
  const busy = json.busy === true
    || json.checking === true
    || json.installing === true
    || /^(check|install|drain|restart|updat)/i.test(state || '');
  const check = json.check || json.last_check || json.result || json.report || null;
  let summary = updateReasonText(json.summary || json.detail || json.message) || null;
  if (!summary && check && typeof check === 'object') {
    const parts = [];
    for (const key of ['engine', 'control', 'app', 'terminal']) {
      const row = check[key];
      if (!row || typeof row !== 'object') continue;
      const from = row.installed || row.current || row.from || '';
      const to = row.offered?.version || row.offered || row.latest || row.to || '';
      const status = String(row.status || '').trim();
      if (from && to && String(from) !== String(to)) parts.push(`${key}: ${from} → ${to}`);
      else if (status && status !== 'current' && status !== 'up-to-date') parts.push(`${key}: ${status}`);
    }
    if (Array.isArray(check.results)) {
      for (const row of check.results) {
        if (!row || typeof row !== 'object') continue;
        const name = String(row.component || row.name || '').trim() || 'component';
        const status = String(row.status || '').trim();
        if (status) parts.push(`${name}: ${status}`);
      }
    }
    if (parts.length) summary = parts.join(' · ');
  }
  return {
    supported,
    available: supported,
    reason,
    state,
    busy,
    summary,
    check,
  };
}

/**
 * Resolve loaded / sleeping from health + props + live state.
 * @param {any} health
 * @param {ReturnType<typeof propsFrom>} props
 * @param {ReturnType<typeof liveFrom>} live
 */
function loadedFrom(health, props, live) {
  if (health && typeof health === 'object') {
    if (health.loaded === true) return true;
    if (health.loaded === false) return false;
  }
  if (props?.sleeping === true) return false;
  if (live?.state === 'unloaded') return false;
  if (live?.state) return true;
  return null;
}

/**
 * After the Kusă endpoint is confirmed as Strata, read the monitor endpoints
 * and return a drawing-ready snapshot. A non-Strata host returns
 * `{ strata: false }` and does not call `/metrics` or `/status`.
 * @param {string} baseUrl OpenAI-compatible base URL (`…/v1` is stripped)
 * @param {Record<string, string>} [headers]
 * @param {{ force?: boolean }} [opts]
 */
export async function probeStrataMonitor(baseUrl, headers = {}, opts = {}) {
  const root = strataRootFromBaseUrl(baseUrl);
  if (!root) return { strata: false, root: '', checkedAt: Date.now() };
  const detected = await detectStrata(root, headers, { force: opts.force === true });
  if (!detected.ok) return { strata: false, root, checkedAt: Date.now() };

  const [metricsRes, statusRes, slotsRes, propsRes, healthRes, updateRes] = await Promise.all([
    fetchJson(`${root}/metrics`, headers),
    fetchJson(`${root}/status`, headers),
    fetchJson(`${root}/slots`, headers),
    fetchJson(`${root}/props`, headers),
    fetchJson(`${root}/health`, headers),
    fetchJson(`${root}/update`, headers),
  ]);
  const metrics = metricsRes.ok && metricsRes.json && typeof metricsRes.json === 'object'
    && !Array.isArray(metricsRes.json)
    ? metricsRes.json
    : null;
  const status = statusRes.ok && statusRes.json && typeof statusRes.json === 'object'
    && !Array.isArray(statusRes.json)
    ? statusRes.json
    : null;
  const health = healthRes.ok && healthRes.json && typeof healthRes.json === 'object'
    && !Array.isArray(healthRes.json)
    ? healthRes.json
    : null;
  const props = propsFrom(propsRes.ok ? propsRes.json : null);
  const live = liveFrom(metrics, status);
  const engine = metrics?.engine && typeof metrics.engine === 'object'
    ? {
      model: String(metrics.engine.model || '').trim(),
      maxContext: num(metrics.engine.max_context),
      images: metrics.engine.images === true,
    }
    : null;
  const model = props?.modelAlias || engine?.model || detected.model || '';
  const maxContext = props?.nCtx ?? engine?.maxContext ?? detected.maxContext ?? null;
  const loaded = loadedFrom(health, props, live);

  return {
    strata: true,
    root,
    model,
    maxContext,
    loaded,
    checkedAt: Date.now(),
    probes: {
      metrics: probeMeta(metricsRes, 'object'),
      status: probeMeta(statusRes, 'object'),
      slots: probeMeta(slotsRes, 'array'),
      props: probeMeta(propsRes, 'object'),
      update: updateRes.ok
        ? probeMeta(updateRes, 'object')
        : { ok: false, status: updateRes.status, error: updateRes.error || (updateRes.status ? `http-${updateRes.status}` : 'unreachable') },
    },
    live,
    slots: mergeSlotActivity(slotsFrom(slotsRes.ok ? slotsRes.json : null), metrics),
    props,
    hardware: hardwareFrom(metrics),
    totals: totalsFrom(metrics),
    engine,
    requests: requestsFrom(metrics),
    update: updateFrom(updateRes.ok ? updateRes.json : null, updateRes),
  };
}

/**
 * Shared confirm + error packaging for control POSTs.
 * @param {string} baseUrl
 * @param {Record<string, string>} headers
 * @param {() => Promise<{ ok: boolean, status: number, json: any, raw?: string, error?: string }>} run
 */
async function withStrataControl(baseUrl, headers, run) {
  const root = strataRootFromBaseUrl(baseUrl);
  if (!root) return { ok: false, strata: false, error: 'no-endpoint' };
  const detected = await detectStrata(root, headers, { force: true });
  if (!detected.ok) return { ok: false, strata: false, root, error: 'not-strata' };
  const result = await run(root);
  const message = result.json && typeof result.json === 'object'
    ? String(result.json.error || result.json.message || result.json.detail || '').trim()
    : '';
  return {
    ok: result.ok,
    strata: true,
    root,
    status: result.status,
    error: result.ok ? null : (result.error || message || (result.status ? `HTTP ${result.status}` : 'failed')),
    body: result.json,
  };
}

/**
 * `POST /load` — load the model ahead of a request (JSON, API key).
 * @param {string} baseUrl
 * @param {Record<string, string>} [headers]
 * @param {{ model?: string }} [opts]
 */
export async function strataLoadModel(baseUrl, headers = {}, opts = {}) {
  const model = String(opts.model || '').trim();
  return withStrataControl(baseUrl, headers, (root) => postJson(
    `${root}/load`,
    headers,
    model ? { model } : {},
    CONTROL_TIMEOUT_MS,
  ));
}

/**
 * `POST /unload` — free the GPU. Pass `wait: true` to wait out a running turn
 * (`?wait=1`, up to ~300 s per Strata docs).
 * @param {string} baseUrl
 * @param {Record<string, string>} [headers]
 * @param {{ wait?: boolean, model?: string }} [opts]
 */
export async function strataUnloadModel(baseUrl, headers = {}, opts = {}) {
  const model = String(opts.model || '').trim();
  const wait = opts.wait === true;
  const path = wait ? '/unload?wait=1' : '/unload';
  return withStrataControl(baseUrl, headers, (root) => postJson(
    `${root}${path}`,
    headers,
    model ? { model } : {},
    wait ? UNLOAD_WAIT_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
  ));
}

/**
 * `GET /update` — self-update card state (supported / reason / last check).
 * @param {string} baseUrl
 * @param {Record<string, string>} [headers]
 */
export async function strataReadUpdate(baseUrl, headers = {}) {
  const root = strataRootFromBaseUrl(baseUrl);
  if (!root) return { ok: false, strata: false, error: 'no-endpoint', update: null };
  const detected = await detectStrata(root, headers);
  if (!detected.ok) return { ok: false, strata: false, root, error: 'not-strata', update: null };
  const result = await fetchJson(`${root}/update`, headers, CONTROL_TIMEOUT_MS);
  return {
    ok: result.ok,
    strata: true,
    root,
    status: result.status,
    error: result.ok ? null : (result.error || (result.status ? `HTTP ${result.status}` : 'failed')),
    update: updateFrom(result.ok ? result.json : null, result),
    body: result.json,
  };
}

/**
 * `POST /update` with `{ action: "check" | "install" }` — Strata self-update.
 * @param {string} baseUrl
 * @param {Record<string, string>} [headers]
 * @param {{ action: 'check'|'install' }} opts
 */
export async function strataSelfUpdate(baseUrl, headers = {}, opts = {}) {
  const action = opts.action === 'install' ? 'install' : 'check';
  const timeoutMs = action === 'install' ? UPDATE_INSTALL_TIMEOUT_MS : CONTROL_TIMEOUT_MS;
  const result = await withStrataControl(baseUrl, headers, (root) => postJson(
    `${root}/update`,
    headers,
    { action },
    timeoutMs,
  ));
  return {
    ...result,
    action,
    update: updateFrom(result.body, { ok: result.ok, status: result.status, error: result.error }),
  };
}

/** Test helper — drop the detect cache between cases. */
export function clearStrataDetectCache() {
  detectCache.clear();
}
