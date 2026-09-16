import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import mediaRoutes from '../src/routes/media.js';

const ID = '3ea4bde7-8743-4119-9cb7-c89243b922d8';

test('asset endpoints reject requests without a valid signature', async (t) => {
  const app = Fastify();
  await app.register(mediaRoutes);
  t.after(async () => app.close());

  const thumbnail = await app.inject({ method: 'GET', url: `/api/media/${ID}/thumbnail` });
  assert.equal(thumbnail.statusCode, 401);

  const download = await app.inject({ method: 'GET', url: `/api/media/${ID}/download?s=bogus` });
  assert.equal(download.statusCode, 401);

  const invalidId = await app.inject({ method: 'GET', url: '/api/media/not-a-uuid/thumbnail?s=x' });
  assert.equal(invalidId.statusCode, 400);
});
