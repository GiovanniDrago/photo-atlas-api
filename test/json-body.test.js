import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerJsonBodyParser } from '../src/lib/json-body-parser.js';

test('empty JSON body is accepted as an empty object', async (t) => {
  const app = Fastify();
  registerJsonBodyParser(app);
  app.delete('/thing', async (request, reply) => {
    assert.deepEqual(request.body, {});
    return reply.code(204).send();
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'DELETE',
    url: '/thing',
    headers: { 'content-type': 'application/json' },
    payload: '',
  });
  assert.equal(response.statusCode, 204);
});

test('malformed JSON still returns 400', async (t) => {
  const app = Fastify();
  registerJsonBodyParser(app);
  app.post('/thing', async () => ({ ok: true }));
  t.after(async () => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/thing',
    headers: { 'content-type': 'application/json' },
    payload: '{bad',
  });
  assert.equal(response.statusCode, 400);
});
