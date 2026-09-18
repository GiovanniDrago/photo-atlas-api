import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { hashPassword, verifyPassword, passwordPolicyError } from '../src/lib/passwords.js';
import { registerAuthHook } from '../src/lib/auth.js';
import { generateTotp } from '../src/lib/totp.js';
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

test('password policy requires length, email-free and non-common values', () => {
  assert.match(passwordPolicyError('short'), /at least 10/);
  assert.match(passwordPolicyError('x'.repeat(201)), /at most 200/);
  assert.match(passwordPolicyError('alice-secret-pw', { email: 'alice@example.com' }), /email/);
  assert.match(passwordPolicyError('password123', {}), /too common/);
  assert.equal(passwordPolicyError('correct-horse-battery', { email: 'alice@example.com' }), null);
});

test('change password requires the current one and revokes other sessions', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `carol_${suffix}@example.com`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(email) = lower($1)', [email]);
    await pool.end();
  });
  const app = Fastify();
  registerAuthHook(app);
  await app.register(authRoutes);
  t.after(async () => app.close());

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'oldpw-12345' },
  });
  assert.equal(register.statusCode, 201);
  const token = register.json().token;

  const wrong = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { authorization: `Bearer ${token}` },
    payload: { current_password: 'nope-12345', new_password: 'newpw-12345' },
  });
  assert.equal(wrong.statusCode, 403);

  const weak = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { authorization: `Bearer ${token}` },
    payload: { current_password: 'oldpw-12345', new_password: 'short' },
  });
  assert.equal(weak.statusCode, 400);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { authorization: `Bearer ${token}` },
    payload: { current_password: 'oldpw-12345', new_password: 'newpw-12345' },
  });
  assert.equal(ok.statusCode, 200);

  const oldLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password: 'oldpw-12345' },
  });
  assert.equal(oldLogin.statusCode, 401);

  const newLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password: 'newpw-12345' },
  });
  assert.equal(newLogin.statusCode, 200);
});

test('register, login, me, logout and data isolation', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const emailA = `alice_${suffix}@example.com`;
  const emailB = `bob_${suffix}@example.com`;

  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(email) IN (lower($1), lower($2))', [emailA, emailB]);
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
    payload: { email: emailA, password: 'alice-pw-1234' },
  });
  assert.equal(registerA.statusCode, 201);
  const tokenA = registerA.json().token;
  assert.ok(tokenA);
  assert.equal(registerA.json().user.email, emailA);
  assert.equal(registerA.json().recovery_codes.password.length, 8);
  assert.equal(registerA.json().recovery_codes.mfa.length, 8);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: emailA.toUpperCase(), password: 'alice-pw-1234' },
  });
  assert.equal(duplicate.statusCode, 409);

  const badEmail = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'not-an-email', password: 'alice-pw-1234' },
  });
  assert.equal(badEmail.statusCode, 400);

  const badLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: emailA, password: 'nope-1234' },
  });
  assert.equal(badLogin.statusCode, 401);

  const loginA = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: emailA, password: 'alice-pw-1234' },
  });
  assert.equal(loginA.statusCode, 200);
  assert.equal(loginA.json().mfa_required, false);
  const sessionToken = loginA.json().token;

  const username = registerA.json().user.username;
  const loginByUsername = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: username, password: 'alice-pw-1234' },
  });
  assert.equal(loginByUsername.statusCode, 200);

  const unauth = await app.inject({ method: 'GET', url: '/api/sources' });
  assert.equal(unauth.statusCode, 401);

  const me = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, emailA);

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
    payload: { email: emailB, password: 'bob-pw-123456' },
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

