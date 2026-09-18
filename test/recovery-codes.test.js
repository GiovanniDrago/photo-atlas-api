import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyRecoveryCode,
} from '../src/lib/recovery-codes.js';

test('generateRecoveryCodes returns unique formatted codes', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const code of codes) {
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  }
});

test('recovery codes hash and verify with normalization', () => {
  const [code] = generateRecoveryCodes(1);
  const stored = hashRecoveryCode(code);
  assert.equal(verifyRecoveryCode(code, stored), true);
  assert.equal(verifyRecoveryCode(code.toLowerCase(), stored), true);
  assert.equal(verifyRecoveryCode(code.replace('-', ' '), stored), true);
  assert.equal(verifyRecoveryCode('AAAA-BBBB', stored), false);
  assert.equal(verifyRecoveryCode('', stored), false);
  assert.equal(verifyRecoveryCode(null, stored), false);
});

test('normalizeRecoveryCode strips separators and case', () => {
  assert.equal(normalizeRecoveryCode(' abcd-ef23 '), 'ABCDEF23');
  assert.equal(normalizeRecoveryCode(''), '');
  assert.equal(normalizeRecoveryCode(undefined), '');
});
