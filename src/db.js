import pg from 'pg';
import './lib/pg-types.js';
import { config } from './config.js';

let pool = null;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? config.databaseUrl,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

export function databasePool() {
  return getPool();
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
