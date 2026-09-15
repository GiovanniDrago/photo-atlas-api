import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { corsOptions } from '../src/lib/cors.js';

async function buildApp() {
  const app = Fastify();
  await app.register(cors, corsOptions);
  app.delete('/api/sources/:id', async () => ({ ok: true }));
  app.patch('/api/sources/:id', async () => ({ ok: true }));
  return app;
}

async function preflight(app, method) {
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/api/sources/00000000-0000-0000-0000-000000000000',
    headers: {
      origin: 'http://10.0.0.5:8080',
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  return response.headers['access-control-allow-methods'] ?? '';
}

test('preflight advertises DELETE for the app', async (t) => {
  const app = await buildApp();
  t.after(async () => app.close());
  const methods = await preflight(app, 'DELETE');
  assert.match(methods, /DELETE/);
});

test('preflight advertises PATCH for the app', async (t) => {
  const app = await buildApp();
  t.after(async () => app.close());
  const methods = await preflight(app, 'PATCH');
  assert.match(methods, /PATCH/);
});
