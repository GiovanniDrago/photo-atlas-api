import { query } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, passwordPolicyError } from '../lib/passwords.js';
import { createSession, recordAuthEvent } from '../lib/auth.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { generateTotpSecret, verifyTotp, totpUri } from '../lib/totp.js';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../lib/recovery-codes.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;
const RECOVERY_CODE_COUNT = 8;

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    display_name: row.display_name ?? null,
    mfa_enabled: Boolean(row.mfa_enabled_at),
    created_at: row.created_at,
  };
}

function clientIp(request) {
  return request.ip ?? null;
}

function usernameFromEmail(email) {
  const localPart = String(email).split('@')[0] ?? 'user';
  const sanitized = localPart.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (sanitized.length >= 3) return sanitized.slice(0, 32);
  return `user-${sanitized}`.slice(0, 32);
}

async function uniqueUsername(base) {
  const { rows } = await query('SELECT lower(username) AS name FROM users WHERE lower(username) LIKE $1', [
    `${base.toLowerCase()}%`,
  ]);
  const taken = new Set(rows.map((row) => row.name));
  if (!taken.has(base.toLowerCase())) return base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = Math.random().toString(16).slice(2, 6);
    const candidate = `${base.slice(0, 27)}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 22)}-${Date.now().toString(36)}`;
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

function readMfaSecret(row) {
  if (!row.mfa_secret_cipher || !row.mfa_secret_iv || !row.mfa_secret_tag) return null;
  return decryptSecret(
    { cipher: row.mfa_secret_cipher, iv: row.mfa_secret_iv, tag: row.mfa_secret_tag },
    config.authEncKey,
  );
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
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { email, username, display_name: displayName, password } = request.body ?? {};
      const normalizedEmail = String(email ?? '').trim().toLowerCase();
      if (!EMAIL_PATTERN.test(normalizedEmail)) {
        return reply.code(400).send({ error: 'a valid email is required' });
      }
      const policyError = passwordPolicyError(password, { email: normalizedEmail });
      if (policyError) {
        return reply.code(400).send({ error: policyError });
      }
      const existing = await query('SELECT 1 FROM users WHERE lower(email) = $1', [normalizedEmail]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'email already registered' });
      }
      let handle = username ? String(username).trim() : usernameFromEmail(normalizedEmail);
      if (!USERNAME_PATTERN.test(handle)) {
        return reply
          .code(400)
          .send({ error: 'username must be 3-32 characters (letters, numbers, dot, underscore, dash)' });
      }
      handle = await uniqueUsername(handle);
      const { rows } = await query(
        `INSERT INTO users (username, email, display_name, password_hash, password_updated_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id, username, email, display_name, mfa_enabled_at, created_at`,
        [handle, normalizedEmail, displayName ? String(displayName).trim().slice(0, 80) : null, hashPassword(password)],
      );
      const user = rows[0];
      const [passwordCodes, mfaCodes] = await Promise.all([
        issueRecoveryCodes(user.id, 'password_recovery_codes'),
        issueRecoveryCodes(user.id, 'mfa_recovery_codes'),
      ]);
      const session = await createSession(user.id, {
        userAgent: request.headers['user-agent'],
        ip: clientIp(request),
      });
      await recordAuthEvent(user.id, 'register', request);
      return reply.code(201).send({
        user: publicUser(user),
        token: session.token,
        expires_at: session.expiresAt,
        recovery_codes: { password: passwordCodes, mfa: mfaCodes },
      });
    },
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { identifier, email, username, password } = request.body ?? {};
      const value = String(identifier ?? email ?? username ?? '').trim();
      if (value.length === 0 || typeof password !== 'string' || password.length === 0) {
        return reply.code(400).send({ error: 'identifier and password are required' });
      }
      const { rows } = await query(
        `SELECT * FROM users
         WHERE lower(email) = lower($1) OR lower(username) = lower($1)
         LIMIT 1`,
        [value],
      );
      if (rows.length === 0) {
        await recordAuthEvent(null, 'login_failed', request);
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      const user = rows[0];
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        await recordAuthEvent(user.id, 'login_locked', request);
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      if (!verifyPassword(password, user.password_hash)) {
        const failed = user.failed_login_count + 1;
        await query(
          `UPDATE users SET failed_login_count = $2::int,
             locked_until = CASE WHEN $2::int >= $3::int
               THEN now() + make_interval(mins => $4::int) ELSE locked_until END
           WHERE id = $1::uuid`,
          [user.id, failed, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
        );
        await recordAuthEvent(user.id, 'login_failed', request);
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      await query(
        'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
        [user.id],
      );
      const mfaRequired = Boolean(user.mfa_enabled_at);
      const session = await createSession(user.id, {
        mfaSatisfied: !mfaRequired,
        userAgent: request.headers['user-agent'],
        ip: clientIp(request),
      });
      await recordAuthEvent(user.id, mfaRequired ? 'login_mfa_pending' : 'login_success', request);
      return {
        user: publicUser(user),
        token: session.token,
        expires_at: session.expiresAt,
        mfa_required: mfaRequired,
      };
    },
  );

  app.get('/api/auth/me', async (request) => {
    const { rows } = await query(
      `SELECT id, username, email, display_name, mfa_enabled_at, created_at
       FROM users WHERE id = $1`,
      [request.user.id],
    );
    if (rows.length === 0) return { user: null };
    return { user: publicUser(rows[0]) };
  });

  app.post(
    '/api/auth/mfa/verify',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code } = request.body ?? {};
      if (typeof code !== 'string' || code.trim().length === 0) {
        return reply.code(400).send({ error: 'code is required' });
      }
      const { rows } = await query('SELECT * FROM users WHERE id = $1', [request.user.id]);
      if (rows.length === 0 || !rows[0].mfa_enabled_at) {
        return reply.code(400).send({ error: 'mfa_not_enabled' });
      }
      const user = rows[0];
      const secret = readMfaSecret(user);
      let verified = false;
      if (secret && /^\d{6}$/.test(code.replace(/\s+/g, ''))) {
        verified = verifyTotp(secret, code);
      } else {
        verified = await consumeRecoveryCode(user.id, 'mfa_recovery_codes', code);
        if (verified) await recordAuthEvent(user.id, 'mfa_recovery_used', request);
      }
      if (!verified) {
        await recordAuthEvent(user.id, 'mfa_failed', request);
        return reply.code(401).send({ error: 'invalid_code' });
      }
      await query(
        `UPDATE sessions SET mfa_satisfied = true, expires_at = now() + interval '30 days'
         WHERE id = $1`,
        [request.user.sessionId],
      );
      await query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [
        user.id,
      ]);
      await recordAuthEvent(user.id, 'mfa_verified', request);
      return { ok: true, user: publicUser(user) };
    },
  );

  app.post('/api/auth/mfa/setup', async (request, reply) => {
    if (request.user.mfaEnabled) {
      return reply.code(409).send({ error: 'mfa_already_enabled' });
    }
    if (!config.authEncKey) {
      return reply.code(500).send({ error: 'server is missing the encryption key' });
    }
    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, config.authEncKey);
    await query(
      `UPDATE users SET mfa_secret_cipher = $2, mfa_secret_iv = $3, mfa_secret_tag = $4
       WHERE id = $1`,
      [request.user.id, encrypted.cipher, encrypted.iv, encrypted.tag],
    );
    return {
      secret,
      otpauth_uri: totpUri(secret, { account: request.user.email ?? request.user.username }),
    };
  });

  app.post('/api/auth/mfa/enable', async (request, reply) => {
    const { code } = request.body ?? {};
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [request.user.id]);
    const user = rows[0];
    if (!user) return reply.code(404).send({ error: 'not_found' });
    if (user.mfa_enabled_at) return reply.code(409).send({ error: 'mfa_already_enabled' });
    const secret = readMfaSecret(user);
    if (!secret) return reply.code(400).send({ error: 'mfa_setup_required' });
    if (!verifyTotp(secret, code)) {
      await recordAuthEvent(user.id, 'mfa_setup_failed', request);
      return reply.code(401).send({ error: 'invalid_code' });
    }
    await query('UPDATE users SET mfa_enabled_at = now() WHERE id = $1', [user.id]);
    const codes = await issueRecoveryCodes(user.id, 'mfa_recovery_codes');
    await recordAuthEvent(user.id, 'mfa_enabled', request);
    const { rows: refreshed } = await query(
      'SELECT id, username, email, display_name, mfa_enabled_at, created_at FROM users WHERE id = $1',
      [user.id],
    );
    return { ok: true, user: publicUser(refreshed[0]), recovery_codes: codes };
  });

  app.post('/api/auth/mfa/disable', async (request, reply) => {
    const { password } = request.body ?? {};
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [request.user.id]);
    const user = rows[0];
    if (!user) return reply.code(404).send({ error: 'not_found' });
    if (!verifyPassword(password ?? '', user.password_hash)) {
      await recordAuthEvent(user.id, 'mfa_disable_failed', request);
      return reply.code(403).send({ error: 'invalid_password' });
    }
    await query(
      `UPDATE users SET mfa_enabled_at = NULL, mfa_secret_cipher = NULL,
         mfa_secret_iv = NULL, mfa_secret_tag = NULL WHERE id = $1`,
      [user.id],
    );
    await query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [user.id]);
    await recordAuthEvent(user.id, 'mfa_disabled', request);
    return { ok: true };
  });

  app.post('/api/auth/mfa/recovery-codes', async (request, reply) => {
    const { password } = request.body ?? {};
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [request.user.id]);
    const user = rows[0];
    if (!user) return reply.code(404).send({ error: 'not_found' });
    if (!verifyPassword(password ?? '', user.password_hash)) {
      return reply.code(403).send({ error: 'invalid_password' });
    }
    const codes = await issueRecoveryCodes(user.id, 'mfa_recovery_codes');
    await recordAuthEvent(user.id, 'recovery_codes_regenerated', request);
    return { recovery_codes: codes };
  });

  app.post('/api/auth/recovery-codes', async (request, reply) => {
    const { password } = request.body ?? {};
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [request.user.id]);
    const user = rows[0];
    if (!user) return reply.code(404).send({ error: 'not_found' });
    if (!verifyPassword(password ?? '', user.password_hash)) {
      return reply.code(403).send({ error: 'invalid_password' });
    }
    const codes = await issueRecoveryCodes(user.id, 'password_recovery_codes');
    await recordAuthEvent(user.id, 'password_recovery_regenerated', request);
    return { recovery_codes: codes };
  });

  app.post(
    '/api/auth/password/reset-with-code',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { identifier, email, username, recovery_code: recoveryCode, code, new_password: newPassword } =
        request.body ?? {};
      const value = String(identifier ?? email ?? username ?? '').trim();
      const submittedCode = recoveryCode ?? code;
      if (value.length === 0 || typeof submittedCode !== 'string') {
        return reply.code(400).send({ error: 'identifier and recovery_code are required' });
      }
      const policyError = passwordPolicyError(newPassword, { email: value });
      if (policyError) {
        return reply.code(400).send({ error: policyError });
      }
      const { rows } = await query(
        `SELECT id FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($1) LIMIT 1`,
        [value],
      );
      if (rows.length === 0) {
        await recordAuthEvent(null, 'password_reset_failed', request);
        return reply.code(400).send({ error: 'invalid_recovery_code' });
      }
      const user = rows[0];
      const consumed = await consumeRecoveryCode(user.id, 'password_recovery_codes', submittedCode);
      if (!consumed) {
        await recordAuthEvent(user.id, 'password_reset_failed', request);
        return reply.code(400).send({ error: 'invalid_recovery_code' });
      }
      await query('UPDATE users SET password_hash = $2, password_updated_at = now() WHERE id = $1', [
        user.id,
        hashPassword(newPassword),
      ]);
      await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
        user.id,
      ]);
      await recordAuthEvent(user.id, 'password_reset', request);
      return { ok: true };
    },
  );

  app.post('/api/auth/change-password', async (request, reply) => {
    const { current_password: current, new_password: next } = request.body ?? {};
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [request.user.id]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    if (!verifyPassword(current ?? '', rows[0].password_hash)) {
      return reply.code(403).send({ error: 'current password is incorrect' });
    }
    const policyError = passwordPolicyError(next, { email: rows[0].email ?? rows[0].username });
    if (policyError) {
      return reply.code(400).send({ error: policyError });
    }
    await query('UPDATE users SET password_hash = $2, password_updated_at = now() WHERE id = $1', [
      request.user.id,
      hashPassword(next),
    ]);
    await query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
      [request.user.id, request.user.sessionId],
    );
    await recordAuthEvent(request.user.id, 'password_changed', request);
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (request) => {
    const { rows } = await query(
      `SELECT id, created_at, last_used_at, expires_at, user_agent, ip
       FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY COALESCE(last_used_at, created_at) DESC`,
      [request.user.id],
    );
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        expires_at: row.expires_at,
        user_agent: row.user_agent,
        ip: row.ip,
        current: row.id === request.user.sessionId,
      })),
    };
  });

  app.delete('/api/auth/sessions/:id', async (request, reply) => {
    const result = await query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [request.params.id, request.user.id],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    await recordAuthEvent(request.user.id, 'session_revoked', request);
    return { ok: true };
  });

  app.delete('/api/auth/sessions', async (request) => {
    await query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
      [request.user.id, request.user.sessionId],
    );
    await recordAuthEvent(request.user.id, 'sessions_revoked', request);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request) => {
    if (request.user?.sessionId) {
      await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [request.user.sessionId]);
    }
    return { ok: true };
  });
}
