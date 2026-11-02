/**
 * SAML 2.0 SP login for the console gate.
 */
import { SAML } from '@node-saml/node-saml';
import { normalizeAuth } from '#features/auth/shape.mjs';

async function buildSaml(auth, { callbackUrl, issuer }) {
  const a = normalizeAuth(auth);
  if (!a.saml.entityId || !(a.saml.idpMetadataUrl || a.saml.idpMetadataXml)) {
    const err = new Error('SAML is not configured');
    err.code = 'ENOCONFIG';
    throw err;
  }
  /** @type {Record<string, unknown>} */
  const options = {
    callbackUrl,
    issuer: issuer || a.saml.entityId,
    entryPoint: '',
    idpCert: 'placeholder',
    wantAssertionsSigned: a.saml.wantAssertionsSigned !== false,
    wantAuthnResponseSigned: false,
    identifierFormat: null,
  };

  if (a.saml.idpMetadataXml) {
    // node-saml accepts IdP metadata via identityProviderUrl + certs; parse XML lightly.
    const xml = a.saml.idpMetadataXml;
    const entry = xml.match(/Location="([^"]+)"[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"/)
      || xml.match(/Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"[^>]*Location="([^"]+)"/)
      || xml.match(/SingleSignOnService[^>]*Location="([^"]+)"/);
    const cert = xml.match(/<X509Certificate>([^<]+)<\/X509Certificate>/);
    if (entry) options.entryPoint = entry[1];
    if (cert) options.idpCert = cert[1].replace(/\s+/g, '');
  } else if (a.saml.idpMetadataUrl) {
    const res = await fetch(a.saml.idpMetadataUrl);
    if (!res.ok) {
      const err = new Error(`Failed to fetch IdP metadata (${res.status})`);
      err.code = 'EMETA';
      throw err;
    }
    const xml = await res.text();
    const entry = xml.match(/Location="([^"]+)"[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"/)
      || xml.match(/Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"[^>]*Location="([^"]+)"/)
      || xml.match(/SingleSignOnService[^>]*Location="([^"]+)"/);
    const cert = xml.match(/<X509Certificate>([^<]+)<\/X509Certificate>/);
    if (entry) options.entryPoint = entry[1];
    if (cert) options.idpCert = cert[1].replace(/\s+/g, '');
  }

  if (!options.entryPoint || options.idpCert === 'placeholder') {
    const err = new Error('Could not parse IdP SSO URL or certificate from metadata');
    err.code = 'EMETA';
    throw err;
  }

  return new SAML(options);
}

export async function startSamlLogin(auth, { callbackUrl, issuer }) {
  const saml = await buildSaml(auth, { callbackUrl, issuer });
  const url = await saml.getAuthorizeUrlAsync('', undefined, {});
  return { url };
}

export async function finishSamlLogin(auth, { callbackUrl, issuer, body }) {
  const saml = await buildSaml(auth, { callbackUrl, issuer });
  const result = await saml.validatePostResponseAsync(body || {});
  const profile = result?.profile || result || {};
  const username = String(
    profile.nameID
    || profile.email
    || profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']
    || 'saml-user',
  ).slice(0, 120);
  return { username, profile };
}

export function samlSpMetadata({ entityId, callbackUrl }) {
  const eid = String(entityId || callbackUrl || 'http://127.0.0.1:1424/auth/saml/metadata');
  const acs = String(callbackUrl || 'http://127.0.0.1:1424/auth/saml/acs');
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(eid)}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(acs)}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
