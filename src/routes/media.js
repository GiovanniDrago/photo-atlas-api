import fs from 'node:fs';
import path from 'node:path';
import { query } from '../db.js';
import { config } from '../config.js';
import { upsertMediaItems, updateScanRun } from '../services/media-index.js';
import { getKDriveClient } from './kdrive.js';

const BASE_FIELDS = `
  m.id, m.source_id, m.external_key, m.path, m.name, m.mime, m.media_type,
  m.size_bytes, m.taken_at, m.file_created_at, m.modified_at, m.lat, m.lon,
  (m.lat IS NOT NULL AND m.lon IS NOT NULL) AS has_gps,
  m.metadata_status, m.width, m.height, m.duration_s, m.indexed_at, m.updated_at,
  s.kind AS source_kind, s.label AS source_label
`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isAllowedLocalPath(filePath) {
  if (!filePath) return false;
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return false;
  }
  if (config.localMediaRoots.length === 0) return true;
  return config.localMediaRoots.some((root) => real.startsWith(fs.realpathSync(root)));
}

function streamFile(reply, filePath, mime) {
  reply.header('Content-Type', mime ?? 'application/octet-stream');
  reply.header('Cache-Control', 'public, max-age=86400');
  return reply.send(fs.createReadStream(filePath));
}

export default async function mediaRoutes(app) {
  app.get('/api/media', async (request) => {
    const q = request.query ?? {};
    const conditions = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (q.west != null && q.south != null && q.east != null && q.north != null) {
      const west = push(Number(q.west));
      const south = push(Number(q.south));
      const east = push(Number(q.east));
      const north = push(Number(q.north));
      conditions.push(`m.geog && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)::geography`);
    }
    if (q.from) conditions.push(`m.taken_at >= ${push(q.from)}`);
    if (q.to) conditions.push(`m.taken_at <= ${push(q.to)}`);
    if (q.status === 'missing') {
      conditions.push("m.metadata_status <> 'full'");
    } else if (q.status && q.status !== 'all') {
      conditions.push(`m.metadata_status = ${push(q.status)}`);
    }
    if (q.type && q.type !== 'all') conditions.push(`m.media_type = ${push(q.type)}`);
    if (q.source_id && isUuid(q.source_id)) conditions.push(`m.source_id = ${push(q.source_id)}`);
    if (q.has_gps === 'true') conditions.push('m.lat IS NOT NULL');
    if (q.has_gps === 'false') conditions.push('m.lat IS NULL');
    if (q.q) conditions.push(`m.name ILIKE ${push(`%${q.q}%`)}`);

    const limit = clamp(Number(q.limit ?? 100), 1, config.maxBatchSize);
    const offset = Math.max(Number(q.offset ?? 0), 0);
    const order =
      q.order === 'taken_at.asc'
        ? 'm.taken_at ASC NULLS LAST, m.indexed_at ASC'
        : 'm.taken_at DESC NULLS LAST, m.indexed_at DESC';

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT ${BASE_FIELDS}, count(*) OVER() AS total
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       ${where}
       ORDER BY ${order}
       LIMIT ${push(limit)} OFFSET ${push(offset)}`,
      params,
    );

    return {
      items: rows,
      total: rows.length > 0 ? Number(rows[0].total) : 0,
      limit,
      offset,
    };
  });

  app.post('/api/media/batch', async (request, reply) => {
    const body = request.body ?? {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!isUuid(body.source_id)) {
      return reply.code(400).send({ error: 'source_id must be a valid uuid' });
    }
    if (items.length === 0) {
      return reply.code(400).send({ error: 'items must be a non-empty array' });
    }
    if (items.length > config.maxBatchSize) {
      return reply.code(400).send({ error: `items length must be <= ${config.maxBatchSize}` });
    }

    const indexed = await upsertMediaItems(body.source_id, items);
    if (body.scan_run_id && isUuid(body.scan_run_id)) {
      await updateScanRun(body.scan_run_id, { files_seen: items.length, files_indexed: indexed });
    }
    return { indexed };
  });

  app.get('/api/media/:id', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const { rows } = await query(
      `SELECT ${BASE_FIELDS}
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE m.id = $1`,
      [request.params.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { item: rows[0] };
  });

  app.get('/api/media/:id/thumbnail', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const { rows } = await query(
      `SELECT m.*, s.kind AS source_kind
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE m.id = $1`,
      [request.params.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    const item = rows[0];

    if (item.thumb_path && fs.existsSync(item.thumb_path)) {
      return streamFile(reply, item.thumb_path, item.mime);
    }

    if (item.source_kind === 'local' && isAllowedLocalPath(item.path)) {
      return streamFile(reply, item.path, item.mime);
    }

    if (item.source_kind === 'kdrive' && item.external_key) {
      try {
        const { client } = await getKDriveClient();
        const response = await client.fetchThumbnail(item.external_key);
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          reply.header('Content-Type', response.headers.get('content-type') ?? 'image/jpeg');
          reply.header('Cache-Control', 'public, max-age=86400');
          return reply.send(buffer);
        }
        const fallback = await client.readPrefix(item.external_key, 2 * 1024 * 1024);
        if (fallback.length > 0) {
          reply.header('Content-Type', item.mime ?? 'image/jpeg');
          return reply.send(fallback);
        }
      } catch (error) {
        request.log.warn({ err: error.message }, 'kdrive thumbnail failed');
      }
    }

    return reply.code(404).send({ error: 'thumbnail_unavailable' });
  });
}
