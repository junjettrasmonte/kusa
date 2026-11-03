/**
 * Same-origin bundled voice models under /voice-models/.
 * Rewrites Hugging Face resolve URLs so transformers.js / kokoro-js never
 * need network when weights are predownloaded.
 */

export const VOICE_MODELS_ROOT = '/voice-models/';

export const BUNDLED_WHISPER_ID = 'onnx-community/whisper-tiny.en';
export const BUNDLED_KOKORO_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/**
 * Map HF hub resolve URLs onto local /voice-models/ paths.
 * @param {string} url
 * @returns {string|null}
 */
export function rewriteHuggingFaceUrl(url) {
  const raw = String(url || '');
  // https://huggingface.co/<org>/<repo>/resolve/<rev>/<path>
  const m = raw.match(
    /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/?#]+\/([^?#]+)(?:[?#].*)?$/i,
  );
  if (!m) return null;
  return `${VOICE_MODELS_ROOT}${m[1]}/${m[2]}`;
}

/**
 * True when a Response is real model bytes — not the SPA HTML shell.
 * Vite's history fallback returns 200 + text/html for missing /voice-models/* paths.
 * @param {Response} res
 * @param {string} [peek]
 */
export function isNonHtmlAssetResponse(res, peek = '') {
  if (!res || !res.ok) return false;
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return false;
  const start = String(peek || '').trimStart().slice(0, 16).toLowerCase();
  if (start.startsWith('<!doctype') || start.startsWith('<html')) return false;
  return true;
}

/**
 * Install a one-shot fetch wrapper that serves bundled models from same origin.
 * Safe to call multiple times. Rejects SPA HTML fallbacks as 404 so transformers
 * does not try to JSON.parse `<!doctype html>`.
 */
export function installVoiceModelFetchRewrite() {
  if (typeof globalThis.fetch !== 'function') return;
  if (globalThis.__kusaVoiceFetchPatched) return;

  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    let url = '';
    try {
      url = typeof input === 'string'
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
    } catch { /* ignore */ }

    const rewritten = rewriteHuggingFaceUrl(url);
    const target = rewritten || url;
    const isVoicePath = typeof target === 'string'
      && (target.startsWith(VOICE_MODELS_ROOT) || target.includes('/voice-models/'));

    const res = rewritten
      ? await orig(rewritten, init || undefined)
      : await orig(input, init);

    if (!isVoicePath) return res;

    // Clone + peek so SPA HTML is never treated as model JSON/onnx.
    try {
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) return res;
      if (ct.includes('text/html')) {
        return new Response('Voice model not bundled', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      // JSON configs: verify body is not the index.html shell.
      if (ct.includes('json') || /\.json(\?|$)/i.test(target)) {
        const text = await res.clone().text();
        if (!isNonHtmlAssetResponse(res, text)) {
          return new Response('Voice model not bundled', {
            status: 404,
            statusText: 'Not Found',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      }
    } catch { /* return original */ }
    return res;
  };
  globalThis.__kusaVoiceFetchPatched = true;
}

/**
 * Configure @huggingface/transformers env for bundled models.
 * @param {any} env  transformers `env` export
 * @param {{ offlineOnly?: boolean }} [opts]
 */
export function configureTransformersLocalEnv(env, opts = {}) {
  installVoiceModelFetchRewrite();
  env.allowLocalModels = true;
  env.localModelPath = VOICE_MODELS_ROOT;
  env.useBrowserCache = true;
  // Prefer local; still allow remote only when not offline-only (rewrite catches HF).
  env.allowRemoteModels = opts.offlineOnly !== true;
}

/**
 * HEAD/GET check that a bundled model tree is present (rejects SPA HTML).
 * @param {string} modelId  e.g. onnx-community/whisper-tiny.en
 * @param {string} [probeFile]
 * @returns {Promise<boolean>}
 */
export async function isBundledModelAvailable(modelId, probeFile = 'config.json') {
  const url = `${VOICE_MODELS_ROOT}${modelId}/${probeFile}`;
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-cache' });
    if (!res.ok) return false;
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) return false;
    // Peek without holding the whole onnx in memory when possible.
    if (ct.includes('json') || probeFile.endsWith('.json')) {
      const text = await res.text();
      return isNonHtmlAssetResponse(res, text);
    }
    // Binary: content-type from Vite is often application/octet-stream / wasm.
    return isNonHtmlAssetResponse(res);
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ ok: boolean, whisper: boolean, kokoro: boolean, silero: boolean, manifest: object|null }>}
 */
export async function probeBundledVoiceModels() {
  let manifest = null;
  try {
    const res = await fetch(`${VOICE_MODELS_ROOT}MANIFEST.json`, { cache: 'no-cache' });
    if (res.ok) {
      const text = await res.text();
      if (isNonHtmlAssetResponse(res, text)) {
        manifest = JSON.parse(text);
      }
    }
  } catch { /* ignore */ }

  const [whisper, kokoro, silero] = await Promise.all([
    isBundledModelAvailable(BUNDLED_WHISPER_ID, 'config.json'),
    isBundledModelAvailable(BUNDLED_KOKORO_ID, 'onnx/model_quantized.onnx'),
    isBundledModelAvailable('silero', 'silero_vad_v5.onnx'),
  ]);

  return {
    ok: whisper && kokoro && silero,
    whisper,
    kokoro,
    silero,
    manifest,
  };
}
