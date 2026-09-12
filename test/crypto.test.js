import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from '../src/lib/crypto.js';

const KEY = crypto.randomBytes(32).toString('hex');

test('encrypts and decrypts a secret', () => {
  const secret = 'infomaniak-personal-token-value';
  const encrypted = encryptSecret(secret, KEY);
  assert.notEqual(encrypted.cipher, secret);
  assert.equal(decryptSecret(encrypted, KEY), secret);
});

test('rejects an invalid key', () => {
  assert.throws(() => encryptSecret('x', 'too-short'), /KDRIVE_ENC_KEY/);
});

test('rejects tampered ciphertext', () => {
  const encrypted = encryptSecret('x', KEY);
  assert.throws(() => decryptSecret({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }, KEY));
});
