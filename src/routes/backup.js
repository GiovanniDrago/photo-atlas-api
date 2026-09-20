import { query } from '../db.js';
import { config } from '../config.js';
import { getKDriveClient } from '../services/kdrive-account.js';
import {
  UploadTooLargeError,
  applyUploadedMetadata,
  extractMetadata,
  markMissingOnKDrive,
  markUploadFailed,
  markUploaded,
  removeTempFile,
  streamToTempFile,
  uploadToKDrive,
} from '../services/backup.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function ownedItem(userId, mediaId) {
  const { rows } = await query(
    `SELECT m.id, m.source_id, m.name, m.mime, m.size_bytes, m.backup_status, m.kdrive_file_id,
            s.label AS source_label, s.kind AS source_kind, s.owner_id,
            s.backup_folder_id, s.backup_folder_path
     FROM media_items m
     JOIN sources s ON s.id = m.source_id
     WHERE m.id = $1 AND s.owner_id = $2`,
    [mediaId, userId],
  );
  return rows[0] ?? null;
}

export default async function backupRoutes(app) {
  app.post('/api/devices', async (request, reply) => {
    const { fingerprint, name, platform } = request.body ?? {};
    if (typeof fingerprint !== 'string' || fingerprint.trim().length < 8) {
      return reply.code(400).send({ error: 'fingerprint is required (min 8 characters)' });
    }
    const { rows } = await query(
      `INSERT INTO devices (owner_id, fingerprint, name, platform)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, fingerprint) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, devices.name),
         platform = COALESCE(EXCLUDED.platform, devices.platform),
         last_seen_at = now()
       RETURNING *`,
      [request.user.id, fingerprint.trim(), name ?? null, platform ?? null],
    );
    return { device: rows[0] };
  });

  app.get('/api/backup/status', async (request) => {
    const { rows } = await query(
      `SELECT
         s.id, s.label, s.kind, s.root_path, s.auto_backup, s.backup_folder_path,
         s.backup_last_run_at,
         count(m.id)::int AS total,
         count(m.id) FILTER (WHERE m.backup_status = 'uploaded')::int AS uploaded,
         count(m.id) FILTER (WHERE m.backup_status IN ('none', 'pending'))::int AS pending,
         count(m.id) FILTER (WHERE m.backup_status = 'failed')::int AS failed,
         coalesce(sum(m.size_bytes) FILTER (WHERE m.backup_status = 'uploaded'), 0)::bigint AS bytes_uploaded,
         coalesce(sum(m.size_bytes), 0)::bigint AS bytes_total
       FROM sources s
       LEFT JOIN media_items m ON m.source_id = s.id
       WHERE s.owner_id = $1 AND s.kind = 'local'
       GROUP BY s.id
       ORDER BY s.created_at ASC`,
      [request.user.id],
    );
    const totals = rows.reduce(
      (accumulator, row) => ({
        total: accumulator.total + Number(row.total),
        uploaded: accumulator.uploaded + Number(row.uploaded),
        pending: accumulator.pending + Number(row.pending),
        failed: accumulator.failed + Number(row.failed),
        bytes_uploaded: accumulator.bytes_uploaded + Number(row.bytes_uploaded),
        bytes_total: accumulator.bytes_total + Number(row.bytes_total),
      }),
      { total: 0, uploaded: 0, pending: 0, failed: 0, bytes_uploaded: 0, bytes_total: 0 },
    );
    return { sources: rows, totals };
  });

  app.get('/api/backup/pending', async (request, reply) => {
    const sourceId = request.query?.source_id;
    if (sourceId != null && !isUuid(sourceId)) {
      return reply.code(400).send({ error: 'invalid source_id' });
    }
    const limit = clamp(Number(request.query?.limit ?? 100), 1, config.maxBatchSize);
    const params = [request.user.id];
    let sourceClause = '';
    if (sourceId) {
      params.push(sourceId);
      sourceClause = `AND m.source_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT m.id, m.source_id, m.external_key, m.path, m.name, m.mime, m.media_type,
              m.size_bytes, m.backup_status, m.backup_attempts, m.backup_error,
              s.label AS source_label
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE s.owner_id = $1
         AND s.kind = 'local'
         AND m.backup_status IN ('none', 'pending', 'failed')
         ${sourceClause}
       ORDER BY m.backup_attempts ASC, m.taken_at DESC NULLS LAST, m.indexed_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return { items: rows };
  });

  app.get('/api/backup/verify-queue', async (request, reply) => {
    const sourceId = request.query?.source_id;
    if (sourceId != null && !isUuid(sourceId)) {
      return reply.code(400).send({ error: 'invalid source_id' });
    }
    const limit = clamp(Number(request.query?.limit ?? 100), 1, config.maxBatchSize);
    const params = [request.user.id];
    let sourceClause = '';
    if (sourceId) {
      params.push(sourceId);
      sourceClause = `AND m.source_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT m.id, m.source_id, m.external_key, m.name, m.size_bytes, m.backup_status,
              m.kdrive_file_id, m.backed_up_at, s.label AS source_label
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE s.owner_id = $1
         AND m.backup_status = 'uploaded'
         AND m.kdrive_file_id IS NOT NULL
         ${sourceClause}
       ORDER BY m.backed_up_at ASC NULLS FIRST
       LIMIT $${params.length}`,
      params,
    );
    return { items: rows };
  });

  app.post('/api/backup/runs', async (request, reply) => {
    const { kind = 'backup', source_id: sourceId, device_id: deviceId } = request.body ?? {};
    if (!['backup', 'verify'].includes(kind)) {
      return reply.code(400).send({ error: 'kind must be backup or verify' });
    }
    if (sourceId != null && !isUuid(sourceId)) {
      return reply.code(400).send({ error: 'invalid source_id' });
    }
    if (sourceId) {
      const owned = await query('SELECT 1 FROM sources WHERE id = $1 AND owner_id = $2', [
        sourceId,
        request.user.id,
      ]);
      if (owned.rows.length === 0) return reply.code(404).send({ error: 'source not found' });
    }
    const { rows } = await query(
      `INSERT INTO backup_runs (owner_id, kind, source_id, device_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [request.user.id, kind, sourceId ?? null, deviceId ?? null],
    );
    return reply.code(201).send({ run: rows[0] });
  });

  app.patch('/api/backup/runs/:id', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const body = request.body ?? {};
    const { rows } = await query(
      `UPDATE backup_runs SET
         status = COALESCE($2, status),
         files_seen = COALESCE($3, files_seen),
         files_uploaded = COALESCE($4, files_uploaded),
         files_skipped = COALESCE($5, files_skipped),
         files_failed = COALESCE($6, files_failed),
         verified_ok = COALESCE($7, verified_ok),
         verified_missing = COALESCE($8, verified_missing),
         bytes_uploaded = COALESCE($9, bytes_uploaded),
         errors = COALESCE($10, errors),
         finished_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE finished_at END
       WHERE id = $1 AND owner_id = $11
       RETURNING *`,
      [
        request.params.id,
        body.status ?? null,
        body.files_seen ?? null,
        body.files_uploaded ?? null,
        body.files_skipped ?? null,
        body.files_failed ?? null,
        body.verified_ok ?? null,
        body.verified_missing ?? null,
        body.bytes_uploaded ?? null,
        body.errors ? JSON.stringify(body.errors) : null,
        request.user.id,
      ],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { run: rows[0] };
  });

  app.get('/api/backup/runs', async (request) => {
    const limit = clamp(Number(request.query?.limit ?? 20), 1, 100);
    const { rows } = await query(
      `SELECT * FROM backup_runs WHERE owner_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [request.user.id, limit],
    );
    return { runs: rows };
  });

  app.post('/api/media/:id/upload', { bodyLimit: config.uploadMaxBytes }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const item = await ownedItem(request.user.id, request.params.id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (item.source_kind === 'kdrive') {
      return reply.code(400).send({ error: 'already_on_kdrive' });
    }
    const destination = request.query?.destination === 'manual' ? 'manual' : 'source';
    let temp = null;
    try {
      temp = await streamToTempFile(request.body);
      if (temp.size === 0) {
        request.log.warn(
          { mediaId: item.id, contentLength: request.headers['content-length'] ?? null },
          'upload request with an empty body',
        );
        return reply.code(400).send({ error: 'empty_body' });
      }
      const metadata = await extractMetadata(temp.filePath, item.mime);
      const { folder, fileId } = await uploadToKDrive({
        item,
        destination,
        filePath: temp.filePath,
        size: temp.size,
      });
      await applyUploadedMetadata(item.id, metadata);
      await markUploaded(item.id, {
        fileId,
        parentId: folder.id,
        sha256: temp.sha256,
        size: temp.size,
      });
      return {
        ok: true,
        media_id: item.id,
        kdrive_file_id: fileId,
        kdrive_parent_id: folder.id,
        content_hash: temp.sha256,
        bytes: temp.size,
      };
    } catch (error) {
      if (error instanceof UploadTooLargeError) {
        request.log.warn({ err: error.message, mediaId: item.id }, 'upload too large');
        return reply.code(413).send({ error: 'upload_too_large', message: error.message });
      }
      request.log.warn({ err: error.message }, 'kDrive upload failed');
      await markUploadFailed(item.id, error.message);
      return reply.code(502).send({ error: 'upload_failed', message: error.message });
    } finally {
      await removeTempFile(temp?.filePath);
    }
  });

  app.post('/api/media/:id/verify', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const item = await ownedItem(request.user.id, request.params.id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (!item.kdrive_file_id) {
      return { ok: false, status: item.backup_status, reason: 'no_kdrive_file' };
    }
    try {
      const { client } = await getKDriveClient(request.user.id);
      const body = await client.getFile(item.kdrive_file_id);
      const file = body.data ?? body;
      const kdriveSize = Number(file?.size ?? -1);
      if (kdriveSize >= 0 && item.size_bytes != null && kdriveSize !== Number(item.size_bytes)) {
        await query(
          `UPDATE media_items SET backup_status = 'pending', backup_error = 'size_mismatch', updated_at = now()
           WHERE id = $1`,
          [item.id],
        );
        return { ok: false, status: 'pending', reason: 'size_mismatch', kdrive_size: kdriveSize };
      }
      return { ok: true, status: 'uploaded', kdrive_size: kdriveSize >= 0 ? kdriveSize : null };
    } catch (error) {
      if (/\(404\)/.test(error.message)) {
        await markMissingOnKDrive(item.id);
        return { ok: false, status: 'pending', reason: 'missing_on_kdrive' };
      }
      request.log.warn({ err: error.message }, 'kDrive verify failed');
      return reply.code(502).send({ error: 'verify_failed', message: error.message });
    }
  });
}
