import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './passwords.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeRecoveryCode(code) {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function generateRecoveryCodes(count = 8) {
  const codes = new Set();
  while (codes.size < count) {
    const bytes = crypto.randomBytes(10);
    let value = '';
    for (let index = 0; index < 8; index += 1) {
      value += ALPHABET[bytes[index] % ALPHABET.length];
    }
    codes.add(`${value.slice(0, 4)}-${value.slice(4)}`);
  }
  return [...codes];
}

export function hashRecoveryCode(code) {
  return hashPassword(normalizeRecoveryCode(code));
}

export function verifyRecoveryCode(code, storedHash) {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 8) return false;
  return verifyPassword(normalized, storedHash);
}
