import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import pg from 'pg';
import backupRoutes from '../src/routes/backup.js';
import sourceRoutes from '../src/routes/sources.js';
import { registerAuthHook } from '../src/lib/supabase-auth.js';
import { registerOctetStreamParser } from '../src/lib/octet-stream-parser.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { config } from '../src/config.js';
import {
  manualFolderParts,
  sanitizeFolderName,
  sourceFolderParts,
  streamToTempFile,
} from '../src/services/backup.js';
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

async function buildApp() {
  const app = Fastify();
  registerOctetStreamParser(app);
  registerAuthHook(app);
  await app.register(backupRoutes);
  await app.register(sourceRoutes);
  return app;
}

async function createUser() {
  const email = `backup_${crypto.randomBytes(4).toString('hex')}@example.com`;
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

async function createSource(userId, { label = 'Camera', albumKey = 'camera' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO sources (kind, label, root_path, owner_id, album_key)
     VALUES ('local', $1, $2, $3, $4) RETURNING id`,
    [label, `album:${albumKey}`, userId, albumKey],
  );
  return rows[0].id;
}

async function createItem(
  sourceId,
  { name = 'IMG_0001.jpg', size = 10, status = 'none', kdriveFileId = null } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO media_items (source_id, external_key, name, mime, media_type, size_bytes, backup_status, kdrive_file_id)
     VALUES ($1, $2, $3, 'image/jpeg', 'image', $4, $5, $6) RETURNING id`,
    [sourceId, `asset:${crypto.randomBytes(4).toString('hex')}`, name, size, status, kdriveFileId],
  );
  return rows[0].id;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM backup_runs WHERE owner_id = $1', [userId]);
  await pool.query('DELETE FROM auth.users WHERE id = $1', [userId]);
}

test('folder helpers sanitize names and build the base path', () => {
  assert.equal(sanitizeFolderName('Camera'), 'Camera');
  assert.equal(sanitizeFolderName('  a/b\\c  '), 'a-b-c');
  assert.equal(sanitizeFolderName('...'), 'Album');
  assert.equal(sanitizeFolderName(''), 'Album');
  assert.equal(sanitizeFolderName('x'.repeat(200)).length, 80);
  assert.deepEqual(manualFolderParts(), ['Media', 'PhotoAtlas', 'Manual']);
  assert.deepEqual(sourceFolderParts('Camera'), ['Media', 'PhotoAtlas', 'Camera']);
});

test('streamToTempFile computes size and sha256', async () => {
  const payload = Buffer.from('photo-atlas-backup-test');
  const result = await streamToTempFile(Readable.from([payload]));
  try {
    assert.equal(result.size, payload.length);
    assert.equal(result.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    const stat = await fs.stat(result.filePath);
    assert.equal(stat.size, payload.length);
  } finally {
    await fs.rm(result.filePath, { force: true });
  }
});

test('devices upsert by fingerprint', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });
  const headers = { authorization: `Bearer ${token}` };

  const first = await app.inject({
    method: 'POST',
    url: '/api/devices',
    headers,
    payload: { fingerprint: 'fingerprint-1234', name: 'Pixel', platform: 'android' },
  });
  assert.equal(first.statusCode, 200, first.body);
  const deviceId = first.json().device.id;

  const second = await app.inject({
    method: 'POST',
    url: '/api/devices',
    headers,
    payload: { fingerprint: 'fingerprint-1234', name: 'Pixel 11', platform: 'android' },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().device.id, deviceId);
  assert.equal(second.json().device.name, 'Pixel 11');
});

test('backup status, pending queue and verify queue', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const sourceId = await createSource(userId);
  await createItem(sourceId, { status: 'none', size: 10 });
  await createItem(sourceId, { status: 'uploaded', size: 20, kdriveFileId: 555 });
  await createItem(sourceId, { status: 'failed', size: 30 });
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });
  const headers = { authorization: `Bearer ${token}` };

  const status = await app.inject({ method: 'GET', url: '/api/backup/status', headers });
  assert.equal(status.statusCode, 200, status.body);
  const entry = status.json().sources.find((source) => source.id === sourceId);
  assert.equal(entry.total, 3);
  assert.equal(entry.uploaded, 1);
  assert.equal(entry.pending, 1);
  assert.equal(entry.failed, 1);
  assert.equal(Number(entry.bytes_uploaded), 20);

  const pending = await app.inject({ method: 'GET', url: '/api/backup/pending', headers });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().items.length, 2);

  const verify = await app.inject({ method: 'GET', url: '/api/backup/verify-queue', headers });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().items.length, 1);
});

