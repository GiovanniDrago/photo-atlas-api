import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

async function withTestSource(pool, callback) {
  const source = await pool.query(
    `INSERT INTO sources (kind, label) VALUES ('local', 'test-' || gen_random_uuid()) RETURNING id`,
  );
  const sourceId = source.rows[0].id;
  try {
    await callback(sourceId);
  } finally {
    await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  }
}

async function insertItem(pool, sourceId, key, name, lat, lon, daysAgo, status) {
  await pool.query(
    `INSERT INTO media_items (source_id, external_key, name, lat, lon, taken_at, metadata_status)
     VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval, $7)`,
    [sourceId, key, name, lat, lon, String(daysAgo), status],
  );
}

test('clusters merge at low zoom and split at high zoom', { skip }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => pool.end());

  await withTestSource(pool, async (sourceId) => {
    await insertItem(pool, sourceId, 't1', 'Turin 1', 45.0703, 7.6869, 1, 'full');
    await insertItem(pool, sourceId, 't2', 'Turin 2', 45.075, 7.69, 2, 'full');
    await insertItem(pool, sourceId, 'm1', 'Milan 1', 45.4642, 9.19, 3, 'full');

    const { rows: geoRows } = await pool.query(
      'SELECT geog IS NOT NULL AS has_geog FROM media_items WHERE source_id = $1 LIMIT 1',
      [sourceId],
    );
    assert.equal(geoRows[0].has_geog, true);

    const world = await pool.query('SELECT * FROM media_clusters(-180, -90, 180, 90, 0, $1)', [sourceId]);
    assert.equal(world.rows.length, 1);
    assert.equal(Number(world.rows[0].item_count), 3);

    const zoomed = await pool.query('SELECT * FROM media_clusters(-180, -90, 180, 90, 8, $1)', [sourceId]);
    assert.equal(zoomed.rows.length, 2);
    const counts = zoomed.rows.map((row) => Number(row.item_count)).sort((a, b) => a - b);
    assert.deepEqual(counts, [1, 2]);
  });
});

test('timeline assigns day, week and month granularities', { skip }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => pool.end());

  await withTestSource(pool, async (sourceId) => {
    await insertItem(pool, sourceId, 'd1', 'Today', null, null, 1, 'partial');
    await insertItem(pool, sourceId, 'w1', 'Months ago', null, null, 100, 'partial');
    await insertItem(pool, sourceId, 'm1', 'Older', null, null, 200, 'partial');

    const { rows } = await pool.query(
      `SELECT * FROM media_timeline(now() - interval '10 years', now(), $1)`,
      [sourceId],
    );
    const granularities = new Set(rows.map((row) => row.granularity));
    assert.ok(granularities.has('day'));
    assert.ok(granularities.has('week'));
    assert.ok(granularities.has('month'));
    const total = rows.reduce((sum, row) => sum + Number(row.item_count), 0);
    assert.ok(total >= 3);
  });
});
