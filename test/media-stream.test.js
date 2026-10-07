import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import mediaRoutes from '../src/routes/media.js';
import { registerAuthHook } from '../src/lib/supabase-auth.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { signAsset } from '../src/lib/signed-url.js';
import { config } from '../src/config.js';
import { startJwksServer, startFakeGoTrue, signToken } from './helpers/supabase-test-env.js';
import { startFakeKDrive } from './helpers/fake-kdrive.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'TEST_DATABASE_URL is not set';
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const FILE_ID = 5150;

let jwks;
let fakeGoTrue;
let fakeKDrive;
let pool;

test.before(async () => {
  jwks = await startJwksServer();
  fakeGoTrue = await startFakeGoTrue();
  fakeKDrive = await startFakeKDrive();
  if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl });
});

test.after(async () => {
  await jwks?.close();
  await fakeGoTrue?.close();
  await fakeKDrive?.close();
  await pool?.end();
});

test.beforeEach(() => {
  fakeKDrive.state.downloads.length = 0;
});

async function buildApp() {
  const app = Fastify();
  registerAuthHook(app);
  await app.register(mediaRoutes);
  return app;
}

async function createUser() {
  const email = `stream_${crypto.randomBytes(4).toString('hex')}@example.com`;
  const { rows } = await pool.query(
    'INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id',
    [email],
  );
  const userId = rows[0].id;
  const secret = encryptSecret('fake-kdrive-token', config.kdriveEncKey);
  await pool.query(
    `INSERT INTO kdrive_accounts (label, drive_id, token_cipher, token_iv, token_tag, owner_id)
     VALUES ('test', 42, $1, $2, $3, $4)`,
    [secret.cipher, secret.iv, secret.tag, userId],
  );
  const token = await signToken({
    sub: userId,
    email,
    privateKey: jwks.privateKey,
    kid: jwks.kid,
  });
  return { userId, email, token };
}

/// An uploaded item: local source row (phone path, not readable by the API)
/// with the file living on kDrive.
async function createUploadedItem(userId, { kdriveFileId = FILE_ID } = {}) {
  const { rows: sourceRows } = await pool.query(
    `INSERT INTO sources (kind, label, owner_id)
     VALUES ('local', 'Camera', $1) RETURNING id`,
    [userId],
  );
  const { rows } = await pool.query(
    `INSERT INTO media_items
       (source_id, external_key, path, name, mime, media_type, size_bytes,
        backup_status, kdrive_file_id, backed_up_at)
     VALUES ($1, 'asset-1', '/phone/DCIM/Camera/VID_0001.mp4', 'VID_0001.mp4',
             'video/mp4', 'video', $2, 'uploaded', $3, now())
     RETURNING id`,
    [sourceRows[0].id, CONTENT.length, kdriveFileId],
  );
  fakeKDrive.state.files.set(kdriveFileId, {
    id: kdriveFileId,
    name: 'VID_0001.mp4',
    size: CONTENT.length,
    parentId: 7,
    type: 'file',
    content: CONTENT,
  });
  return rows[0].id;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM auth.users WHERE id = $1', [userId]);
}

test('stream rejects an invalid signature', { skip }, async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/media/3ea4bde7-8743-4119-9cb7-c89243b922d8/stream?s=bogus',
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('stream is unavailable without a cloud copy', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createUploadedItem(userId, { kdriveFileId: null });
    fakeKDrive.state.files.delete(FILE_ID);
    const response = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/stream?s=${signAsset('stream', mediaId)}`,
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(fakeKDrive.state.downloads, []);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('stream proxies the full file from kDrive', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createUploadedItem(userId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/stream?s=${signAsset('stream', mediaId)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'video/mp4');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['content-length'], String(CONTENT.length));
    assert.deepEqual(response.rawPayload, CONTENT);
    assert.deepEqual(fakeKDrive.state.downloads, [{ fileId: FILE_ID, range: null }]);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('stream forwards the Range header and returns 206', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createUploadedItem(userId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/stream?s=${signAsset('stream', mediaId)}`,
      headers: { range: 'bytes=2-5' },
    });
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], `bytes 2-5/${CONTENT.length}`);
    assert.equal(response.headers['content-length'], '4');
    assert.deepEqual(response.rawPayload, CONTENT.subarray(2, 6));
    assert.deepEqual(fakeKDrive.state.downloads, [{ fileId: FILE_ID, range: 'bytes=2-5' }]);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('HEAD answers from the indexed row without touching kDrive', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createUploadedItem(userId);
    const response = await app.inject({
      method: 'HEAD',
      url: `/api/media/${mediaId}/stream?s=${signAsset('stream', mediaId)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-length'], String(CONTENT.length));
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.deepEqual(fakeKDrive.state.downloads, []);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('download proxies uploaded local items from kDrive', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createUploadedItem(userId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/download?s=${signAsset('download', mediaId)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'video/mp4');
    assert.match(response.headers['content-disposition'], /attachment; filename="VID_0001\.mp4"/);
    assert.deepEqual(response.rawPayload, CONTENT);
    assert.deepEqual(fakeKDrive.state.downloads, [{ fileId: FILE_ID, range: null }]);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});
