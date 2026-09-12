import { query } from '../db.js';

export default async function sourceRoutes(app) {
  app.get('/api/sources', async () => {
    const { rows } = await query(`
      SELECT s.*, count(m.id)::int AS item_count
      FROM sources s
      LEFT JOIN media_items m ON m.source_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at ASC
    `);
    return { sources: rows };
  });

  app.post('/api/sources', async (request, reply) => {
    const { kind, label, root_path: rootPath, kdrive_drive_id: kdriveDriveId, kdrive_folder_id: kdriveFolderId } = request.body ?? {};
    if (!kind || !label || !['local', 'kdrive'].includes(kind)) {
      return reply.code(400).send({ error: 'kind must be local or kdrive, label is required' });
    }
    const { rows } = await query(
      `INSERT INTO sources (kind, label, root_path, kdrive_drive_id, kdrive_folder_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [kind, label, rootPath ?? null, kdriveDriveId ?? null, kdriveFolderId ?? null],
    );
    return reply.code(201).send({ source: rows[0] });
  });

  app.patch('/api/sources/:id', async (request, reply) => {
    const { rows } = await query(
      `UPDATE sources SET
         label = COALESCE($2, label),
         root_path = COALESCE($3, root_path),
         last_scan_at = COALESCE($4, last_scan_at)
       WHERE id = $1
       RETURNING *`,
      [request.params.id, request.body?.label ?? null, request.body?.root_path ?? null, request.body?.last_scan_at ?? null],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { source: rows[0] };
  });

  app.delete('/api/sources/:id', async (request, reply) => {
    const { rowCount } = await query('DELETE FROM sources WHERE id = $1', [request.params.id]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
