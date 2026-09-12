import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import pg from 'pg';

const seedFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'seed.sql');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const sql = await readFile(seedFile, 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query('SELECT count(*)::int AS items FROM media_items');
  console.log(`seed applied, media_items = ${rows[0].items}`);
  await pool.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
