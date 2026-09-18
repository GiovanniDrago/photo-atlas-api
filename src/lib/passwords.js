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

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '1234567890', 'qwertyuiop',
  'letmein123', 'photoatlas', 'administrator', 'iloveyou123', 'changeme123',
]);

export function passwordPolicyError(password, { email } = {}) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'password must be at least 10 characters';
  }
  if (password.length > 200) {
    return 'password must be at most 200 characters';
  }
  const lower = password.toLowerCase();
  const localPart = String(email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 3 && lower.includes(localPart)) {
    return 'password must not contain your email';
  }
  if (COMMON_PASSWORDS.has(lower)) {
    return 'password is too common';
  }
  return null;
}
