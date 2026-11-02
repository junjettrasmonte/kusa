/**
 * Auth HTTP helpers for `kusa serve`.
 */
import { hashPassword, verifyPassword } from '#features/auth/password.mjs';
import {
  generateTotpSecret,
  totpQrDataUrl,
  totpUri,
  verifyTotp,
} from '#features/auth/totp.mjs';
import {
  clearAuthCookies,
  clearPendingCookie,
  createPendingToken,
  createSessionToken,
  readPending,
  readSession,
  setPendingCookie,
  setSessionCookie,
} from '#features/auth/session.mjs';
import {
  effectiveAuthMode,
  isAuthConfigured,
  mergeAuthPatch,
  normalizeAuth,
  publicAuthSettings,
} from '#features/auth/shape.mjs';
import { finishOidcLogin, startOidcLogin } from '#features/auth/oidc.mjs';
import {
  finishSamlLogin,
  samlSpMetadata,
  startSamlLogin,
} from '#features/auth/saml.mjs';
import {
  loadMonitorSettings,
  saveMonitorSettings,
} from '#features/monitor/lib.mjs';

/** Paths that never require a console session. */
export const AUTH_PUBLIC_PATHS = new Set([
  '/health',
  '/auth/status',
  '/auth/setup',
  '/auth/login',
  '/auth/totp',
  '/auth/logout',
  '/auth/oidc/start',
  '/auth/oidc/callback',
  '/auth/saml/metadata',
  '/auth/saml/start',
  '/auth/saml/acs',
]);

/** Static shell / PWA assets that stay reachable offline / before login. */
export const AUTH_PUBLIC_PREFIXES = [
  '/dashboard.html',
  '/dashboard.js',
  '/dashboard.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/sw.js',
  '/workbox-',
  '/icons/',
];

export function isAuthPublicPath(pathname) {
  if (AUTH_PUBLIC_PATHS.has(pathname)) return true;
  if (pathname === '/') return true;
  return AUTH_PUBLIC_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(prefix)
  ));
}

export function originFromRequest(req, port) {
  const host = req.headers.host || `127.0.0.1:${port}`;
  return `http://${host}`;
}

export function authStatusPayload(dataDir, req) {
  const settings = loadMonitorSettings(dataDir);
  const auth = normalizeAuth(settings.auth);
  const mode = effectiveAuthMode(auth);
  const session = readSession(req);
  const pending = readPending(req);
  const configured = isAuthConfigured(auth);
  return {
    ok: true,
    ...publicAuthSettings(auth),
    authenticated: Boolean(session),
    needsSetup: !configured,
    needsLogin: configured && !session && !pending,
    needsTotp: configured && mode === 'local' && Boolean(pending) && !session,
    user: session?.username || null,
  };
}

/**
 * Try to handle an auth/health route. Returns true when the request was handled.
 */
