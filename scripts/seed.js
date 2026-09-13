import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import pg from 'pg';
import { hashPassword } from '../src/lib/passwords.js';

const seedFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'seed.sql');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const sql = await readFile(seedFile, 'utf8');
  await pool.query(sql);

  const demoPassword = process.env.DEMO_PASSWORD ?? 'demo';
  const existing = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', ['demo']);
  let userId;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      userId,
      hashPassword(demoPassword),
    ]);
  } else {
    const inserted = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      ['demo', hashPassword(demoPassword)],
    );
    userId = inserted.rows[0].id;
  }

  const sources = await pool.query('UPDATE sources SET owner_id = $1 WHERE owner_id IS NULL RETURNING id', [userId]);
  const accounts = await pool.query(
    'UPDATE kdrive_accounts SET owner_id = $1 WHERE owner_id IS NULL RETURNING id',
    [userId],
  );

  const counts = await pool.query('SELECT count(*)::int AS items FROM media_items');
  console.log(`seed applied, media_items = ${counts.rows[0].items}`);
  console.log(`demo user ready: demo / ${demoPassword}`);
  console.log(`assigned ${sources.rowCount} sources and ${accounts.rowCount} kDrive accounts to demo`);
  await pool.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
