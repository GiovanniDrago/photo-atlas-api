import { query } from '../db.js';
import { generateSessionToken, hashToken } from './passwords.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MFA_PENDING_TTL_MS = 10 * 60 * 1000;

export async function createSession(
  userId,
  { mfaSatisfied = true, ttlMs = mfaSatisfied ? SESSION_TTL_MS : MFA_PENDING_TTL_MS, userAgent, ip } = {},
) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, mfa_satisfied, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, hashToken(token), expiresAt, mfaSatisfied, userAgent ?? null, ip ?? null],
  );
  return { token, expiresAt };
}

export async function recordAuthEvent(userId, kind, request) {
  try {
    await query('INSERT INTO auth_events (user_id, kind, ip, user_agent) VALUES ($1, $2, $3, $4)', [
      userId ?? null,
      kind,
      request?.ip ?? null,
      request?.headers?.['user-agent'] ?? null,
    ]);
  } catch {
    // Audit logging must never break the request.
  }
}

const MFA_PENDING_ALLOWED = new Set(['/api/auth/mfa/verify', '/api/auth/logout']);

export async function requireAuth(request, reply) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { rows } = await query(
    `SELECT s.id AS session_id, s.mfa_satisfied, u.id, u.username, u.email, u.display_name,
            (u.mfa_enabled_at IS NOT NULL) AS mfa_enabled
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND s.revoked_at IS NULL`,
    [hashToken(match[1])],
  );
  if (rows.length === 0) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const row = rows[0];
  if (!row.mfa_satisfied) {
    const url = request.url.split('?')[0];
    if (!MFA_PENDING_ALLOWED.has(url)) {
      return reply.code(403).send({ error: 'mfa_required' });
    }
  }
  request.user = {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    mfaEnabled: row.mfa_enabled,
    sessionId: row.session_id,
    mfaSatisfied: row.mfa_satisfied,
  };
  await query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [row.session_id]);
  return undefined;
}

export function registerAuthHook(app) {
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (url === '/api/auth/register' || url === '/api/auth/login') return;
    if (url === '/api/auth/password/reset-with-code') return;
    if (/^\/api\/media\/[0-9a-f-]{36}\/(thumbnail|download)$/i.test(url)) return;
    return requireAuth(request, reply);
  });
}