export async function handleAuthHttp(req, res, {
  url,
  dataDir,
  readBody,
  sendJson,
  mcpPort = 1424,
}) {
  if (url.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/auth/status' && (req.method === 'GET' || req.method === 'HEAD')) {
    sendJson(res, 200, authStatusPayload(dataDir, req));
    return true;
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    clearAuthCookies(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/auth/setup' && req.method === 'POST') {
    const settings = loadMonitorSettings(dataDir);
    if (isAuthConfigured(settings.auth)) {
      sendJson(res, 409, { error: 'auth already configured' });
      return true;
    }
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid json body' });
      return true;
    }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const totpCode = String(body.totpCode || body.code || '').trim();
    const totpSecret = String(body.totpSecret || '').replace(/\s+/g, '');

    if (!username || password.length < 8) {
      sendJson(res, 400, { error: 'username and password (min 8 chars) required' });
      return true;
    }

    // Phase 1: create enrollment — return QR + secret; no persist yet.
    if (!totpSecret || !totpCode) {
      const secret = generateTotpSecret();
      const uri = totpUri({ secret, username });
      const qrDataUrl = await totpQrDataUrl({ secret, username });
      sendJson(res, 200, {
        ok: true,
        phase: 'enroll',
        totpSecret: secret,
        otpauthUrl: uri,
        qrDataUrl,
      });
      return true;
    }

    if (!verifyTotp(totpSecret, totpCode)) {
      sendJson(res, 401, { error: 'invalid TOTP code' });
      return true;
    }

    const auth = mergeAuthPatch(settings.auth, {
      mode: 'local',
      local: {
        username,
        passwordHash: hashPassword(password),
        totpSecret,
      },
    });
    saveMonitorSettings(dataDir, { auth });
    const token = createSessionToken({ username, mode: 'local' });
    setSessionCookie(res, token);
    clearPendingCookie(res);
    sendJson(res, 200, { ok: true, phase: 'done', user: username });
    return true;
  }

  if (url.pathname === '/auth/login' && req.method === 'POST') {
    const settings = loadMonitorSettings(dataDir);
    const auth = normalizeAuth(settings.auth);
    if (!isAuthConfigured(auth)) {
      sendJson(res, 409, { error: 'auth not configured' });
      return true;
    }
    if (effectiveAuthMode(auth) !== 'local') {
      sendJson(res, 400, { error: `use SSO for mode ${effectiveAuthMode(auth)}` });
      return true;
    }
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid json body' });
      return true;
    }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (
      username !== auth.local.username
      || !verifyPassword(password, auth.local.passwordHash)
    ) {
      sendJson(res, 401, { error: 'invalid username or password' });
      return true;
    }
    const pending = createPendingToken({ username });
    setPendingCookie(res, pending);
    sendJson(res, 200, { ok: true, needsTotp: true });
    return true;
  }

  if (url.pathname === '/auth/totp' && req.method === 'POST') {
    const settings = loadMonitorSettings(dataDir);
    const auth = normalizeAuth(settings.auth);
    const pending = readPending(req);
    if (!pending) {
      sendJson(res, 401, { error: 'login first' });
      return true;
    }
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid json body' });
      return true;
    }
    const code = String(body.code || body.totpCode || '').trim();
    if (
      pending.username !== auth.local.username
      || !verifyTotp(auth.local.totpSecret, code)
    ) {
      sendJson(res, 401, { error: 'invalid TOTP code' });
      return true;
    }
    const token = createSessionToken({ username: pending.username, mode: 'local' });
    setSessionCookie(res, token);
    clearPendingCookie(res);
    sendJson(res, 200, { ok: true, user: pending.username });
    return true;
  }

  if (url.pathname === '/auth/oidc/start' && (req.method === 'GET' || req.method === 'HEAD')) {
    const settings = loadMonitorSettings(dataDir);
    const auth = normalizeAuth(settings.auth);
    if (effectiveAuthMode(auth) !== 'oidc' || !isAuthConfigured(auth)) {
      sendJson(res, 409, { error: 'OIDC is not the active auth mode or is incomplete' });
      return true;
    }
    try {
      const redirectUri = `${originFromRequest(req, mcpPort)}/auth/oidc/callback`;
      const { url: redirect } = await startOidcLogin(auth, { redirectUri });
      res.writeHead(302, { Location: redirect }).end();
    } catch (err) {
      sendJson(res, 500, { error: err?.message || 'OIDC start failed' });
    }
    return true;
  }

  if (url.pathname === '/auth/oidc/callback' && (req.method === 'GET' || req.method === 'HEAD')) {
    const settings = loadMonitorSettings(dataDir);
    const auth = normalizeAuth(settings.auth);
    try {
      const origin = originFromRequest(req, mcpPort);
      const redirectUri = `${origin}/auth/oidc/callback`;
      const { username } = await finishOidcLogin(auth, {
        redirectUri,
        callbackUrl: `${origin}${url.pathname}${url.search}`,
      });
      const token = createSessionToken({ username, mode: 'oidc' });
      setSessionCookie(res, token);
      clearPendingCookie(res);
      res.writeHead(302, { Location: '/dashboard.html' }).end();
    } catch (err) {
      sendJson(res, 401, { error: err?.message || 'OIDC callback failed' });
    }
    return true;
  }

  if (url.pathname === '/auth/saml/metadata' && (req.method === 'GET' || req.method === 'HEAD')) {
    const settings = loadMonitorSettings(dataDir);
    const auth = normalizeAuth(settings.auth);
    const origin = originFromRequest(req, mcpPort);
    const xml = samlSpMetadata({
      entityId: auth.saml.entityId || `${origin}/auth/saml/metadata`,
      callbackUrl: `${origin}/auth/saml/acs`,
    });
    const body = Buffer.from(xml, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/samlmetadata+xml; charset=utf-8',
      'Content-Length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  if (url.pathname === '/auth/saml/start' && (req.method === 'GET' || req.method === 'HEAD')) {
    const settings = loadMonitorSettings(dataDir);
    const auth = normalizeAuth(settings.auth);
    if (effectiveAuthMode(auth) !== 'saml' || !isAuthConfigured(auth)) {
      sendJson(res, 409, { error: 'SAML is not the active auth mode or is incomplete' });
      return true;
    }
    try {
      const origin = originFromRequest(req, mcpPort);
      const { url: redirect } = await startSamlLogin(auth, {
        callbackUrl: `${origin}/auth/saml/acs`,
        issuer: auth.saml.entityId || `${origin}/auth/saml/metadata`,
      });
      res.writeHead(302, { Location: redirect }).end();
    } catch (err) {
      sendJson(res, 500, { error: err?.message || 'SAML start failed' });
    }
    return true;
  }

  if (url.pathname === '/auth/saml/acs' && req.method === 'POST') {
    const settings = loadMonitorSettings(dataDir);
    const auth = normalizeAuth(settings.auth);
    try {
      const raw = await readBody(req, 200_000);
      const params = Object.fromEntries(new URLSearchParams(raw));
      const origin = originFromRequest(req, mcpPort);
      const { username } = await finishSamlLogin(auth, {
        callbackUrl: `${origin}/auth/saml/acs`,
        issuer: auth.saml.entityId || `${origin}/auth/saml/metadata`,
        body: params,
      });
      const token = createSessionToken({ username, mode: 'saml' });
      setSessionCookie(res, token);
      clearPendingCookie(res);
      res.writeHead(302, { Location: '/dashboard.html' }).end();
    } catch (err) {
      sendJson(res, 401, { error: err?.message || 'SAML ACS failed' });
    }
    return true;
  }

  return false;
}

/**
 * Console login is enforced by AuthGate in the browser, not by 401-ing the
 * localhost HTTP API. Cursor/Copilot hooks write session files on disk; the
 * dashboard polls `/monitor-data.js` and related read paths every second — a
 * session cookie gate on those routes freezes live Cursor/Copilot streams.
 * MCP keeps its own bearer on `/mcp/.../rpc`.
 *
 * Returns true if the response was already sent (401). Currently always false.
 */
export function enforceAuthGate(_req, _res, _ctx) {
  return false;
}
