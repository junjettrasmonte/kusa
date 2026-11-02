/**
 * Local console password hashing (scrypt).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/** @returns {string} `scrypt$n$r$p$saltB64$hashB64` */
export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(String(password ?? ''), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/** Constant-time verify against a `hashPassword` string. */
export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isFinite(v) && v > 0)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== KEYLEN) return false;
  const actual = scryptSync(String(password ?? ''), salt, expected.length, { N: n, r, p });
  try {
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
