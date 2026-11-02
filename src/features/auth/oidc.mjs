/**
 * OIDC authorization-code login for the console gate.
 */
import * as openid from 'openid-client';
import { normalizeAuth } from '#features/auth/shape.mjs';

/** @type {Map<string, { codeVerifier: string, state: string, exp: number }>} */
const pending = new Map();

function prunePending() {
  const now = Date.now();
  for (const [key, value] of pending) {
    if (!value || value.exp < now) pending.delete(key);
  }
}

export async function startOidcLogin(auth, { redirectUri }) {
  const a = normalizeAuth(auth);
  if (!a.oidc.issuer || !a.oidc.clientId || !a.oidc.clientSecret) {
    const err = new Error('OIDC is not configured');
    err.code = 'ENOCONFIG';
    throw err;
  }
  const server = new URL(a.oidc.issuer);
  const config = await openid.discovery(server, a.oidc.clientId, a.oidc.clientSecret);
  const codeVerifier = openid.randomPKCECodeVerifier();
  const codeChallenge = await openid.calculatePKCECodeChallenge(codeVerifier);
  const state = openid.randomState();
  prunePending();
  pending.set(state, {
    codeVerifier,
    state,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const scope = a.oidc.scopes || 'openid profile email';
  const url = openid.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: url.href, state };
}

export async function finishOidcLogin(auth, { redirectUri, callbackUrl }) {
  const a = normalizeAuth(auth);
  const server = new URL(a.oidc.issuer);
  const config = await openid.discovery(server, a.oidc.clientId, a.oidc.clientSecret);
  const currentUrl = typeof callbackUrl === 'string' ? new URL(callbackUrl) : callbackUrl;
  const state = currentUrl.searchParams.get('state') || '';
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || entry.exp < Date.now()) {
    const err = new Error('OIDC login expired — try again');
    err.code = 'EXPIRED';
    throw err;
  }
  const tokens = await openid.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: entry.codeVerifier,
    expectedState: entry.state,
    idTokenExpected: true,
  });
  const claims = tokens.claims() || {};
  const username = String(
    claims.preferred_username
    || claims.email
    || claims.sub
    || 'oidc-user',
  ).slice(0, 120);
  return { username, claims };
}