test('upload sends the file to kDrive and marks the item uploaded', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const sourceId = await createSource(userId, { label: 'Camera' });
  const itemId = await createItem(sourceId, { name: 'IMG_0001.jpg' });
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const payload = Buffer.from('fake-jpeg-bytes');
  const response = await app.inject({
    method: 'POST',
    url: `/api/media/${itemId}/upload`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.bytes, payload.length);
  assert.equal(body.content_hash, crypto.createHash('sha256').update(payload).digest('hex'));

  const upload = fakeKDrive.state.uploads.at(-1);
  assert.equal(upload.fileName, 'IMG_0001.jpg');
  assert.equal(upload.totalSize, payload.length);
  assert.equal(upload.conflict, 'rename');
  assert.equal(upload.bytes, payload.length);

  const { rows } = await pool.query(
    'SELECT backup_status, kdrive_file_id, content_hash, backup_attempts FROM media_items WHERE id = $1',
    [itemId],
  );
  assert.equal(rows[0].backup_status, 'uploaded');
  assert.equal(Number(rows[0].kdrive_file_id), body.kdrive_file_id);
  assert.equal(rows[0].content_hash, body.content_hash);
  assert.equal(rows[0].backup_attempts, 1);

  const { rows: sourceRows } = await pool.query(
    'SELECT backup_folder_id, backup_folder_path FROM sources WHERE id = $1',
    [sourceId],
  );
  assert.ok(sourceRows[0].backup_folder_id);
  assert.equal(sourceRows[0].backup_folder_path, 'Media/PhotoAtlas/Camera');
});

test('manual uploads go to Media/PhotoAtlas/Manual', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const sourceId = await createSource(userId, { label: 'Download' });
  const itemId = await createItem(sourceId, { name: 'manual.jpg' });
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/media/${itemId}/upload?destination=manual`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.from('manual-bytes'),
  });
  assert.equal(response.statusCode, 200, response.body);

  const { rows } = await pool.query(
    'SELECT kdrive_parent_id FROM media_items WHERE id = $1',
    [itemId],
  );
  const parentId = Number(rows[0].kdrive_parent_id);
  const manual = fakeKDrive.state.folders
    .get(1)
    ?.find((folder) => folder.name === 'Media');
  assert.ok(manual, 'Media folder created');
  const photoAtlas = fakeKDrive.state.folders
    .get(manual.id)
    ?.find((folder) => folder.name === 'PhotoAtlas');
  const manualFolder = fakeKDrive.state.folders
    .get(photoAtlas.id)
    ?.find((folder) => folder.name === 'Manual');
  assert.equal(parentId, manualFolder.id);
});

test('verify detects missing files and size mismatches', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const sourceId = await createSource(userId);
  const itemId = await createItem(sourceId, { size: 11 });
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/octet-stream',
  };

  const upload = await app.inject({
    method: 'POST',
    url: `/api/media/${itemId}/upload`,
    headers,
    payload: Buffer.from('eleven-byte'),
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const fileId = upload.json().kdrive_file_id;

  const ok = await app.inject({ method: 'POST', url: `/api/media/${itemId}/verify`, headers });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().ok, true);

  fakeKDrive.state.files.delete(Number(fileId));
  const missing = await app.inject({ method: 'POST', url: `/api/media/${itemId}/verify`, headers });
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.json().reason, 'missing_on_kdrive');
  const { rows } = await pool.query('SELECT backup_status, backup_error FROM media_items WHERE id = $1', [itemId]);
  assert.equal(rows[0].backup_status, 'pending');
  assert.equal(rows[0].backup_error, 'missing_on_kdrive');
});

test('upload with an empty body leaves the item untouched', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const sourceId = await createSource(userId);
  const itemId = await createItem(sourceId);
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/media/${itemId}/upload`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.alloc(0),
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'empty_body');

  const { rows } = await pool.query(
    'SELECT backup_status, backup_attempts, kdrive_file_id FROM media_items WHERE id = $1',
    [itemId],
  );
  assert.equal(rows[0].backup_status, 'none');
  assert.equal(rows[0].backup_attempts, 0);
  assert.equal(rows[0].kdrive_file_id, null);
});

