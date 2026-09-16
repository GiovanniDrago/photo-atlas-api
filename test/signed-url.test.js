import test from 'node:test';
import assert from 'node:assert/strict';
import { signAsset, verifyAssetSignature, assetUrls } from '../src/lib/signed-url.js';

const ID = '3ea4bde7-8743-4119-9cb7-c89243b922d8';

test('signature verifies for the same asset', () => {
  const signature = signAsset('thumb', ID);
  assert.equal(verifyAssetSignature('thumb', ID, signature), true);
});

test('signature rejects tampering and wrong kinds', () => {
  const signature = signAsset('thumb', ID);
  assert.equal(verifyAssetSignature('thumb', ID, `${signature}0`), false);
  assert.equal(verifyAssetSignature('download', ID, signature), false);
  assert.equal(verifyAssetSignature('thumb', ID, ''), false);
  assert.equal(verifyAssetSignature('thumb', '00000000-0000-0000-0000-000000000000', signature), false);
});

test('assetUrls returns relative signed urls', () => {
  const urls = assetUrls(ID);
  assert.match(urls.thumbnail_url, /^\/api\/media\/.+\/thumbnail\?m=.+&s=[0-9a-f]{64}$/);
  assert.match(urls.download_url, /^\/api\/media\/.+\/download\?m=.+&s=[0-9a-f]{64}$/);
});
