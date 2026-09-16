import { query } from '../db.js';
import { withAssetUrls } from '../lib/signed-url.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ITEM_FIELDS = `
  m.id, m.source_id, m.external_key, m.path, m.name, m.mime, m.media_type,
  m.size_bytes, m.taken_at, m.file_created_at, m.modified_at, m.lat, m.lon,
  (m.lat IS NOT NULL AND m.lon IS NOT NULL) AS has_gps,
  m.metadata_status, m.width, m.height, m.duration_s,
  s.kind AS source_kind, s.label AS source_label
`;

export default async function timelineRoutes(app) {
  app.get('/api/timeline', async (request, reply) => {
    const { from, to, source_id: sourceId } = request.query ?? {};
    if (sourceId != null && !UUID_PATTERN.test(sourceId)) {
      return reply.code(400).send({ error: 'source_id must be a valid uuid' });
    }
    const { rows } = await query(
      'SELECT * FROM media_timeline($1, COALESCE($2, now()), $3, $4)',
      [from ?? null, to ?? null, sourceId ?? null, request.user.id],
    );
    return {
      buckets: rows.map((row) => ({
        bucket_start: row.bucket_start,
        bucket_end: row.bucket_end,
        granularity: row.granularity,
        count: Number(row.item_count),
        representative_id: row.representative_id,
      })),
    };
  });

  app.get('/api/timeline/items', async (request, reply) => {
    const { from, to, limit, offset, source_id: sourceId } = request.query ?? {};
    if (!from || !to) {
      return reply.code(400).send({ error: 'from and to are required (ISO timestamps)' });
    }
    if (sourceId != null && !UUID_PATTERN.test(sourceId)) {
      return reply.code(400).send({ error: 'source_id must be a valid uuid' });
    }
    const limitValue = Math.min(Math.max(Number(limit ?? 200), 1), 500);
    const offsetValue = Math.max(Number(offset ?? 0), 0);
    const params = [from, to, request.user.id];
    let sourceClause = '';
    if (sourceId) {
      params.push(sourceId);
      sourceClause = `AND m.source_id = $${params.length}`;
    }
    params.push(limitValue, offsetValue);
    const { rows } = await query(
      `SELECT ${ITEM_FIELDS}, count(*) OVER() AS total
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE m.taken_at >= $1 AND m.taken_at < $2
       AND s.owner_id = $3
       ${sourceClause}
       ORDER BY m.taken_at DESC, m.indexed_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: rows.map((row) => withAssetUrls(row, `${request.protocol}://${request.headers.host}`)),
      total: rows.length > 0 ? Number(rows[0].total) : 0,
      limit: limitValue,
      offset: offsetValue,
    };
  });
}
