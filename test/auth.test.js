import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import authRoutes from '../src/routes/auth.js';
import { registerAuthHook } from '../src/lib/supabase-auth.js';
import { hashRecoveryCode } from '../src/lib/recovery-codes.js';
import { startJwksServer, startFakeGoTrue, signToken } from './helpers/supabase-test-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'TEST_DATABASE_URL is not set';
// Route handlers use the shared pool; point it at the throwaway test database.
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
  await app.register(authRoutes);
  return app;
}

async function createAuthUser(email) {
  const { rows } = await pool.query(
    'INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id',
    [email],
  );
  return rows[0].id;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM auth_events WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM auth.users WHERE id = $1', [userId]);
}

function uniqueEmail(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}@example.com`;
}

async function tokenFor(userId, email, extra = {}) {
  return signToken({ sub: userId, email, privateKey: jwks.privateKey, kid: jwks.kid, ...extra });
}

test('config endpoint exposes the public Supabase settings', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok('supabase_url' in body);
  assert.ok('supabase_publishable_key' in body);
  assert.ok('email_confirm_redirect_url' in body);
});

test('protected routes reject missing, invalid and non-user tokens', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const missing = await app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(missing.statusCode, 401);

  const garbage = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: 'Bearer not-a-token' },
  });
  assert.equal(garbage.statusCode, 401);

  const userId = crypto.randomUUID();
  const serviceToken = await tokenFor(userId, 'service@example.com', { audience: 'service_role' });
  const wrongAudience = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(wrongAudience.statusCode, 401);

  const wrongIssuer = await tokenFor(userId, 'issuer@example.com', {
    issuer: 'https://someone-else.supabase.co/auth/v1',
  });
  const badIssuer = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${wrongIssuer}` },
  });
  assert.equal(badIssuer.statusCode, 401);

  const expired = await tokenFor(userId, 'expired@example.com', { expiresIn: '-1h' });
  const expiredResponse = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${expired}` },
  });
  assert.equal(expiredResponse.statusCode, 401);
});

test('me creates the profile from token metadata', { skip }, async (t) => {
  const email = uniqueEmail('me');
  const userId = await createAuthUser(email);
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const token = await tokenFor(userId, email, {
    userMetadata: { display_name: 'Alice' },
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  const user = response.json().user;
  assert.equal(user.id, userId);
  assert.equal(user.email, email);
  assert.equal(user.display_name, 'Alice');
  assert.equal(user.mfa_enabled, false);
});

test('mfa enforcement requires aal2 when the profile has MFA enabled', { skip }, async (t) => {
  const email = uniqueEmail('aal');
  const userId = await createAuthUser(email);
  fakeGoTrue.state.users.set(userId, {
    id: userId,
    email,
    factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
  });
  await pool.query(
    `INSERT INTO profiles (id, email, mfa_enabled) VALUES ($1, $2, true)
     ON CONFLICT (id) DO UPDATE SET mfa_enabled = true`,
    [userId, email],
  );
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const aal1 = await tokenFor(userId, email, { aal: 'aal1' });
  const blocked = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${aal1}` },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'mfa_required');

  const aal2 = await tokenFor(userId, email, { aal: 'aal2' });
  const allowed = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${aal2}` },
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

test('mfa sync mirrors verified Supabase factors into the profile', { skip }, async (t) => {
  const email = uniqueEmail('sync');
  const userId = await createAuthUser(email);
  fakeGoTrue.state.users.set(userId, {
    id: userId,
    email,
    factors: [{ id: 'factor-9', factor_type: 'totp', status: 'verified' }],
  });
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const token = await tokenFor(userId, email, { aal: 'aal2' });
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/sync',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().user.mfa_enabled, true);

  const { rows } = await pool.query('SELECT mfa_enabled FROM profiles WHERE id = $1', [userId]);
  assert.equal(rows[0].mfa_enabled, true);
});

test('recovery codes regenerate and reset the Supabase password once', { skip }, async (t) => {
  const email = uniqueEmail('reset');
  const userId = await createAuthUser(email);
  fakeGoTrue.state.users.set(userId, { id: userId, email, factors: [] });
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const token = await tokenFor(userId, email);
  const codesResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/recovery-codes',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(codesResponse.statusCode, 200, codesResponse.body);
  const codes = codesResponse.json().recovery_codes;
  assert.equal(codes.length, 8);

  const counts = await app.inject({
    method: 'GET',
    url: '/api/auth/recovery-codes',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(counts.statusCode, 200, counts.body);
  assert.equal(counts.json().password_remaining, 8);
  assert.equal(counts.json().mfa_remaining, 0);

  const mfaCodes = await app.inject({
    method: 'POST',
    url: '/api/auth/recovery-codes',
    headers: { authorization: `Bearer ${token}` },
    payload: { kind: 'mfa' },
  });
  assert.equal(mfaCodes.statusCode, 200, mfaCodes.body);
  assert.equal(mfaCodes.json().recovery_codes.length, 8);

  const invalidKind = await app.inject({
    method: 'POST',
    url: '/api/auth/recovery-codes',
    headers: { authorization: `Bearer ${token}` },
    payload: { kind: 'nope' },
  });
  assert.equal(invalidKind.statusCode, 400);

  const weak = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: { identifier: email, recovery_code: codes[0], new_password: 'short' },
  });
  assert.equal(weak.statusCode, 400);

  const reset = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: {
      identifier: email,
      recovery_code: codes[0],
      new_password: 'brand-new-password-1',
    },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  const update = fakeGoTrue.state.updates.at(-1);
  assert.deepEqual(update, { id: userId, patch: { password: 'brand-new-password-1' } });
  assert.equal(fakeGoTrue.state.signOuts.includes(userId), true);

  const reuse = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: {
      identifier: email,
      recovery_code: codes[0],
      new_password: 'another-password-1',
    },
  });
  assert.equal(reuse.statusCode, 400);

  const badCode = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: { identifier: email, recovery_code: 'WRNG-WRNG', new_password: 'another-password-1' },
  });
  assert.equal(badCode.statusCode, 400);

  const unknown = await app.inject({
    method: 'POST',
    url: '/api/auth/password/reset-with-code',
    payload: {
      identifier: 'nobody@example.com',
      recovery_code: codes[1],
      new_password: 'another-password-1',
    },
  });
  assert.equal(unknown.statusCode, 400);
});

test('mfa recovery removes verified factors and consumes the code', { skip }, async (t) => {
  const email = uniqueEmail('mfarec');
  const userId = await createAuthUser(email);
  fakeGoTrue.state.users.set(userId, {
    id: userId,
    email,
    factors: [
      { id: 'factor-a', factor_type: 'totp', status: 'verified' },
      { id: 'factor-b', factor_type: 'totp', status: 'unverified' },
    ],
  });
  await pool.query(
    `INSERT INTO profiles (id, email, mfa_enabled) VALUES ($1, $2, true)
     ON CONFLICT (id) DO UPDATE SET mfa_enabled = true`,
    [userId, email],
  );
  const code = 'ABCD-EF23';
  await pool.query(
    'INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
    [userId, hashRecoveryCode(code)],
  );
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await cleanupUser(userId);
  });

  const wrong = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/recovery',
    payload: { identifier: email, recovery_code: 'ZZZZ-ZZZZ' },
  });
  assert.equal(wrong.statusCode, 400);

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/recovery',
    payload: { identifier: email, recovery_code: code },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(fakeGoTrue.state.deletedFactors, [
    { userId, factorId: 'factor-a' },
  ]);
  const { rows } = await pool.query('SELECT mfa_enabled FROM profiles WHERE id = $1', [userId]);
  assert.equal(rows[0].mfa_enabled, false);

  const reuse = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/recovery',
    payload: { identifier: email, recovery_code: code },
  });
  assert.equal(reuse.statusCode, 400);
});
