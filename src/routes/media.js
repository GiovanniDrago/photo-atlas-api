import fs from 'node:fs';
import { query } from '../db.js';
import { config } from '../config.js';
import { verifyAssetSignature } from '../lib/signed-url.js';
import {
  MEDIA_BASE_FIELDS,
  MEDIA_JOIN,
  serializeMediaRow,
} from '../lib/media-row.js';
import { isAllowedLocalPath } from '../lib/local-paths.js';
import { ensureThumbnail } from '../services/media-assets.js';
import { getKDriveClient } from '../services/kdrive-account.js';
import { upsertMediaItems, updateScanRun } from '../services/media-index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function streamFile(reply, filePath, mime, cacheSeconds = 604800) {
  reply.header('Content-Type', mime ?? 'application/octet-stream');
  reply.header('Cache-Control', `public, max-age=${cacheSeconds}`);
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
    if (q.backup_status) {
      const statuses = String(q.backup_status)
        .split(',')
        .map((value) => value.trim())
        .filter((value) => ['none', 'pending', 'uploading', 'uploaded', 'failed', 'skipped'].includes(value));
      if (statuses.length > 0) {
        conditions.push(`m.backup_status = ANY(${push(statuses)}::text[])`);
      }
    }
    if (q.source_id == null && q.device_id && isUuid(q.device_id)) {
      conditions.push(`s.device_id = ${push(q.device_id)}`);
    }
    if (q.q) conditions.push(`m.name ILIKE ${push(`%${q.q}%`)}`);
    conditions.push(`s.owner_id = ${push(request.user.id)}`);

    const limit = clamp(Number(q.limit ?? 100), 1, config.maxBatchSize);
    const offset = Math.max(Number(q.offset ?? 0), 0);
    // The id tiebreaker keeps offset pagination stable when dates are equal
    // (bulk inserts share indexed_at and photos can share taken_at).
    const order =
      q.order === 'taken_at.asc'
        ? 'm.taken_at ASC NULLS LAST, m.indexed_at ASC, m.id ASC'
        : 'm.taken_at DESC NULLS LAST, m.indexed_at DESC, m.id DESC';

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const from = `${MEDIA_JOIN} ${where}`;
    const filterParams = [...params];
    const limitParam = push(limit);
    const offsetParam = push(offset);
    const { rows } = await query(
      `SELECT ${MEDIA_BASE_FIELDS}
       ${from}
       ORDER BY ${order}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    const { rows: countRows } = await query(
      `SELECT count(*)::int AS total ${from}`,
      filterParams,
    );

    return {
      items: rows.map((row) => serializeMediaRow(row, request)),
      total: Number(countRows[0]?.total ?? 0),
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

    const owned = await query('SELECT 1 FROM sources WHERE id = $1 AND owner_id = $2', [
      body.source_id,
      request.user.id,
    ]);
    if (owned.rows.length === 0) {
      return reply.code(404).send({ error: 'source not found' });
    }

    const rows = await upsertMediaItems(body.source_id, items);
    if (body.scan_run_id && isUuid(body.scan_run_id)) {
      await updateScanRun(body.scan_run_id, { files_seen: items.length, files_indexed: rows.length });
    }
    return {
      indexed: rows.length,
      items: rows.map((row) => ({ id: row.id, external_key: row.external_key })),
    };
  });

  app.get('/api/media/:id', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const { rows } = await query(
      `SELECT ${MEDIA_BASE_FIELDS}
       ${MEDIA_JOIN}
       WHERE m.id = $1 AND s.owner_id = $2`,
      [request.params.id, request.user.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { item: serializeMediaRow(rows[0], request) };
  });

  app.get('/api/media/:id/thumbnail', async (request, reply) => {
    const mediaId = request.params.id;
    if (!isUuid(mediaId)) return reply.code(400).send({ error: 'invalid id' });
    if (!verifyAssetSignature('thumb', mediaId, request.query?.s)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const { rows } = await query(
      `SELECT m.*, s.kind AS source_kind, s.owner_id
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE m.id = $1`,
      [mediaId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    const item = rows[0];

    // Large on-the-fly preview for the full screen viewer: kDrive is asked for
    // the requested width and nothing is cached on disk.
    const requestedWidth = Math.round(Number(request.query?.w ?? 0));
    if (
      Number.isFinite(requestedWidth) &&
      requestedWidth > 320 &&
      item.source_kind === 'kdrive' &&
      item.external_key
    ) {
      const width = clamp(requestedWidth, 321, 2048);
      try {
        const { client } = await getKDriveClient(item.owner_id);
        const response = await client.fetchThumbnail(item.external_key, width);
        if (!response.ok) throw new Error(`kDrive thumbnail failed (${response.status})`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 0) {
          reply.header('Content-Type', 'image/jpeg');
          reply.header('Cache-Control', 'private, max-age=3600');
          return reply.send(buffer);
        }
      } catch (error) {
        request.log.warn({ err: error.message }, 'kdrive preview failed');
      }
    }

    const cached = await ensureThumbnail(item).catch((error) => {
      request.log.warn({ err: error.message }, 'thumbnail cache failed');
      return null;
    });
    if (cached) {
      reply.header('ETag', `"${item.id}-${item.updated_at?.toISOString?.() ?? ''}"`);
      return streamFile(reply, cached.path, cached.contentType);
    }

    if (item.thumb_path && fs.existsSync(item.thumb_path)) {
      return streamFile(reply, item.thumb_path, item.mime);
    }

    if (item.source_kind === 'local' && isAllowedLocalPath(item.path)) {
      return streamFile(reply, item.path, item.mime);
    }

    if (item.source_kind === 'kdrive' && item.external_key) {
      try {
        const { client } = await getKDriveClient(item.owner_id);
        const fallback = await client.readPrefix(item.external_key, 2 * 1024 * 1024);
        if (fallback.length > 0) {
          reply.header('Content-Type', item.mime ?? 'image/jpeg');
          reply.header('Cache-Control', 'public, max-age=86400');
          return reply.send(fallback);
        }
      } catch (error) {
        request.log.warn({ err: error.message }, 'kdrive thumbnail failed');
      }
    }

    return reply.code(404).send({ error: 'thumbnail_unavailable' });
  });

  app.get('/api/media/:id/download', async (request, reply) => {
    const mediaId = request.params.id;
    if (!isUuid(mediaId)) return reply.code(400).send({ error: 'invalid id' });
    if (!verifyAssetSignature('download', mediaId, request.query?.s)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const { rows } = await query(
      `SELECT m.*, s.kind AS source_kind, s.owner_id
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE m.id = $1`,
      [mediaId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    const item = rows[0];
    const filename = (item.name ?? 'download').replace(/["\r\n]/g, '_');

    if (item.source_kind === 'kdrive' && item.external_key) {
      try {
        const { client } = await getKDriveClient(item.owner_id);
        const response = await client.download(item.external_key);
        if (!response.ok) throw new Error(`kDrive download failed (${response.status})`);
        reply.header('Content-Type', item.mime ?? 'application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        reply.header('Cache-Control', 'private, max-age=0');
        const buffer = Buffer.from(await response.arrayBuffer());
        return reply.send(buffer);
      } catch (error) {
        request.log.warn({ err: error.message }, 'kdrive download failed');
        return reply.code(502).send({ error: 'download_failed' });
      }
    }

    if (item.source_kind === 'local' && isAllowedLocalPath(item.path)) {
      reply.header('Content-Type', item.mime ?? 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(item.path));
    }

    return reply.code(404).send({ error: 'file_unavailable' });
  });

  app.post('/api/media/delete', async (request, reply) => {
    const body = request.body ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid) : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'no_ids' });
    if (ids.length > config.maxBatchSize) {
      return reply.code(400).send({ error: 'too_many_ids' });
    }
    const removeCloud = body.cloud !== false;
    const removeIndex = body.index === true;

    const { rows } = await query(
      `SELECT m.id, m.name, m.external_key, m.thumb_path, m.kdrive_file_id,
              s.kind AS source_kind
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE m.id = ANY($1::uuid[]) AND s.owner_id = $2`,
      [ids, request.user.id],
    );
    if (rows.length === 0) {
      return { deleted: 0, cloud_deleted: 0, reset: 0, failed: [], items: [] };
    }

    const needsKDrive = rows.some(
      (row) => removeCloud && (row.kdrive_file_id != null || row.source_kind === 'kdrive'),
    );
    let client = null;
    let kdriveError = null;
    if (needsKDrive) {
      try {
        ({ client } = await getKDriveClient(request.user.id));
      } catch (error) {
        kdriveError = error.message;
      }
    }

    const failed = [];
    const items = [];
    let deleted = 0;
    let cloudDeleted = 0;
    let reset = 0;

    for (const row of rows) {
      const kdriveId =
        row.kdrive_file_id ?? (row.source_kind === 'kdrive' ? row.external_key : null);
      let cloudOk = false;
      if (removeCloud && kdriveId != null) {
        if (!client) {
          const message = kdriveError ?? 'kdrive_unavailable';
          failed.push({ id: row.id, error: message });
          items.push({ id: row.id, action: 'failed', error: message });
          continue;
        }
        try {
          await client.deleteFile(kdriveId);
          cloudOk = true;
          cloudDeleted += 1;
        } catch (error) {
          failed.push({ id: row.id, error: error.message });
          items.push({ id: row.id, action: 'failed', error: error.message });
          continue;
        }
      }

      // kDrive-sourced rows have no local copy: without their file they are stale.
      const dropRow = removeIndex || (cloudOk && row.source_kind === 'kdrive');
      if (dropRow) {
        await query('DELETE FROM media_items WHERE id = $1', [row.id]);
        if (row.thumb_path) {
          await fs.promises.unlink(row.thumb_path).catch(() => {});
        }
        deleted += 1;
        items.push({ id: row.id, action: 'deleted' });
      } else if (cloudOk) {
        await query(
          `UPDATE media_items
           SET backup_status = 'none', kdrive_file_id = NULL, kdrive_parent_id = NULL,
               backed_up_at = NULL, backup_error = NULL, backup_attempts = 0,
               updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
        reset += 1;
        items.push({ id: row.id, action: 'reset' });
      } else {
        items.push({ id: row.id, action: 'unchanged' });
      }
    }

    return { deleted, cloud_deleted: cloudDeleted, reset, failed, items };
  });
}
