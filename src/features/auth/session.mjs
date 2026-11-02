/**
 * Signed httpOnly session cookies for the console gate.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ensureMasterKey } from '#features/settings/secrets.mjs';

export const SESSION_COOKIE = 'kusa_session';
export const PENDING_COOKIE = 'kusa_pending';
const MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 days
const PENDING_AGE_SEC = 60 * 10; // 10 minutes for TOTP step

function signingKey() {
  return ensureMasterKey();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signPayload(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  const raw = String(token || '');
  const i = raw.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (typeof data.exp !== 'number' || Date.now() > data.exp) return null;
  return data;
}

export function createSessionToken({ username, mode = 'local' }) {
  const now = Date.now();
  return signPayload({
    v: 1,
    kind: 'session',
    sub: String(username || 'admin'),
    mode: String(mode || 'local'),
    iat: now,
    exp: now + MAX_AGE_SEC * 1000,
    jti: randomBytes(8).toString('hex'),
  });
}

export function createPendingToken({ username }) {
  const now = Date.now();
  return signPayload({
    v: 1,
    kind: 'pending',
    sub: String(username || 'admin'),
    iat: now,
    exp: now + PENDING_AGE_SEC * 1000,
    jti: randomBytes(8).toString('hex'),
  });
}

export function readSession(req) {
  const data = verifyToken(parseCookie(req)[SESSION_COOKIE]);
  if (!data || data.kind !== 'session') return null;
  return { username: data.sub, mode: data.mode || 'local' };
}

export function readPending(req) {
  const data = verifyToken(parseCookie(req)[PENDING_COOKIE]);
  if (!data || data.kind !== 'pending') return null;
  return { username: data.sub };
}

export function parseCookie(req) {
  const header = String(req?.headers?.cookie || '');
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function cookieFlags(maxAge) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function setSessionCookie(res, token) {
  appendSetCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(MAX_AGE_SEC)}`);
}

export function setPendingCookie(res, token) {
  appendSetCookie(res, `${PENDING_COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(PENDING_AGE_SEC)}`);
}

export function clearAuthCookies(res) {
  appendSetCookie(res, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  appendSetCookie(res, `${PENDING_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function clearPendingCookie(res) {
  appendSetCookie(res, `${PENDING_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  const list = Array.isArray(prev) ? prev : [String(prev)];
  res.setHeader('Set-Cookie', [...list, value]);
}
