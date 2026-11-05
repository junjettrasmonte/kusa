/**
 * Strata (and llama.cpp-compatible) discovery helpers.
 *
 * OpenAI chat lives under `/v1`, but Strata's meter endpoints sit on the server
 * root: `/health`, `/props`, `/slots`, `/status`, `/metrics`. Clients read the
 * context ring as `n_prompt_tokens / n_ctx` from `GET /slots`.
 */

const PROBE_TIMEOUT_MS = 5_000;
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
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
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

/** Test helper — drop the detect cache between cases. */
export function clearStrataDetectCache() {
  detectCache.clear();
}
