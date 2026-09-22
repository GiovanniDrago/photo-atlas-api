import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import mediaRoutes from '../src/routes/media.js';
import { registerAuthHook } from '../src/lib/supabase-auth.js';
import { encryptSecret } from '../src/lib/crypto.js';
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
  fakeKDrive.state.deleted.length = 0;
});

async function buildApp() {
  const app = Fastify();
  registerAuthHook(app);
  await app.register(mediaRoutes);
  return app;
}

async function createUser({ kdrive = true } = {}) {
  const email = `media_${crypto.randomBytes(4).toString('hex')}@example.com`;
  const { rows } = await pool.query(
    'INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id',
    [email],
  );
  const userId = rows[0].id;
  if (kdrive) {
    const secret = encryptSecret('fake-kdrive-token', config.kdriveEncKey);
    await pool.query(
      `INSERT INTO kdrive_accounts (label, drive_id, token_cipher, token_iv, token_tag, owner_id)
       VALUES ('test', 42, $1, $2, $3, $4)`,
      [secret.cipher, secret.iv, secret.tag, userId],
    );
  }
  const token = await signToken({
    sub: userId,
    email,
    privateKey: jwks.privateKey,
    kid: jwks.kid,
  });
  return { userId, email, token };
}

async function createSource(userId, { kind = 'local', label = 'Camera' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO sources (kind, label, root_path, owner_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [kind, label, kind === 'local' ? 'album:camera' : null, userId],
  );
  return rows[0].id;
}

async function createItem(
  sourceId,
  { name = 'IMG_0001.jpg', status = 'uploaded', kdriveFileId = null, externalKey } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO media_items (source_id, external_key, name, mime, media_type, size_bytes, backup_status, kdrive_file_id)
     VALUES ($1, $2, $3, 'image/jpeg', 'image', 10, $4, $5) RETURNING id`,
    [
      sourceId,
      externalKey ?? `asset:${crypto.randomBytes(4).toString('hex')}`,
      name,
      status,
      kdriveFileId,
    ],
  );
  return rows[0].id;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM auth.users WHERE id = $1', [userId]);
}

function addKDriveFile(id, { name = 'IMG_0001.jpg', size = 10 } = {}) {
  fakeKDrive.state.files.set(id, { id, name, size, parentId: 1, type: 'file' });
}

test('delete moves the kDrive file to the trash and resets the index row', { skip }, async () => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  try {
    const sourceId = await createSource(userId);
    addKDriveFile(777);
    const mediaId = await createItem(sourceId, { kdriveFileId: 777 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [mediaId], cloud: true },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.deleted, 0);
    assert.equal(body.cloud_deleted, 1);
    assert.equal(body.reset, 1);
    assert.deepEqual(body.failed, []);
    assert.deepEqual(fakeKDrive.state.deleted, [777]);

    const { rows } = await pool.query(
      'SELECT backup_status, kdrive_file_id, backed_up_at FROM media_items WHERE id = $1',
      [mediaId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].backup_status, 'none');
    assert.equal(rows[0].kdrive_file_id, null);
    assert.equal(rows[0].backed_up_at, null);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('delete with index=true removes the row', { skip }, async () => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  try {
    const sourceId = await createSource(userId);
    addKDriveFile(778);
    const mediaId = await createItem(sourceId, { kdriveFileId: 778 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [mediaId], cloud: true, index: true },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.deleted, 1);
    assert.equal(body.cloud_deleted, 1);
    assert.deepEqual(fakeKDrive.state.deleted, [778]);

    const { rows } = await pool.query('SELECT 1 FROM media_items WHERE id = $1', [mediaId]);
    assert.equal(rows.length, 0);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('delete without cloud only drops the requested index rows', { skip }, async () => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  try {
    const sourceId = await createSource(userId);
    addKDriveFile(779);
    const mediaId = await createItem(sourceId, { kdriveFileId: 779 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [mediaId], cloud: false, index: true },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(fakeKDrive.state.deleted, []);
    const { rows } = await pool.query('SELECT 1 FROM media_items WHERE id = $1', [mediaId]);
    assert.equal(rows.length, 0);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('kDrive-sourced items leave the index when their file is deleted', { skip }, async () => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  try {
    const sourceId = await createSource(userId, { kind: 'kdrive', label: 'kDrive' });
    addKDriveFile(780);
    const mediaId = await createItem(sourceId, {
      status: 'uploaded',
      externalKey: '780',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [mediaId], cloud: true },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().deleted, 1);
    assert.deepEqual(fakeKDrive.state.deleted, [780]);
    const { rows } = await pool.query('SELECT 1 FROM media_items WHERE id = $1', [mediaId]);
    assert.equal(rows.length, 0);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('items of another user are not touched', { skip }, async () => {
  const app = await buildApp();
  const owner = await createUser();
  const stranger = await createUser();
  try {
    const sourceId = await createSource(owner.userId);
    addKDriveFile(781);
    const mediaId = await createItem(sourceId, { kdriveFileId: 781 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${stranger.token}` },
      payload: { ids: [mediaId], cloud: true, index: true },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().deleted, 0);
    assert.deepEqual(fakeKDrive.state.deleted, []);
    const { rows } = await pool.query('SELECT 1 FROM media_items WHERE id = $1', [mediaId]);
    assert.equal(rows.length, 1);
  } finally {
    await app.close();
    await cleanupUser(owner.userId);
    await cleanupUser(stranger.userId);
  }
});

test('a missing kDrive account fails the cloud deletion but keeps the row', { skip }, async () => {
  const app = await buildApp();
  const { userId, token } = await createUser({ kdrive: false });
  try {
    const sourceId = await createSource(userId);
    const mediaId = await createItem(sourceId, { kdriveFileId: 782 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [mediaId], cloud: true, index: true },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.deleted, 0);
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0].id, mediaId);
    const { rows } = await pool.query('SELECT 1 FROM media_items WHERE id = $1', [mediaId]);
    assert.equal(rows.length, 1);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('empty or invalid id lists are rejected', { skip }, async () => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  try {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [] },
    });
    assert.equal(empty.statusCode, 400);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/media/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: ['nope'] },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});

test('media list reports the full total past the last page', { skip }, async () => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  try {
    const sourceId = await createSource(userId);
    for (let index = 0; index < 3; index += 1) {
      await createItem(sourceId, { name: `IMG_000${index}.jpg`, status: 'none' });
    }
    const first = await app.inject({
      method: 'GET',
      url: '/api/media?limit=2&offset=0',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().total, 3);

    const last = await app.inject({
      method: 'GET',
      url: '/api/media?limit=2&offset=2',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(last.statusCode, 200);
    assert.equal(last.json().items.length, 1);
    assert.equal(last.json().total, 3);

    const empty = await app.inject({
      method: 'GET',
      url: '/api/media?limit=2&offset=10',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().items.length, 0);
    assert.equal(empty.json().total, 3);
  } finally {
    await app.close();
    await cleanupUser(userId);
  }
});
