import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input) {
  const clean = String(input ?? '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secretBuffer, counter, digits) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function generateTotp(secret, { timestamp = Date.now(), period = 30, digits = 6 } = {}) {
  const counter = Math.floor(timestamp / 1000 / period);
  return hotp(base32Decode(secret), counter, digits);
}

export function verifyTotp(
  secret,
  token,
  { window = 1, timestamp = Date.now(), period = 30, digits = 6 } = {},
) {
  const value = String(token ?? '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(value)) return false;
  const secretBuffer = base32Decode(secret);
  if (secretBuffer.length === 0) return false;
  const counter = Math.floor(timestamp / 1000 / period);
  const provided = Buffer.from(value);
  let match = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = Buffer.from(hotp(secretBuffer, counter + offset, digits));
    if (candidate.length === provided.length && crypto.timingSafeEqual(candidate, provided)) {
      match = true;
    }
  }
  return match;
}

export function totpUri(secret, { account, issuer = 'Photo Atlas', digits = 6, period = 30 } = {}) {
  const label = account ? `${issuer}:${account}` : issuer;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
