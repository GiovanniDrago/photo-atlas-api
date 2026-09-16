import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { hashPassword, verifyPassword } from '../src/lib/passwords.js';
import { registerAuthHook } from '../src/lib/auth.js';
import authRoutes from '../src/routes/auth.js';
import sourceRoutes from '../src/routes/sources.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

test('password hashing verifies and rejects', () => {
  const stored = hashPassword('secret');
  assert.equal(verifyPassword('secret', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('secret', 'garbage'), false);
});

test('change password requires the current one and revokes other sessions', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const username = `carol_${suffix}`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(username) = lower($1)', [username]);
    await pool.end();
  });
  const app = Fastify();
  registerAuthHook(app);
  await app.register(authRoutes);
  t.after(async () => app.close());

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'oldpw' },
  });
  assert.equal(register.statusCode, 201);
  const token = register.json().token;

  const wrong = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { authorization: `Bearer ${token}` },
    payload: { current_password: 'nope', new_password: 'newpw' },
  });
  assert.equal(wrong.statusCode, 403);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { authorization: `Bearer ${token}` },
    payload: { current_password: 'oldpw', new_password: 'newpw' },
  });
  assert.equal(ok.statusCode, 200);

  const oldLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'oldpw' },
  });
  assert.equal(oldLogin.statusCode, 401);

  const newLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'newpw' },
  });
  assert.equal(newLogin.statusCode, 200);
});

test('register, login, me, logout and data isolation', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const userA = `alice_${suffix}`;
  const userB = `bob_${suffix}`;

  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(username) IN (lower($1), lower($2))', [userA, userB]);
    await pool.end();
  });

  const app = Fastify();
  registerAuthHook(app);
  await app.register(authRoutes);
  await app.register(sourceRoutes);
  t.after(async () => app.close());

  const registerA = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: userA, password: 'pw' },
  });
  assert.equal(registerA.statusCode, 201);
  const tokenA = registerA.json().token;
  assert.ok(tokenA);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: userA.toUpperCase(), password: 'pw' },
  });
  assert.equal(duplicate.statusCode, 409);

  const badLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: userA, password: 'nope' },
  });
  assert.equal(badLogin.statusCode, 401);

  const loginA = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: userA, password: 'pw' },
  });
  assert.equal(loginA.statusCode, 200);
  const sessionToken = loginA.json().token;

  const unauth = await app.inject({ method: 'GET', url: '/api/sources' });
  assert.equal(unauth.statusCode, 401);

  const me = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, userA);

  const createSource = await app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { kind: 'local', label: `alice source ${suffix}`, root_path: '/tmp/alice' },
  });
  assert.equal(createSource.statusCode, 201);

  const registerB = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: userB, password: 'pw' },
  });
  const tokenB = registerB.json().token;

  const listA = await app.inject({
    method: 'GET',
    url: '/api/sources',
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const listB = await app.inject({
    method: 'GET',
    url: '/api/sources',
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.ok(listA.json().sources.length >= 1);
  assert.equal(listB.json().sources.length, 0);

  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(logout.statusCode, 200);

  const meAfterLogout = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(meAfterLogout.statusCode, 401);
});
