import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  generateTotp,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from '../src/lib/totp.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 round-trips buffers', () => {
  const buffer = Buffer.from('12345678901234567890', 'ascii');
  const encoded = base32Encode(buffer);
  assert.equal(encoded, RFC_SECRET);
  assert.deepEqual(base32Decode(encoded), buffer);
});

test('base32 decode ignores padding, spaces and separators', () => {
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojqGEZDGNBVGY3TQOJQ=='), base32Decode(RFC_SECRET));
});

test('generateTotpSecret produces decodable high-entropy secrets', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});

test('generateTotp matches RFC 6238 SHA-1 vectors', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(generateTotp(RFC_SECRET, { timestamp: seconds * 1000, digits: 8 }), expected);
  }
});

test('verifyTotp accepts the current code and one step of drift', () => {
  const timestamp = 1700000000000;
  const code = generateTotp(RFC_SECRET, { timestamp });
  assert.equal(verifyTotp(RFC_SECRET, code, { timestamp }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { timestamp: timestamp + 30000 }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { timestamp: timestamp - 30000 }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { timestamp: timestamp + 120000 }), false);
});

test('verifyTotp rejects malformed and wrong codes', () => {
  const timestamp = 1700000000000;
  assert.equal(verifyTotp(RFC_SECRET, 'abc123', { timestamp }), false);
  assert.equal(verifyTotp(RFC_SECRET, '000000', { timestamp }), false);
  assert.equal(verifyTotp(RFC_SECRET, '', { timestamp }), false);
  assert.equal(verifyTotp('', '123456', { timestamp }), false);
});

test('totpUri builds a scannable otpauth url', () => {
  const uri = totpUri(RFC_SECRET, { account: 'demo@example.com' });
  assert.match(uri, /^otpauth:\/\/totp\/Photo%20Atlas%3Ademo%40example\.com\?/);
  assert.match(uri, new RegExp(`secret=${RFC_SECRET}`));
  assert.match(uri, /issuer=Photo\+Atlas/);
  assert.match(uri, /algorithm=SHA1/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});
