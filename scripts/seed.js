import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import pg from 'pg';
import * as gotrue from '../src/lib/gotrue.js';

const seedFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'seed.sql');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const sql = await readFile(seedFile, 'utf8');
  await pool.query(sql);

  const email = String(process.argv[2] ?? process.env.DEMO_EMAIL ?? '').trim();
  if (!email) {
    console.log('seed applied (sources and media items, no owner)');
    console.log('assign them to a Supabase Auth user with: npm run seed -- <email>');
    await pool.end();
    return;
  }

  const user = await gotrue.adminFindUserByEmail(email);
  if (!user) {
    console.error(`seed applied, but no Supabase Auth user found for ${email}`);
    await pool.end();
    process.exit(1);
  }
  const sources = await pool.query('UPDATE sources SET owner_id = $1 WHERE owner_id IS NULL RETURNING id', [
    user.id,
  ]);
  const accounts = await pool.query(
    'UPDATE kdrive_accounts SET owner_id = $1 WHERE owner_id IS NULL RETURNING id',
    [user.id],
  );
  const counts = await pool.query('SELECT count(*)::int AS items FROM media_items');
  console.log(`seed applied, media_items = ${counts.rows[0].items}`);
  console.log(`assigned ${sources.rowCount} sources and ${accounts.rowCount} kDrive accounts to ${email}`);
  await pool.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
