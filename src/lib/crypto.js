import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function keyBuffer(hexKey) {
  const key = Buffer.from(hexKey ?? '', 'hex');
  if (key.length !== 32) {
    throw new Error('KDRIVE_ENC_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }
  return key;
}

export function encryptSecret(plaintext, hexKey) {
  const key = keyBuffer(hexKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret({ cipher, iv, tag }, hexKey) {
  const key = keyBuffer(hexKey);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipher, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}
