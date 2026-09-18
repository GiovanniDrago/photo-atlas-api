import { query } from '../db.js';
import { config } from '../config.js';
import { passwordPolicyError } from '../lib/passwords.js';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../lib/recovery-codes.js';
import { recordAuthEvent } from '../lib/supabase-auth.js';
import * as gotrue from '../lib/gotrue.js';

const RECOVERY_CODE_COUNT = 8;

function publicUser(profile, authUser) {
  const metadata = authUser?.user_metadata ?? {};
  return {
    id: profile.id,
    email: profile.email ?? authUser?.email ?? null,
    display_name: profile.display_name ?? metadata.display_name ?? null,
    mfa_enabled: Boolean(profile.mfa_enabled),
    created_at: profile.created_at,
  };
}

async function refreshProfile(userId) {
  const { rows } = await query('SELECT * FROM profiles WHERE id = $1', [userId]);
  const profile = rows[0];
  try {
    const authUser = await gotrue.adminGetUser(userId);
    const mfaEnabled = gotrue.verifiedFactors(authUser).length > 0;
    const email = authUser?.email ?? profile?.email ?? null;
    const displayName = authUser?.user_metadata?.display_name ?? profile?.display_name ?? null;
    const { rows: updated } = await query(
      `INSERT INTO profiles (id, email, display_name, mfa_enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, profiles.email),
         display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
         mfa_enabled = EXCLUDED.mfa_enabled,
         updated_at = now()
       RETURNING *`,
      [userId, email, displayName, mfaEnabled],
    );
    return { profile: updated[0], authUser };
  } catch (error) {
    if (!profile) throw error;
    return { profile, authUser: null };
  }
}

async function issueRecoveryCodes(userId, table) {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  for (const code of codes) {
    await query(`INSERT INTO ${table} (user_id, code_hash) VALUES ($1, $2)`, [
      userId,
      hashRecoveryCode(code),
    ]);
  }
  return codes;
}

async function consumeRecoveryCode(userId, table, code) {
  const { rows } = await query(
    `SELECT id, code_hash FROM ${table} WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at ASC`,
    [userId],
  );
  for (const row of rows) {
    if (verifyRecoveryCode(code, row.code_hash)) {
      await query(`UPDATE ${table} SET used_at = now() WHERE id = $1`, [row.id]);
      return true;
    }
  }
  return false;
}

export default async function authRoutes(app) {
  app.get('/api/config', async () => ({
    supabase_url: config.supabaseUrl,
    supabase_publishable_key: config.supabasePublishableKey,
    email_confirm_redirect_url: config.emailConfirmRedirectUrl || null,
  }));

  app.get('/api/auth/me', async (request) => {
    const { profile, authUser } = await refreshProfile(request.user.id);
    return { user: publicUser(profile, authUser) };
  });

  app.post('/api/auth/mfa/sync', async (request) => {
    const { profile, authUser } = await refreshProfile(request.user.id);
    return { user: publicUser(profile, authUser) };
  });

  app.get('/api/auth/recovery-codes', async (request) => {
    const { rows } = await query(
      `SELECT
         count(*) FILTER (WHERE used_at IS NULL) AS password_remaining
       FROM password_recovery_codes WHERE user_id = $1`,
      [request.user.id],
    );
    const { rows: mfaRows } = await query(
      `SELECT count(*) FILTER (WHERE used_at IS NULL) AS mfa_remaining
       FROM mfa_recovery_codes WHERE user_id = $1`,
      [request.user.id],
    );
    return {
      password_remaining: Number(rows[0]?.password_remaining ?? 0),
      mfa_remaining: Number(mfaRows[0]?.mfa_remaining ?? 0),
    };
  });

  app.post(
    '/api/auth/recovery-codes',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { kind } = request.body ?? {};
      const table =
        kind === 'mfa'
          ? 'mfa_recovery_codes'
          : kind === 'password' || kind === undefined
            ? 'password_recovery_codes'
            : null;
      if (!table) {
        return reply.code(400).send({ error: "kind must be 'password' or 'mfa'" });
      }
      const codes = await issueRecoveryCodes(request.user.id, table);
      await recordAuthEvent(request.user.id, `recovery_codes_regenerated:${kind ?? 'password'}`, request);
      return { recovery_codes: codes };
    },
  );

  app.post(
    '/api/auth/password/reset-with-code',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { identifier, email, recovery_code: recoveryCode, code, new_password: newPassword } =
        request.body ?? {};
      const value = String(identifier ?? email ?? '').trim();
      const submittedCode = recoveryCode ?? code;
      if (value.length === 0 || typeof submittedCode !== 'string') {
        return reply.code(400).send({ error: 'identifier and recovery_code are required' });
      }
      const policyError = passwordPolicyError(newPassword, { email: value });
      if (policyError) {
        return reply.code(400).send({ error: policyError });
      }
      const authUser = await gotrue.adminFindUserByEmail(value);
      if (!authUser) {
        await recordAuthEvent(null, 'password_reset_failed', request);
        return reply.code(400).send({ error: 'invalid_recovery_code' });
      }
      const consumed = await consumeRecoveryCode(
        authUser.id,
        'password_recovery_codes',
        submittedCode,
      );
      if (!consumed) {
        await recordAuthEvent(authUser.id, 'password_reset_failed', request);
        return reply.code(400).send({ error: 'invalid_recovery_code' });
      }
      await gotrue.adminUpdateUser(authUser.id, { password: newPassword });
      try {
        await gotrue.adminSignOutUser(authUser.id);
      } catch {
        // Older GoTrue deployments may not expose the admin sign-out route.
      }
      await recordAuthEvent(authUser.id, 'password_reset', request);
      return { ok: true };
    },
  );

  app.post(
    '/api/auth/mfa/recovery',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { identifier, email, recovery_code: recoveryCode, code } = request.body ?? {};
      const value = String(identifier ?? email ?? '').trim();
      const submittedCode = recoveryCode ?? code;
      if (value.length === 0 || typeof submittedCode !== 'string') {
        return reply.code(400).send({ error: 'identifier and recovery_code are required' });
      }
      const authUser = await gotrue.adminFindUserByEmail(value);
      if (!authUser) {
        await recordAuthEvent(null, 'mfa_recovery_failed', request);
        return reply.code(400).send({ error: 'invalid_recovery_code' });
      }
      const consumed = await consumeRecoveryCode(authUser.id, 'mfa_recovery_codes', submittedCode);
      if (!consumed) {
        await recordAuthEvent(authUser.id, 'mfa_recovery_failed', request);
        return reply.code(400).send({ error: 'invalid_recovery_code' });
      }
      for (const factor of gotrue.verifiedFactors(authUser)) {
        await gotrue.adminDeleteFactor(authUser.id, factor.id);
      }
      await query('UPDATE profiles SET mfa_enabled = false, updated_at = now() WHERE id = $1', [
        authUser.id,
      ]);
      await recordAuthEvent(authUser.id, 'mfa_factor_reset', request);
      return { ok: true };
    },
  );
}
