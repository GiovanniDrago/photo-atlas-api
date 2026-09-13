import { query } from '../db.js';
import { generateSessionToken, hashToken } from './passwords.js';

const SESSION_TTL_DAYS = 30;

export async function createSession(userId) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

export async function requireAuth(request, reply) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { rows } = await query(
    `SELECT s.id AS session_id, u.id, u.username
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(match[1])],
  );
  if (rows.length === 0) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  request.user = { id: rows[0].id, username: rows[0].username, sessionId: rows[0].session_id };
  await query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [rows[0].session_id]);
  return undefined;
}

export function registerAuthHook(app) {
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (url === '/api/auth/register' || url === '/api/auth/login') return;
    return requireAuth(request, reply);
  });
}
