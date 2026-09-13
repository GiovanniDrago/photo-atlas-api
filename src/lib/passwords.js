import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = (stored ?? '').split(':');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (expectedBuffer.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuffer);
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