test('backup runs are created and patched', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });
  const headers = { authorization: `Bearer ${token}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/backup/runs',
    headers,
    payload: { kind: 'verify' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const runId = created.json().run.id;

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/backup/runs/${runId}`,
    headers,
    payload: { status: 'completed', verified_ok: 5, verified_missing: 1 },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().run.status, 'completed');
  assert.equal(patched.json().run.verified_ok, 5);
  assert.ok(patched.json().run.finished_at);
});

test('pending queue claims items and releases stale uploads', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const sourceId = await createSource(userId);
  const freshId = await createItem(sourceId, { status: 'none' });
  const staleId = await createItem(sourceId, { status: 'none' });
  await pool.query(
    `UPDATE media_items
     SET backup_status = 'uploading', updated_at = now() - interval '3 hours'
     WHERE id = $1`,
    [staleId],
  );
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });
  const headers = { authorization: `Bearer ${token}` };

  const first = await app.inject({ method: 'GET', url: '/api/backup/pending', headers });
  assert.equal(first.statusCode, 200, first.body);
  const claimed = first.json().items;
  assert.equal(claimed.length, 2);
  assert.ok(claimed.every((item) => item.backup_status === 'uploading'));
  const staleItem = claimed.find((item) => item.id === staleId);
  assert.equal(staleItem.backup_error, 'stale_upload');
  assert.ok(claimed.some((item) => item.id === freshId));

  const second = await app.inject({ method: 'GET', url: '/api/backup/pending', headers });
  assert.equal(second.json().items.length, 0);

  const status = await app.inject({ method: 'GET', url: '/api/backup/status', headers });
  const entry = status.json().sources.find((source) => source.id === sourceId);
  assert.equal(entry.pending, 2);
  assert.equal(entry.uploaded, 0);
});

test('auto backup can be enabled per source', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });
  const headers = { authorization: `Bearer ${token}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/sources',
    headers,
    payload: { kind: 'local', label: 'Camera', root_path: 'album:1', auto_backup: true },
  });
  assert.equal(created.statusCode, 201, created.body);
  const sourceId = created.json().source.id;
  assert.equal(created.json().source.auto_backup, true);
  assert.ok(created.json().source.backup_enabled_at);

  const off = await app.inject({
    method: 'PATCH',
    url: `/api/sources/${sourceId}`,
    headers,
    payload: { auto_backup: false },
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().source.auto_backup, false);
  assert.equal(off.json().source.backup_enabled_at, null);

  const on = await app.inject({
    method: 'PATCH',
    url: `/api/sources/${sourceId}`,
    headers,
    payload: { auto_backup: true },
  });
  assert.equal(on.json().source.auto_backup, true);
  assert.ok(on.json().source.backup_enabled_at);

  const renamed = await app.inject({
    method: 'PATCH',
    url: `/api/sources/${sourceId}`,
    headers,
    payload: { label: 'Camera 2' },
  });
  assert.equal(renamed.json().source.label, 'Camera 2');
  assert.equal(renamed.json().source.auto_backup, true);
});

test('completed backup runs update the source last run time', { skip }, async (t) => {
  const { userId, token } = await createUser();
  const backupSourceId = await createSource(userId, { label: 'Camera' });
  const verifySourceId = await createSource(userId, { label: 'Downloads' });
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });
  const headers = { authorization: `Bearer ${token}` };

  const backupRun = await app.inject({
    method: 'POST',
    url: '/api/backup/runs',
    headers,
    payload: { kind: 'backup', source_id: backupSourceId },
  });
  assert.equal(backupRun.statusCode, 201, backupRun.body);
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/backup/runs/${backupRun.json().run.id}`,
    headers,
    payload: { status: 'completed', files_uploaded: 1 },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const { rows } = await pool.query(
    'SELECT backup_last_run_at FROM sources WHERE id = $1',
    [backupSourceId],
  );
  assert.ok(rows[0].backup_last_run_at);

  const verifyRun = await app.inject({
    method: 'POST',
    url: '/api/backup/runs',
    headers,
    payload: { kind: 'verify', source_id: verifySourceId },
  });
  await app.inject({
    method: 'PATCH',
    url: `/api/backup/runs/${verifyRun.json().run.id}`,
    headers,
    payload: { status: 'completed', verified_ok: 1 },
  });
  const { rows: verifyRows } = await pool.query(
    'SELECT backup_last_run_at FROM sources WHERE id = $1',
    [verifySourceId],
  );
  assert.equal(verifyRows[0].backup_last_run_at, null);
});
