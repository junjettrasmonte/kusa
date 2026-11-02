/**
 * Auth settings shape + browser-safe projection (no crypto imports).
 */

export const AUTH_MODES = ['local', 'oidc', 'saml'];

export function defaultAuthSettings() {
  return {
    mode: 'local',
    local: {
      username: '',
      passwordHash: '',
      totpSecret: '',
    },
    oidc: {
      issuer: '',
      clientId: '',
      clientSecret: '',
      scopes: 'openid profile email',
    },
    saml: {
      idpMetadataUrl: '',
      idpMetadataXml: '',
      entityId: '',
      wantAssertionsSigned: true,
    },
  };
}

function localEnrolled(a) {
  return Boolean(a.local.username && a.local.passwordHash && a.local.totpSecret);
}

function oidcReady(a) {
  return Boolean(a.oidc.issuer && a.oidc.clientId && a.oidc.clientSecret);
}

function samlReady(a) {
  return Boolean(a.saml.entityId && (a.saml.idpMetadataUrl || a.saml.idpMetadataXml));
}

/**
 * Mode the login UI should use. Incomplete SSO falls back to local when a
 * local admin is enrolled, so switching to OIDC/SAML mid-setup cannot lock
 * the console behind a broken redirect.
 */
export function effectiveAuthMode(auth) {
  const a = normalizeAuth(auth);
  if (a.mode === 'oidc') return oidcReady(a) ? 'oidc' : (localEnrolled(a) ? 'local' : 'oidc');
  if (a.mode === 'saml') return samlReady(a) ? 'saml' : (localEnrolled(a) ? 'local' : 'saml');
  return 'local';
}

export function isAuthConfigured(auth) {
  const a = normalizeAuth(auth);
  const mode = effectiveAuthMode(a);
  if (mode === 'local') return localEnrolled(a);
  if (mode === 'oidc') return oidcReady(a);
  if (mode === 'saml') return samlReady(a);
  return false;
}

export function normalizeAuth(raw = {}) {
  const base = defaultAuthSettings();
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = AUTH_MODES.includes(src.mode) ? src.mode : 'local';
  const localIn = src.local && typeof src.local === 'object' ? src.local : {};
  const oidcIn = src.oidc && typeof src.oidc === 'object' ? src.oidc : {};
  const samlIn = src.saml && typeof src.saml === 'object' ? src.saml : {};
  return {
    mode,
    local: {
      username: String(localIn.username ?? base.local.username).trim().slice(0, 120),
      passwordHash: String(localIn.passwordHash ?? base.local.passwordHash).slice(0, 400),
      totpSecret: String(localIn.totpSecret ?? base.local.totpSecret).replace(/\s+/g, '').slice(0, 128),
    },
    oidc: {
      issuer: String(oidcIn.issuer ?? '').trim().slice(0, 500),
      clientId: String(oidcIn.clientId ?? '').trim().slice(0, 200),
      clientSecret: String(oidcIn.clientSecret ?? '').slice(0, 4000),
      scopes: String(oidcIn.scopes ?? base.oidc.scopes).trim().slice(0, 200) || base.oidc.scopes,
    },
    saml: {
      idpMetadataUrl: String(samlIn.idpMetadataUrl ?? '').trim().slice(0, 1000),
      idpMetadataXml: String(samlIn.idpMetadataXml ?? '').slice(0, 200_000),
      entityId: String(samlIn.entityId ?? '').trim().slice(0, 500),
      wantAssertionsSigned: samlIn.wantAssertionsSigned !== false,
    },
  };
}

/** Browser-safe auth summary — never hashes or secrets. */
export function publicAuthSettings(auth) {
  const a = normalizeAuth(auth);
  const mode = effectiveAuthMode(a);
  const configured = isAuthConfigured(a);
  return {
    authMode: mode,
    authModeSelected: a.mode,
    authConfigured: configured,
    totpEnabled: mode === 'local' && Boolean(a.local.totpSecret),
    authUsername: a.local.username || '',
    oidc: {
      issuer: a.oidc.issuer,
      clientId: a.oidc.clientId,
      clientSecretSet: Boolean(a.oidc.clientSecret),
      scopes: a.oidc.scopes,
    },
    saml: {
      idpMetadataUrl: a.saml.idpMetadataUrl,
      idpMetadataXmlSet: Boolean(a.saml.idpMetadataXml),
      entityId: a.saml.entityId,
      wantAssertionsSigned: a.saml.wantAssertionsSigned !== false,
    },
  };
}

/**
 * Merge a settings-panel auth patch into current in-memory auth.
 * Omitting clientSecret / password / totpSecret keeps the prior value;
 * empty string clears where applicable.
 */
export function mergeAuthPatch(current, patch) {
  const base = normalizeAuth(current);
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base };
  if (AUTH_MODES.includes(patch.mode)) next.mode = patch.mode;

  if (patch.local && typeof patch.local === 'object') {
    const local = { ...next.local };
    if (patch.local.username !== undefined) {
      local.username = String(patch.local.username ?? '').trim().slice(0, 120);
    }
    if (typeof patch.local.passwordHash === 'string' && patch.local.passwordHash) {
      local.passwordHash = patch.local.passwordHash;
    }
    if (typeof patch.local.totpSecret === 'string') {
      if (patch.local.totpSecret === '') local.totpSecret = '';
      else local.totpSecret = patch.local.totpSecret.replace(/\s+/g, '').slice(0, 128);
    }
    next.local = local;
  }

  if (patch.oidc && typeof patch.oidc === 'object') {
    const oidc = { ...next.oidc };
    if (patch.oidc.issuer !== undefined) oidc.issuer = String(patch.oidc.issuer ?? '').trim().slice(0, 500);
    if (patch.oidc.clientId !== undefined) oidc.clientId = String(patch.oidc.clientId ?? '').trim().slice(0, 200);
    if (patch.oidc.scopes !== undefined) {
      oidc.scopes = String(patch.oidc.scopes ?? '').trim().slice(0, 200) || defaultAuthSettings().oidc.scopes;
    }
    if (typeof patch.oidc.clientSecret === 'string') {
      if (patch.oidc.clientSecret === '') oidc.clientSecret = '';
      else oidc.clientSecret = patch.oidc.clientSecret.slice(0, 4000);
    }
    next.oidc = oidc;
  }

  if (patch.saml && typeof patch.saml === 'object') {
    const saml = { ...next.saml };
    if (patch.saml.idpMetadataUrl !== undefined) {
      saml.idpMetadataUrl = String(patch.saml.idpMetadataUrl ?? '').trim().slice(0, 1000);
    }
    if (patch.saml.idpMetadataXml !== undefined) {
      saml.idpMetadataXml = String(patch.saml.idpMetadataXml ?? '').slice(0, 200_000);
    }
    if (patch.saml.entityId !== undefined) {
      saml.entityId = String(patch.saml.entityId ?? '').trim().slice(0, 500);
    }
    if (patch.saml.wantAssertionsSigned !== undefined) {
      saml.wantAssertionsSigned = patch.saml.wantAssertionsSigned !== false;
    }
    next.saml = saml;
  }

  return normalizeAuth(next);
}