test('MFA setup, login challenge, TOTP and recovery code verification', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `mfa_${suffix}@example.com`;
  const password = 'mfa-password-1234';
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(email) = lower($1)', [email]);
    await pool.end();
  });
  const app = Fastify();
  registerAuthHook(app);
  await app.register(authRoutes);
  t.after(async () => app.close());

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password },
  });
  assert.equal(register.statusCode, 201);
  const token = register.json().token;

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/setup',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(setup.statusCode, 200);
  const { secret, otpauth_uri: uri } = setup.json();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.match(uri, /^otpauth:\/\/totp\//);

  const badEnable = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/enable',
    headers: { authorization: `Bearer ${token}` },
    payload: { code: '000000' },
  });
  assert.equal(badEnable.statusCode, 401);

  const enable = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/enable',
    headers: { authorization: `Bearer ${token}` },
    payload: { code: generateTotp(secret) },
  });
  assert.equal(enable.statusCode, 200);
  assert.equal(enable.json().user.mfa_enabled, true);
  const mfaCodes = enable.json().recovery_codes;
  assert.equal(mfaCodes.length, 8);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfa_required, true);
  const pendingToken = login.json().token;

  const blocked = await app.inject({
    method: 'GET',
    url: '/api/sources',
    headers: { authorization: `Bearer ${pendingToken}` },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'mfa_required');

  const wrongCode = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verify',
    headers: { authorization: `Bearer ${pendingToken}` },
    payload: { code: '123456' },
  });
  assert.equal(wrongCode.statusCode, 401);

  const verify = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verify',
    headers: { authorization: `Bearer ${pendingToken}` },
    payload: { code: generateTotp(secret) },
  });
  assert.equal(verify.statusCode, 200);

  const meAfterVerify = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${pendingToken}` },
  });
  assert.equal(meAfterVerify.statusCode, 200);

  const loginAgain = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password },
  });
  const recoveryToken = loginAgain.json().token;
  const recoveryVerify = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verify',
    headers: { authorization: `Bearer ${recoveryToken}` },
    payload: { code: mfaCodes[0] },
  });
  assert.equal(recoveryVerify.statusCode, 200);

  const reuseCode = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password },
  });
  const reuseVerify = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verify',
    headers: { authorization: `Bearer ${reuseCode.json().token}` },
    payload: { code: mfaCodes[0] },
  });
  assert.equal(reuseVerify.statusCode, 401);

  const disableWithoutPassword = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/disable',
    headers: { authorization: `Bearer ${recoveryToken}` },
    payload: { password: 'wrong-password-1' },
  });
  assert.equal(disableWithoutPassword.statusCode, 403);

  const disable = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/disable',
    headers: { authorization: `Bearer ${recoveryToken}` },
    payload: { password },
  });
  assert.equal(disable.statusCode, 200);
});

test('password reset with a recovery code revokes sessions and consumes the code', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `reset_${suffix}@example.com`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(email) = lower($1)', [email]);
    await pool.end();
  });
  const app = Fastify();
  registerAuthHook(app);
  await app.register(authRoutes);
  t.after(async () => app.close());

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'reset-password-1' },
  });
  assert.equal(register.statusCode, 201);
  const token = register.json().token;
  const code = register.json().recovery_codes.password[0];

  const badCode = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: { identifier: email, recovery_code: 'WRNG-WRNG', new_password: 'brand-new-pass-1' },
  });
  assert.equal(badCode.statusCode, 400);

  const reset = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: { identifier: email, recovery_code: code, new_password: 'brand-new-pass-1' },
  });
  assert.equal(reset.statusCode, 200);

  const meAfterReset = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(meAfterReset.statusCode, 401);

  const reuse = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: { identifier: email, recovery_code: code, new_password: 'another-new-pass-1' },
  });
  assert.equal(reuse.statusCode, 400);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password: 'brand-new-pass-1' },
  });
  assert.equal(login.statusCode, 200);
});

test('sessions are listed and can be revoked', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `sessions_${suffix}@example.com`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(email) = lower($1)', [email]);
    await pool.end();
  });
  const app = Fastify();
  registerAuthHook(app);
  await app.register(authRoutes);
  t.after(async () => app.close());

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'sessions-pass-1' },
  });
  const firstToken = register.json().token;
  const second = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password: 'sessions-pass-1' },
  });
  const secondToken = second.json().token;

  const list = await app.inject({
    method: 'GET',
    url: '/api/auth/sessions',
    headers: { authorization: `Bearer ${secondToken}` },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().sessions.length, 2);
  assert.equal(list.json().sessions.filter((session) => session.current).length, 1);

  const other = list.json().sessions.find((session) => !session.current);
  const revoke = await app.inject({
    method: 'DELETE',
    url: `/api/auth/sessions/${other.id}`,
    headers: { authorization: `Bearer ${secondToken}` },
  });
  assert.equal(revoke.statusCode, 200);

  const revokedUse = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${firstToken}` },
  });
  assert.equal(revokedUse.statusCode, 401);

  const revokeAll = await app.inject({
    method: 'DELETE',
    url: '/api/auth/sessions',
    headers: { authorization: `Bearer ${secondToken}` },
  });
  assert.equal(revokeAll.statusCode, 200);
});

test('login locks the account after repeated failures', { skip }, async (t) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `lock_${suffix}@example.com`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query('DELETE FROM users WHERE lower(email) = lower($1)', [email]);
    await pool.end();
  });
  const app = Fastify();
  registerAuthHook(app);
  await app.register(authRoutes);
  t.after(async () => app.close());

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'lock-password-1' },
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: email, password: 'wrong-password-1' },
    });
    assert.equal(response.statusCode, 401);
  }
  const locked = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: email, password: 'lock-password-1' },
  });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error, 'too_many_attempts');
});
