import { query } from '../db.js';

export default async function sourceRoutes(app) {
  app.get('/api/sources', async (request) => {
    const { rows } = await query(
      `SELECT s.*, count(m.id)::int AS item_count
       FROM sources s
       LEFT JOIN media_items m ON m.source_id = s.id
       WHERE s.owner_id = $1
       GROUP BY s.id
       ORDER BY s.created_at ASC`,
      [request.user.id],
    );
    return { sources: rows };
  });

  app.post('/api/sources', async (request, reply) => {
    const {
      kind,
      label,
      root_path: rootPath,
      kdrive_drive_id: kdriveDriveId,
      kdrive_folder_id: kdriveFolderId,
      device_id: deviceId,
      album_key: albumKey,
    } = request.body ?? {};
    if (!kind || !label || !['local', 'kdrive'].includes(kind)) {
      return reply.code(400).send({ error: 'kind must be local or kdrive, label is required' });
    }
    const { rows } = await query(
      `INSERT INTO sources (kind, label, root_path, kdrive_drive_id, kdrive_folder_id, device_id, album_key, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        kind,
        label,
        rootPath ?? null,
        kdriveDriveId ?? null,
        kdriveFolderId ?? null,
        deviceId ?? null,
        albumKey ?? null,
        request.user.id,
      ],
    );
    return reply.code(201).send({ source: rows[0] });
  });

  app.patch('/api/sources/:id', async (request, reply) => {
    const { rows } = await query(
      `UPDATE sources SET
         label = COALESCE($2, label),
         root_path = COALESCE($3, root_path),
         last_scan_at = COALESCE($4, last_scan_at),
         include_subfolders = COALESCE($5, include_subfolders),
         device_id = COALESCE($6, device_id),
         album_key = COALESCE($7, album_key)
       WHERE id = $1 AND owner_id = $8
       RETURNING *`,
      [
        request.params.id,
        request.body?.label ?? null,
        request.body?.root_path ?? null,
        request.body?.last_scan_at ?? null,
        typeof request.body?.include_subfolders === 'boolean'
          ? request.body.include_subfolders
          : null,
        request.body?.device_id ?? null,
        request.body?.album_key ?? null,
        request.user.id,
      ],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { source: rows[0] };
  });

  app.delete('/api/sources/:id', async (request, reply) => {
    const { rowCount } = await query('DELETE FROM sources WHERE id = $1 AND owner_id = $2', [
      request.params.id,
      request.user.id,
    ]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
