/**
 * Auth block encrypt/decrypt for `.kusa/settings.json`.
 */
import {
  decryptSecret,
  encryptSecret,
  isSecretEnvelope,
} from '#features/settings/secrets.mjs';
import {
  defaultAuthSettings,
  normalizeAuth,
} from '#features/auth/shape.mjs';

export {
  AUTH_MODES,
  defaultAuthSettings,
  isAuthConfigured,
  mergeAuthPatch,
  normalizeAuth,
  publicAuthSettings,
} from '#features/auth/shape.mjs';

/** Decrypt auth envelopes from disk into memory fields. */
export function authFromDisk(rawAuth) {
  if (!rawAuth || typeof rawAuth !== 'object') {
    return { auth: defaultAuthSettings(), migrate: false };
  }
  const out = { ...rawAuth };
  let migrate = false;
  const local = out.local && typeof out.local === 'object' ? { ...out.local } : {};
  if (isSecretEnvelope(local.totpSecretEnc)) {
    try {
      local.totpSecret = decryptSecret(local.totpSecretEnc);
    } catch {
      local.totpSecret = '';
    }
    delete local.totpSecretEnc;
  } else if (typeof local.totpSecret === 'string' && local.totpSecret) {
    migrate = true;
  }
  out.local = local;

  const oidc = out.oidc && typeof out.oidc === 'object' ? { ...out.oidc } : {};
  if (isSecretEnvelope(oidc.clientSecretEnc)) {
    try {
      oidc.clientSecret = decryptSecret(oidc.clientSecretEnc);
    } catch {
      oidc.clientSecret = '';
    }
    delete oidc.clientSecretEnc;
  } else if (typeof oidc.clientSecret === 'string' && oidc.clientSecret) {
    migrate = true;
  }
  out.oidc = oidc;

  return { auth: normalizeAuth(out), migrate };
}

/** Encrypt secrets for settings.json. */
export function authToDisk(auth) {
  const a = normalizeAuth(auth);
  /** @type {Record<string, unknown>} */
  const disk = {
    mode: a.mode,
    local: {
      username: a.local.username,
      passwordHash: a.local.passwordHash,
    },
    oidc: {
      issuer: a.oidc.issuer,
      clientId: a.oidc.clientId,
      scopes: a.oidc.scopes,
    },
    saml: {
      idpMetadataUrl: a.saml.idpMetadataUrl,
      idpMetadataXml: a.saml.idpMetadataXml,
      entityId: a.saml.entityId,
      wantAssertionsSigned: a.saml.wantAssertionsSigned !== false,
    },
  };
  if (a.local.totpSecret) {
    disk.local.totpSecretEnc = encryptSecret(a.local.totpSecret);
  }
  if (a.oidc.clientSecret) {
    disk.oidc.clientSecretEnc = encryptSecret(a.oidc.clientSecret);
  }
  return disk;
}
