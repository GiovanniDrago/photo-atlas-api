import { query } from '../db.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function scanRunRoutes(app) {
  app.get('/api/scan-runs', async () => {
    const { rows } = await query(`
      SELECT r.*, s.label AS source_label
      FROM scan_runs r
      LEFT JOIN sources s ON s.id = r.source_id
      ORDER BY r.started_at DESC
      LIMIT 50
    `);
    return { scan_runs: rows };
  });

  app.get('/api/scan-runs/:id', async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const { rows } = await query('SELECT * FROM scan_runs WHERE id = $1', [request.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { scan_run: rows[0] };
  });

  app.post('/api/scan-runs', async (request, reply) => {
    const { source_id: sourceId, status } = request.body ?? {};
    const { rows } = await query(
      'INSERT INTO scan_runs (source_id, status) VALUES ($1, $2) RETURNING *',
      [sourceId ?? null, status ?? 'running'],
    );
    return reply.code(201).send({ scan_run: rows[0] });
  });

  app.patch('/api/scan-runs/:id', async (request, reply) => {
    if (!UUID_PATTERN.test(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const body = request.body ?? {};
    const { rows } = await query(
      `UPDATE scan_runs SET
         status = COALESCE($2, status),
         files_seen = COALESCE($3, files_seen),
         files_indexed = COALESCE($4, files_indexed),
         files_skipped = COALESCE($5, files_skipped),
         errors = COALESCE($6, errors),
         finished_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE finished_at END
       WHERE id = $1
       RETURNING *`,
      [
        request.params.id,
        body.status ?? null,
        body.files_seen ?? null,
        body.files_indexed ?? null,
        body.files_skipped ?? null,
        body.errors ? JSON.stringify(body.errors) : null,
      ],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { scan_run: rows[0] };
  });
}
