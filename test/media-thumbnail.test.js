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
  fakeKDrive.state.thumbnails.length = 0;
});

async function buildApp() {
  const app = Fastify();
  registerAuthHook(app);
  await app.register(mediaRoutes);
  return app;
}

async function createUser() {
  const email = `thumb_${crypto.randomBytes(4).toString('hex')}@example.com`;
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

async function createKDriveItem(userId, { fileId = 4242 } = {}) {
  const { rows: sourceRows } = await pool.query(
    `INSERT INTO sources (kind, label, kdrive_drive_id, kdrive_folder_id, owner_id)
     VALUES ('kdrive', 'kDrive', 42, 7, $1) RETURNING id`,
    [userId],
  );
  const sourceId = sourceRows[0].id;
  const { rows } = await pool.query(
    `INSERT INTO media_items (source_id, external_key, name, mime, media_type, size_bytes, backup_status)
     VALUES ($1, $2, 'IMG_0001.jpg', 'image/jpeg', 'image', 10, 'uploaded') RETURNING id`,
    [sourceId, String(fileId)],
  );
  fakeKDrive.state.files.set(fileId, {
    id: fileId,
    name: 'IMG_0001.jpg',
    size: 10,
    parentId: 7,
    type: 'file',
  });
  return rows[0].id;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM auth.users WHERE id = $1', [userId]);
}

test('thumbnail with a large width is proxied from kDrive without caching', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createKDriveItem(userId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/thumbnail?w=1600&s=${signAsset('thumb', mediaId)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.ok(response.rawPayload.length > 0);
    assert.deepEqual(fakeKDrive.state.thumbnails, [{ fileId: 4242, width: 1600 }]);

    const { rows } = await pool.query('SELECT thumb_path FROM media_items WHERE id = $1', [
      mediaId,
    ]);
    assert.equal(rows[0].thumb_path, null);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('thumbnail width is clamped to the supported range', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createKDriveItem(userId, { fileId: 4343 });
    const response = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/thumbnail?w=99999&s=${signAsset('thumb', mediaId)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(fakeKDrive.state.thumbnails, [{ fileId: 4343, width: 2048 }]);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('small or missing widths keep the cached 320 px path', { skip }, async () => {
  const app = await buildApp();
  const { userId } = await createUser();
  try {
    const mediaId = await createKDriveItem(userId, { fileId: 4444 });
    const small = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/thumbnail?w=200&s=${signAsset('thumb', mediaId)}`,
    });
    assert.equal(small.statusCode, 200);
    assert.deepEqual(fakeKDrive.state.thumbnails, [{ fileId: 4444, width: 320 }]);
    const { rows } = await pool.query('SELECT thumb_path FROM media_items WHERE id = $1', [
      mediaId,
    ]);
    assert.ok(rows[0].thumb_path, 'the 320 px thumbnail is cached on disk');

    fakeKDrive.state.thumbnails.length = 0;
    const plain = await app.inject({
      method: 'GET',
      url: `/api/media/${mediaId}/thumbnail?s=${signAsset('thumb', mediaId)}`,
    });
    assert.equal(plain.statusCode, 200);
    assert.deepEqual(fakeKDrive.state.thumbnails, []);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});
