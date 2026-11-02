/**
 * TOTP helpers for local console 2FA (otpauth).
 */
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';

const ISSUER = 'Kusă';
const DIGITS = 6;
const PERIOD = 30;

export function generateTotpSecret() {
  return new Secret({ size: 20 }).base32;
}

export function totpUri({ secret, username }) {
  const totp = new TOTP({
    issuer: ISSUER,
    label: String(username || 'admin').trim() || 'admin',
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(String(secret || '').replace(/\s+/g, '')),
  });
  return totp.toString();
}

export async function totpQrDataUrl({ secret, username }) {
  const uri = totpUri({ secret, username });
  return QRCode.toDataURL(uri, { margin: 1, width: 192 });
}

export function verifyTotp(secret, token) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const totp = new TOTP({
    issuer: ISSUER,
    label: 'kusa',
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(String(secret || '').replace(/\s+/g, '')),
  });
  // ±1 step window
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}
