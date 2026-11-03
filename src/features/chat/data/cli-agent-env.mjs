/**
 * Environment for spawning external provider CLIs (Cursor, Copilot, …)
 * from kusa serve.
 *
 * Corporate/WSL shells often set HTTP(S)_PROXY. Cursor Agent then routes
 * api2.cursor.sh through that proxy and fails with:
 *   Error: [internal] unable to get local issuer certificate
 * Direct connect (proxy stripped) verifies fine against the system CA bundle.
 * Strip proxy vars for these agent CLIs; keep everything else (incl. auth).
 */

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'ftp_proxy',
  'FTP_PROXY',
];

export const CURSOR_TLS_CERT_RE =
  /unable to get local issuer certificate|UNABLE_TO_GET_ISSUER_CERT|self[- ]signed certificate in certificate chain/i;

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function cliAgentEnv(base = process.env) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...base };
  for (const key of PROXY_ENV_KEYS) {
    if (key in env) delete env[key];
  }
  // Prefer the OS trust store when Node is the runtime under the CLI.
  if (!env.NODE_EXTRA_CA_CERTS && !env.SSL_CERT_FILE) {
    // Debian/Ubuntu / WSL default bundle — harmless if missing; CLI ignores ENOENT.
    env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';
  }
  return env;
}

/**
 * @param {unknown} textOrErr
 */
export function looksLikeCliTlsCertError(textOrErr) {
  if (textOrErr == null) return false;
  if (typeof textOrErr === 'object' && (
    textOrErr.code === 'ECURSOR_TLS' || textOrErr.code === 'ECLI_TLS'
  )) return true;
  return CURSOR_TLS_CERT_RE.test(String(
    typeof textOrErr === 'object'
      ? (textOrErr.message || textOrErr.text || textOrErr.stderr || textOrErr)
      : textOrErr,
  ));
}

/** @deprecated use looksLikeCliTlsCertError */
export const looksLikeCursorTlsCertError = looksLikeCliTlsCertError;
