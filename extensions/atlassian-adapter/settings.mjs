/**
 * Atlassian Adapter settings — host / email / project + encrypted API token.
 *
 * Ciphertext lives in workspace `.kusa/settings.json` as `atlassian.apiTokenEnc`.
 * The AES master key is the same user-home key as agent API keys
 * (`~/.config/kusa/master.key` or `KUSA_SECRETS_KEY`).
 */

export const ATLASSIAN_SETTINGS_DEFAULTS = Object.freeze({
  host: '',
  email: '',
  apiToken: '',
  projectKey: '',
});

/**
 * @param {unknown} raw
 * @returns {{ host: string, email: string, apiToken: string, projectKey: string }}
 */
export function normalizeAtlassianSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const host = typeof src.host === 'string'
    ? src.host.trim().replace(/\/+$/, '')
    : '';
  const email = typeof src.email === 'string' ? src.email.trim() : '';
  const apiToken = typeof src.apiToken === 'string' ? src.apiToken.slice(0, 4000) : '';
  const projectKey = typeof src.projectKey === 'string'
    ? src.projectKey.trim().toUpperCase().slice(0, 32)
    : '';
  return { host, email, apiToken, projectKey };
}

/**
 * Browser-safe view: never includes apiToken / apiTokenEnc.
 * @param {unknown} raw
 */
export function publicAtlassianSettings(raw = {}) {
  const n = normalizeAtlassianSettings(raw);
  const src = raw && typeof raw === 'object' ? raw : {};
  const apiTokenSet = Boolean(
    (typeof n.apiToken === 'string' && n.apiToken.trim())
    || src.apiTokenSet === true
    || isAtlassianTokenEnvelope(src.apiTokenEnc),
  );
  return {
    host: n.host,
    email: n.email,
    projectKey: n.projectKey,
    apiTokenSet,
    configured: Boolean(n.host && n.email && apiTokenSet),
  };
}

/** @param {unknown} value */
export function isAtlassianTokenEnvelope(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && Number(value.v) === 1
    && typeof value.iv === 'string'
    && typeof value.tag === 'string'
    && typeof value.ct === 'string',
  );
}

/**
 * Merge a settings patch without clearing an omitted token.
 * Explicit empty string clears the stored token.
 * @param {object} current
 * @param {object} patch
 */
export function mergeAtlassianSettingsPatch(current = {}, patch = {}) {
  const base = normalizeAtlassianSettings(current);
  const src = patch && typeof patch === 'object' ? patch : {};
  const next = { ...base };
  if (src.host !== undefined) next.host = String(src.host ?? '');
  if (src.email !== undefined) next.email = String(src.email ?? '');
  if (src.projectKey !== undefined) next.projectKey = String(src.projectKey ?? '');
  if (src.apiToken !== undefined && src.apiToken !== null) {
    next.apiToken = String(src.apiToken);
  }
  return normalizeAtlassianSettings(next);
}
