import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import albumRoutes from '../src/routes/albums.js';
import { registerAuthHook } from '../src/lib/supabase-auth.js';
import { startJwksServer, startFakeGoTrue, signToken } from './helpers/supabase-test-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'TEST_DATABASE_URL is not set';
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

let jwks;
let fakeGoTrue;
let pool;

test.before(async () => {
  jwks = await startJwksServer();
  fakeGoTrue = await startFakeGoTrue();
  if (databaseUrl) pool = new pg.Pool({ connectionString: databaseUrl });
});

test.after(async () => {
  await jwks?.close();
  await fakeGoTrue?.close();
  await pool?.end();
});

async function buildApp() {
  const app = Fastify();
  registerAuthHook(app);
  await app.register(albumRoutes);
  return app;
}

async function createUser() {
  const email = `album_${crypto.randomBytes(4).toString('hex')}@example.com`;
  const { rows } = await pool.query(
    'INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id',
    [email],
  );
  const userId = rows[0].id;
  const token = await signToken({
    sub: userId,
    email,
    privateKey: jwks.privateKey,
    kid: jwks.kid,
  });
  return { userId, email, token };
}

async function createSource(userId, label = 'Camera') {
  const { rows } = await pool.query(
    `INSERT INTO sources (kind, label, root_path, owner_id)
     VALUES ('local', $1, 'album:camera', $2) RETURNING id`,
    [label, userId],
  );
  return rows[0].id;
}

