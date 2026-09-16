import crypto from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import { hashPassword } from '../src/lib/passwords.js';

const username = process.argv[2];
const provided = process.argv[3];

if (!username) {
  console.error('usage: npm run reset-password -- <username> [new_password]');
  process.exit(1);
}

const password = provided && provided.length > 0 ? provided : crypto.randomBytes(9).toString('base64url');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [
    username,
  ]);
  if (rows.length === 0) {
    console.error(`user not found: ${username}`);
    await pool.end();
    process.exit(1);
  }
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    rows[0].id,
    hashPassword(password),
  ]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
  console.log(`password for ${username}: ${password}`);
  console.log('all sessions revoked, the user must sign in again');
  await pool.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
