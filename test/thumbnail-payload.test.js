import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeThumbnailB64,
  MAX_THUMBNAIL_BYTES,
} from '../src/lib/thumbnail-payload.js';

const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function jpegB64(size = 64) {
  const buffer = Buffer.alloc(size, 0x20);
  JPEG_PREFIX.copy(buffer, 0);
  buffer[buffer.length - 2] = 0xff;
  buffer[buffer.length - 1] = 0xd9;
  return buffer.toString('base64');
}

test('decodeThumbnailB64 accepts a jpeg payload', () => {
  const buffer = decodeThumbnailB64(jpegB64());
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer[0], 0xff);
  assert.equal(buffer[1], 0xd8);
});

test('decodeThumbnailB64 trims surrounding whitespace', () => {
  const buffer = decodeThumbnailB64(`  ${jpegB64()}  `);
  assert.ok(Buffer.isBuffer(buffer));
});

test('decodeThumbnailB64 rejects non-strings, empties and non-jpeg data', () => {
  assert.equal(decodeThumbnailB64(undefined), null);
  assert.equal(decodeThumbnailB64(null), null);
  assert.equal(decodeThumbnailB64(42), null);
  assert.equal(decodeThumbnailB64(''), null);
  assert.equal(decodeThumbnailB64('   '), null);
  assert.equal(decodeThumbnailB64(Buffer.from('not an image').toString('base64')), null);
});

test('decodeThumbnailB64 rejects oversized payloads', () => {
  const oversized = Buffer.alloc(MAX_THUMBNAIL_BYTES + 8, 0x20);
  JPEG_PREFIX.copy(oversized, 0);
  assert.equal(decodeThumbnailB64(oversized.toString('base64')), null);

  const overlongBase64 = 'A'.repeat((MAX_THUMBNAIL_BYTES / 3) * 4 + 64);
  assert.equal(decodeThumbnailB64(overlongBase64), null);
});