async function createItem(
  sourceId,
  {
    name = 'IMG_0001.jpg',
    mediaType = 'image',
    takenAt = null,
    backedUpAt = null,
    lat = null,
    lon = null,
  } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO media_items
       (source_id, external_key, name, mime, media_type, size_bytes, backup_status,
        taken_at, backed_up_at, lat, lon)
     VALUES ($1, $2, $3, $4, $5, 10, $6, $7, $8, $9, $10) RETURNING id`,
    [
      sourceId,
      `asset:${crypto.randomBytes(6).toString('hex')}`,
      name,
      mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      mediaType,
      backedUpAt == null ? 'pending' : 'uploaded',
      takenAt,
      backedUpAt,
      lat,
      lon,
    ],
  );
  return rows[0].id;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM auth.users WHERE id = $1', [userId]);
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

test('manual album: create from selection, list, add, remove, cover, rename, delete', { skip }, async (t) => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  t.after(async () => {
    await cleanupUser(userId);
    await app.close();
  });
  const sourceId = await createSource(userId);
  const first = await createItem(sourceId, { name: 'a.jpg', takenAt: '2024-05-01T10:00:00Z' });
  const second = await createItem(sourceId, { name: 'b.jpg', takenAt: '2024-06-01T10:00:00Z' });

  const created = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: { name: '  Viaggio  ', media_ids: [first, second] },
  });
  assert.equal(created.statusCode, 201);
  const album = created.json().album;
  assert.equal(album.name, 'Viaggio');
  assert.equal(album.kind, 'manual');
  assert.equal(album.item_count, 2);
  assert.ok(album.cover);
  assert.equal(album.cover.name, 'b.jpg');
  assert.ok(album.cover.thumbnail_url);

  const list = await app.inject({ method: 'GET', url: '/api/albums', headers: auth(token) });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().albums.length, 1);
  assert.equal(list.json().albums[0].item_count, 2);

  const third = await createItem(sourceId, { name: 'c.jpg', takenAt: '2024-07-01T10:00:00Z' });
  const added = await app.inject({
    method: 'POST',
    url: `/api/albums/${album.id}/items`,
    headers: auth(token),
    payload: { media_ids: [third] },
  });
  assert.equal(added.statusCode, 200);
  assert.deepEqual(added.json(), { added: 1, skipped: 0 });

  const media = await app.inject({
    method: 'GET',
    url: `/api/albums/${album.id}/media?limit=2&offset=0`,
    headers: auth(token),
  });
  assert.equal(media.statusCode, 200);
  const page = media.json();
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items.map((item) => item.name), ['c.jpg', 'b.jpg']);

  const secondPage = await app.inject({
    method: 'GET',
    url: `/api/albums/${album.id}/media?limit=2&offset=2`,
    headers: auth(token),
  });
  assert.deepEqual(secondPage.json().items.map((item) => item.name), ['a.jpg']);

  const cover = await app.inject({
    method: 'PATCH',
    url: `/api/albums/${album.id}`,
    headers: auth(token),
    payload: { name: 'Viaggio 2024', cover_media_id: first },
  });
  assert.equal(cover.statusCode, 200, JSON.stringify(cover.json()));
  assert.equal(cover.json().album.name, 'Viaggio 2024');
  assert.equal(cover.json().album.cover_media_id, first);
  assert.equal(cover.json().album.cover.name, 'a.jpg');

  const cleared = await app.inject({
    method: 'PATCH',
    url: `/api/albums/${album.id}`,
    headers: auth(token),
    payload: { clear_cover: true },
  });
  assert.equal(cleared.json().album.cover_media_id, null);
  assert.equal(cleared.json().album.cover.name, 'c.jpg');

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/albums/${album.id}/items`,
    headers: auth(token),
    payload: { media_ids: [third] },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().removed, 1);
  const afterRemove = await app.inject({
    method: 'GET',
    url: `/api/albums/${album.id}/media`,
    headers: auth(token),
  });
  assert.equal(afterRemove.json().total, 2);

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/albums/${album.id}`,
    headers: auth(token),
  });
  assert.equal(deleted.statusCode, 204);
  const empty = await app.inject({ method: 'GET', url: '/api/albums', headers: auth(token) });
  assert.deepEqual(empty.json().albums, []);
});

test('smart albums resolve date, upload date, type and radius rules', { skip }, async (t) => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  t.after(async () => {
    await cleanupUser(userId);
    await app.close();
  });
  const sourceId = await createSource(userId);
  const near = await createItem(sourceId, {
    name: 'near.jpg',
    takenAt: '2024-06-15T10:00:00Z',
    backedUpAt: '2025-01-10T10:00:00Z',
    lat: 45.07,
    lon: 7.68,
  });
  await createItem(sourceId, {
    name: 'far.jpg',
    takenAt: '2024-06-15T10:00:00Z',
    backedUpAt: '2025-01-10T10:00:00Z',
    lat: 41.9,
    lon: 12.5,
  });
  await createItem(sourceId, {
    name: 'old.jpg',
    takenAt: '2022-01-01T10:00:00Z',
    backedUpAt: '2025-01-10T10:00:00Z',
  });
  const video = await createItem(sourceId, {
    name: 'clip.mp4',
    mediaType: 'video',
    takenAt: '2024-06-20T10:00:00Z',
    backedUpAt: '2025-01-11T10:00:00Z',
    lat: 45.08,
    lon: 7.69,
  });

  const rules = {
    all: [
      { field: 'taken_at', op: 'between', value: ['2024-01-01', '2024-12-31'] },
      { field: 'backed_up_at', op: 'gte', value: '2025-01-01' },
      { field: 'location', op: 'within', value: { lat: 45.07, lon: 7.68, radius_m: 5000 } },
    ],
  };
  const preview = await app.inject({
    method: 'POST',
    url: '/api/albums/preview',
    headers: auth(token),
    payload: { rules },
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().total, 2);
  assert.equal(near, near);

  const created = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: { name: 'Qui nel 2024', kind: 'smart', rules },
  });
  assert.equal(created.statusCode, 201);
  const album = created.json().album;
  assert.equal(album.kind, 'smart');
  assert.equal(album.item_count, 2);
  assert.ok(album.cover);

  const onlyVideos = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: {
      name: 'Video',
      kind: 'smart',
      rules: { all: [{ field: 'media_type', op: 'eq', value: 'video' }] },
    },
  });
  assert.equal(onlyVideos.statusCode, 201);
  assert.equal(onlyVideos.json().album.item_count, 1);
  const videos = await app.inject({
    method: 'GET',
    url: `/api/albums/${onlyVideos.json().album.id}/media`,
    headers: auth(token),
  });
  assert.deepEqual(videos.json().items.map((item) => item.id), [video]);

  const notManual = await app.inject({
    method: 'POST',
    url: `/api/albums/${album.id}/items`,
    headers: auth(token),
    payload: { media_ids: [near] },
  });
  assert.equal(notManual.statusCode, 400);
  assert.equal(notManual.json().error, 'album_is_smart');

  const badRules = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: { name: 'Nope', kind: 'smart', rules: { all: [{ field: 'nope', op: 'eq' }] } },
  });
  assert.equal(badRules.statusCode, 400);

  const emptyRules = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: { name: 'Nope', kind: 'smart', rules: {} },
  });
  assert.equal(emptyRules.statusCode, 400);
  assert.equal(emptyRules.json().error, 'rules_required');

  const editRules = await app.inject({
    method: 'PATCH',
    url: `/api/albums/${album.id}`,
    headers: auth(token),
    payload: { rules: { all: [{ field: 'name', op: 'contains', value: 'clip' }] } },
  });
  assert.equal(editRules.statusCode, 200, JSON.stringify(editRules.json()));
  assert.equal(editRules.json().album.item_count, 1);
});

test('albums are isolated between users', { skip }, async (t) => {
  const app = await buildApp();
  const owner = await createUser();
  const stranger = await createUser();
  t.after(async () => {
    await cleanupUser(owner.userId);
    await cleanupUser(stranger.userId);
    await app.close();
  });
  const sourceId = await createSource(owner.userId);
  const mediaId = await createItem(sourceId, { name: 'owned.jpg' });
  const albumResponse = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(owner.token),
    payload: { name: 'Privato', media_ids: [mediaId] },
  });
  const albumId = albumResponse.json().album.id;

  const list = await app.inject({
    method: 'GET',
    url: '/api/albums',
    headers: auth(stranger.token),
  });
  assert.deepEqual(list.json().albums, []);

  for (const request of [
    { method: 'GET', url: `/api/albums/${albumId}/media` },
    { method: 'PATCH', url: `/api/albums/${albumId}`, payload: { name: 'Rubato' } },
    { method: 'DELETE', url: `/api/albums/${albumId}` },
    { method: 'POST', url: `/api/albums/${albumId}/items`, payload: { media_ids: [mediaId] } },
  ]) {
    const response = await app.inject({
      ...request,
      headers: auth(stranger.token),
    });
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
  }

  const strangerSource = await createSource(stranger.userId, 'Download');
  const strangerAlbum = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(stranger.token),
    payload: { name: 'Mio' },
  });
  const strangerAlbumId = strangerAlbum.json().album.id;
  const addForeign = await app.inject({
    method: 'POST',
    url: `/api/albums/${strangerAlbumId}/items`,
    headers: auth(stranger.token),
    payload: { media_ids: [mediaId] },
  });
  assert.equal(addForeign.statusCode, 200);
  assert.deepEqual(addForeign.json(), { added: 0, skipped: 1 });

  const coverForeign = await app.inject({
    method: 'PATCH',
    url: `/api/albums/${strangerAlbumId}`,
    headers: auth(stranger.token),
    payload: { cover_media_id: mediaId },
  });
  assert.equal(coverForeign.statusCode, 400);
  assert.equal(coverForeign.json().error, 'cover_media_id not found');
  assert.ok(strangerSource);
});

test('album input validation', { skip }, async (t) => {
  const app = await buildApp();
  const { userId, token } = await createUser();
  t.after(async () => {
    await cleanupUser(userId);
    await app.close();
  });
  const noName = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: { name: '   ' },
  });
  assert.equal(noName.statusCode, 400);

  const badKind = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: { name: 'X', kind: 'group' },
  });
  assert.equal(badKind.statusCode, 400);

  const badIds = await app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: auth(token),
    payload: { name: 'X', media_ids: ['not-a-uuid'] },
  });
  assert.equal(badIds.statusCode, 400);

  const badOwner = await app.inject({
    method: 'GET',
    url: '/api/albums/not-a-uuid/media',
    headers: auth(token),
  });
  assert.equal(badOwner.statusCode, 400);

  const missing = await app.inject({
    method: 'PATCH',
    url: '/api/albums/3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    headers: auth(token),
    payload: { name: 'X' },
  });
  assert.equal(missing.statusCode, 404);
});
