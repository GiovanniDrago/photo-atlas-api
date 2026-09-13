import { query } from '../db.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function clusterRoutes(app) {
  app.get('/api/clusters', async (request, reply) => {
    const { west, south, east, north, zoom, source_id: sourceId } = request.query ?? {};
    if (west == null || south == null || east == null || north == null || zoom == null) {
      return reply.code(400).send({ error: 'west, south, east, north and zoom are required' });
    }
    if (sourceId != null && !UUID_PATTERN.test(sourceId)) {
      return reply.code(400).send({ error: 'source_id must be a valid uuid' });
    }
    const { rows } = await query('SELECT * FROM media_clusters($1, $2, $3, $4, $5, $6, $7)', [
      Number(west),
      Number(south),
      Number(east),
      Number(north),
      Number(zoom),
      sourceId ?? null,
      request.user.id,
    ]);
    return {
      clusters: rows.map((row) => ({
        key: row.cluster_key,
        lat: row.lat,
        lon: row.lon,
        count: Number(row.item_count),
        bounds: {
          west: row.min_lon,
          south: row.min_lat,
          east: row.max_lon,
          north: row.max_lat,
        },
        representative_id: row.representative_id,
      })),
    };
  });
}
