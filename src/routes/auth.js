import { query } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { createSession } from '../lib/auth.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

function publicUser(row) {
  return { id: row.id, username: row.username, created_at: row.created_at };
}

export default async function authRoutes(app) {
  app.post('/api/auth/register', async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (!USERNAME_PATTERN.test(username ?? '')) {
      return reply.code(400).send({
        error: 'username must be 3-32 characters (letters, numbers, dot, underscore, dash)',
      });
    }
    if (typeof password !== 'string' || password.length === 0) {
      return reply.code(400).send({ error: 'password is required' });
    }
    const existing = await query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'username already taken' });
    }
    const { rows } = await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username, hashPassword(password)],
    );
    const session = await createSession(rows[0].id);
    return reply.code(201).send({
      user: publicUser(rows[0]),
      token: session.token,
      expires_at: session.expiresAt,
    });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body ?? {};
    const { rows } = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [
      username ?? '',
    ]);
    if (rows.length === 0 || !verifyPassword(password ?? '', rows[0].password_hash)) {
      return reply.code(401).send({ error: 'invalid username or password' });
    }
    const session = await createSession(rows[0].id);
    return {
      user: publicUser(rows[0]),
      token: session.token,
      expires_at: session.expiresAt,
    };
  });

  app.get('/api/auth/me', async (request) => ({ user: request.user }));

  app.post('/api/auth/change-password', async (request, reply) => {
    const { current_password: current, new_password: next } = request.body ?? {};
    if (typeof current !== 'string' || current.length === 0) {
      return reply.code(400).send({ error: 'current_password is required' });
    }
    if (typeof next !== 'string' || next.length === 0) {
      return reply.code(400).send({ error: 'new_password is required' });
    }
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [
      request.user.id,
    ]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    if (!verifyPassword(current, rows[0].password_hash)) {
      return reply.code(403).send({ error: 'current password is incorrect' });
    }
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      request.user.id,
      hashPassword(next),
    ]);
    await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [
      request.user.id,
      request.user.sessionId,
    ]);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request) => {
    if (request.user?.sessionId) {
      await query('DELETE FROM sessions WHERE id = $1', [request.user.sessionId]);
    }
    return { ok: true };
  });
}
