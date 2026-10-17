import { query } from '../db.js';
import { config } from '../config.js';
import { getKDriveClient } from '../services/kdrive-account.js';
import {
  UploadTooLargeError,
  applyUploadedMetadata,
  closeExpiredUploadSessions,
  closeUploadSession,
  extractMetadata,
  finishResumableUpload,
  getOpenUploadSession,
  isUploadSessionInvalid,
  markMissingOnKDrive,
  markUploadFailed,
  markUploaded,
  readStreamToBuffer,
  removeTempFile,
  startResumableUpload,
  streamToTempFile,
  uploadSessionChunk,
  uploadToKDrive,
} from '../services/backup.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function serializeSession(session) {
  return {
    id: session.id,
    chunk_size: Number(session.chunk_size),
    total_chunks: Number(session.total_chunks),
    uploaded_chunks: Number(session.uploaded_chunks),
    size_bytes: Number(session.size_bytes),
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const takenAt = typeof value.taken_at === 'string' ? new Date(value.taken_at) : null;
  return {
    takenAt: takenAt && !Number.isNaN(takenAt.getTime()) ? takenAt : null,
    lat: typeof value.lat === 'number' ? value.lat : null,
    lon: typeof value.lon === 'number' ? value.lon : null,
    width: typeof value.width === 'number' ? value.width : null,
    height: typeof value.height === 'number' ? value.height : null,
  };
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

/**
 * Resolves the media ids of this owner to act on for a retry: an explicit id
 * list, or the items of a source (optionally only the failed ones).
 */
async function ownedTargetIds(userId, { ids, sourceId, failedOnly }) {
  if (ids && ids.length > 0) {
    const { rows } = await query(
      `SELECT m.id FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE s.owner_id = $1 AND m.id = ANY($2::uuid[])`,
      [userId, ids],
    );
    return rows.map((row) => row.id);
  }
  if (!sourceId) return [];
  const statuses = failedOnly
    ? ['failed']
    : ['none', 'pending', 'uploading', 'failed', 'skipped'];
  const { rows } = await query(
    `SELECT m.id FROM media_items m
     JOIN sources s ON s.id = m.source_id
     WHERE s.owner_id = $1 AND m.source_id = $2
       AND m.backup_status = ANY($3::text[])`,
    [userId, sourceId, statuses],
  );
  return rows.map((row) => row.id);
}

/** Closes the open upload sessions of the given media (owner-scoped). */
async function closeSessionsFor(userId, mediaIds) {
  if (mediaIds.length === 0) return;
  await query(
    `UPDATE upload_sessions us
     SET status = 'closed', updated_at = now()
     WHERE us.status = 'open' AND us.media_id = ANY($1::uuid[])
       AND EXISTS (
         SELECT 1 FROM media_items m
         JOIN sources s ON s.id = m.source_id
         WHERE m.id = us.media_id AND s.owner_id = $2
       )`,
    [mediaIds, userId],
  );
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
         count(m.id) FILTER (WHERE m.backup_status IN ('none', 'pending', 'uploading'))::int AS pending,
         count(m.id) FILTER (WHERE m.backup_status = 'failed')::int AS failed,
         count(m.id) FILTER (WHERE m.backup_status = 'skipped')::int AS skipped,
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
        skipped: accumulator.skipped + Number(row.skipped),
        bytes_uploaded: accumulator.bytes_uploaded + Number(row.bytes_uploaded),
        bytes_total: accumulator.bytes_total + Number(row.bytes_total),
      }),
      { total: 0, uploaded: 0, pending: 0, failed: 0, skipped: 0, bytes_uploaded: 0, bytes_total: 0 },
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
    const staleBefore = new Date(Date.now() - config.staleUploadMs);
    await query(
      `UPDATE media_items m
       SET backup_status = 'pending', backup_error = 'stale_upload',
           backup_claimed_at = NULL, updated_at = now()
       FROM sources s
       WHERE m.source_id = s.id
         AND s.owner_id = $1
         AND m.backup_status = 'uploading'
         AND COALESCE(m.backup_claimed_at, m.updated_at) < $2`,
      [request.user.id, staleBefore],
    );
    const { rows } = await query(
      `WITH candidates AS (
         SELECT m.id, m.source_id
         FROM media_items m
         JOIN sources s ON s.id = m.source_id
         WHERE s.owner_id = $1
           AND s.kind = 'local'
           AND m.backup_status IN ('none', 'pending', 'failed')
           ${sourceClause}
         ORDER BY m.backup_attempts ASC, m.taken_at DESC NULLS LAST, m.indexed_at DESC
         LIMIT $${params.length}
         FOR UPDATE OF m SKIP LOCKED
       )
       UPDATE media_items m
       SET backup_status = 'uploading', backup_claimed_at = now(), updated_at = now()
       FROM candidates c
       JOIN sources s ON s.id = c.source_id
       WHERE m.id = c.id
       RETURNING m.id, m.source_id, m.external_key, m.path, m.name, m.mime, m.media_type,
                 m.size_bytes, m.backup_status, m.backup_attempts, m.backup_error,
                 s.label AS source_label`,
      params,
    );
    return { items: rows };
  });

  // Releases claims taken by an interrupted run (uploading -> pending) so the
  // next run can retry them immediately instead of waiting for the stale sweep.
  app.post('/api/backup/release', async (request, reply) => {
    const body = request.body ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid) : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'no_ids' });
    if (ids.length > config.maxBatchSize) {
      return reply.code(400).send({ error: 'too_many_ids' });
    }
    const result = await query(
      `UPDATE media_items m
       SET backup_status = 'pending', backup_error = NULL,
           backup_claimed_at = NULL, updated_at = now()
       FROM sources s
       WHERE m.source_id = s.id
         AND s.owner_id = $2
         AND m.id = ANY($1::uuid[])
         AND m.backup_status = 'uploading'`,
      [ids, request.user.id],
    );
    return { released: result.rowCount ?? 0 };
  });

  // Explicit recovery used by the app's "Retry": returns claims of this owner
  // that are not actively progressing (older than the grace window).
  app.post('/api/backup/recover', async (request, reply) => {
    const sourceId = request.body?.source_id ?? null;
    if (sourceId != null && !isUuid(sourceId)) {
      return reply.code(400).send({ error: 'invalid source_id' });
    }
    const params = [request.user.id, new Date(Date.now() - config.recoverGraceMs)];
    let sourceClause = '';
    if (sourceId) {
      params.push(sourceId);
      sourceClause = `AND m.source_id = $${params.length}`;
    }
    const result = await query(
      `UPDATE media_items m
       SET backup_status = 'pending', backup_error = NULL,
           backup_claimed_at = NULL, updated_at = now()
       FROM sources s
       WHERE m.source_id = s.id
         AND s.owner_id = $1
         AND m.backup_status = 'uploading'
         AND COALESCE(m.backup_claimed_at, m.updated_at) < $2
         ${sourceClause}`,
      params,
    );
    return { released: result.rowCount ?? 0 };
  });

  // Manual retry from the app's inspection screen: resets the selected items
  // (or a whole source) to pending and drops any dead upload session, so the
  // next run uploads them fresh.
  app.post('/api/backup/retry', async (request, reply) => {
    const body = request.body ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid) : [];
    const sourceId = body.source_id ?? null;
    const failedOnly = body.failed_only === true;
    if (sourceId != null && !isUuid(sourceId)) {
      return reply.code(400).send({ error: 'invalid source_id' });
    }
    if (ids.length === 0 && !sourceId) {
      return reply.code(400).send({ error: 'no_target' });
    }
    if (ids.length > config.maxBatchSize) {
      return reply.code(400).send({ error: 'too_many_ids' });
    }
    const targetIds = await ownedTargetIds(request.user.id, { ids, sourceId, failedOnly });
    if (targetIds.length === 0) return { queued: 0 };
    const { rowCount } = await query(
      `UPDATE media_items
       SET backup_status = 'pending', backup_error = NULL,
           backup_claimed_at = NULL, backup_attempts = 0, updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [targetIds],
    );
    await closeSessionsFor(request.user.id, targetIds);
    return { queued: rowCount ?? 0 };
  });

  // Marks items as 'skipped' so runs stop retrying them (an explicit retry
  // brings them back to pending).
  app.post('/api/backup/skip', async (request, reply) => {
    const body = request.body ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid) : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'no_ids' });
    if (ids.length > config.maxBatchSize) {
      return reply.code(400).send({ error: 'too_many_ids' });
    }
    const result = await query(
      `UPDATE media_items m
       SET backup_status = 'skipped', backup_error = NULL,
           backup_claimed_at = NULL, updated_at = now()
       FROM sources s
       WHERE m.source_id = s.id
         AND s.owner_id = $2
         AND m.id = ANY($1::uuid[])
         AND m.backup_status <> 'uploaded'`,
      [ids, request.user.id],
    );
    await closeSessionsFor(request.user.id, ids);
    return { skipped: result.rowCount ?? 0 };
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
    const run = rows[0];
    if (run.kind === 'backup' && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      await query(
        `UPDATE sources SET backup_last_run_at = now()
         WHERE owner_id = $1 AND kind = 'local' AND ($2::uuid IS NULL OR id = $2::uuid)`,
        [request.user.id, run.source_id],
      );
    }
    return { run };
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
    // The app can give up (or be closed) while the file is still travelling to
    // kDrive: the upload is not aborted, so record it in the logs.
    let clientDisconnected = false;
    request.raw.on('close', () => {
      if (!reply.raw.writableEnded) clientDisconnected = true;
    });
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
        log: request.log,
      });
      await applyUploadedMetadata(item.id, metadata);
      await markUploaded(item.id, {
        fileId,
        parentId: folder.id,
        sha256: temp.sha256,
        size: temp.size,
      });
      if (clientDisconnected) {
        request.log.warn(
          { mediaId: item.id, name: item.name, bytes: temp.size },
          'upload finished after the client disconnected',
        );
      }
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
      request.log.warn(
        {
          err: error.message,
          cause: error.cause?.code ?? error.cause?.message ?? null,
          mediaId: item.id,
          clientDisconnected,
        },
        'kDrive upload failed',
      );
      await markUploadFailed(item.id, error.message);
      return reply.code(502).send({ error: 'upload_failed', message: error.message });
    } finally {
      await removeTempFile(temp?.filePath);
    }
  });

  // --- Resumable (client-driven) chunked upload ---------------------------
  // Used for large files (long videos) over a slow link: the client uploads
  // chunks one by one to a kDrive session. If the run is interrupted the
  // session stays open and the next run resumes from uploaded_chunks.

  app.post('/api/media/:id/upload/init', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const item = await ownedItem(request.user.id, request.params.id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (item.source_kind === 'kdrive') {
      return reply.code(400).send({ error: 'already_on_kdrive' });
    }
    const destination = request.query?.destination === 'manual' ? 'manual' : 'source';
    const body = request.body ?? {};
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) {
      return reply.code(400).send({ error: 'invalid_size' });
    }
    const chunkSize = clamp(
      Number(body.chunk_size ?? config.clientUploadChunkBytes),
      256 * 1024,
      64 * 1024 * 1024,
    );
    const name =
      typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim()
        : item.name;
    const existing = await getOpenUploadSession(item.id);
    if (existing) {
      if (Number(existing.size_bytes) === size) {
        return { session: serializeSession(existing) };
      }
      await closeUploadSession(existing.id);
    }
    // kDrive cancels a session after 4 hours; drop any dead 'open' row so the
    // new one can be inserted (partial unique index: one open session/media).
    await closeExpiredUploadSessions(item.id);
    try {
      const { session } = await startResumableUpload({
        item,
        destination,
        size,
        chunkSize,
        name,
      });
      return { session: serializeSession(session) };
    } catch (error) {
      request.log.warn({ err: error.message, mediaId: item.id }, 'kDrive session start failed');
      return reply.code(502).send({ error: 'upload_failed', message: error.message });
    }
  });

  app.post(
    '/api/media/:id/upload/chunk',
    { bodyLimit: config.uploadMaxBytes },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
      const index = Number(request.query?.index);
      if (!Number.isInteger(index) || index < 0) {
        return reply.code(400).send({ error: 'invalid_index' });
      }
      const item = await ownedItem(request.user.id, request.params.id);
      if (!item) return reply.code(404).send({ error: 'not_found' });
      const session = await getOpenUploadSession(item.id);
      if (!session) return reply.code(409).send({ error: 'no_session' });
      const total = Number(session.total_chunks);
      const uploaded = Number(session.uploaded_chunks);
      if (index >= total) return reply.code(400).send({ error: 'index_out_of_range' });
      if (index < uploaded) {
        return { ok: true, uploaded_chunks: uploaded, total_chunks: total };
      }
      if (index > uploaded) {
        return reply
          .code(409)
          .send({ error: 'out_of_order', uploaded_chunks: uploaded, total_chunks: total });
      }
      let buffer;
      try {
        buffer = await readStreamToBuffer(request.body);
      } catch (error) {
        if (error instanceof UploadTooLargeError) {
          return reply.code(413).send({ error: 'upload_too_large', message: error.message });
        }
        throw error;
      }
      if (buffer.length === 0) return reply.code(400).send({ error: 'empty_chunk' });
      try {
        await uploadSessionChunk({ ownerId: request.user.id, session, index, buffer });
      } catch (error) {
        if (isUploadSessionInvalid(error)) {
          // The kDrive token expired (sessions last 4 hours): close it so the
          // client can open a fresh one and restart.
          await closeUploadSession(session.id);
          request.log.warn({ mediaId: item.id, index }, 'kDrive upload session expired');
          return reply.code(410).send({ error: 'session_expired' });
        }
        request.log.warn(
          { err: error.message, mediaId: item.id, index },
          'kDrive chunk upload failed',
        );
        return reply.code(502).send({ error: 'upload_failed', message: error.message });
      }
      return { ok: true, uploaded_chunks: index + 1, total_chunks: total };
    },
  );

  app.post('/api/media/:id/upload/finish', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const item = await ownedItem(request.user.id, request.params.id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const session = await getOpenUploadSession(item.id);
    if (!session) return reply.code(409).send({ error: 'no_session' });
    const uploaded = Number(session.uploaded_chunks);
    const total = Number(session.total_chunks);
    if (uploaded < total) {
      return reply
        .code(409)
        .send({ error: 'incomplete', uploaded_chunks: uploaded, total_chunks: total });
    }
    const body = request.body ?? {};
    const sha256 =
      typeof body.content_hash === 'string' && body.content_hash.length > 0
        ? body.content_hash
        : null;
    const size = Number(body.size ?? session.size_bytes);
    try {
      const metadata = normalizeMetadata(body.metadata);
      if (metadata) await applyUploadedMetadata(item.id, metadata);
      const { fileId } = await finishResumableUpload({
        ownerId: request.user.id,
        session,
      });
      await markUploaded(item.id, {
        fileId,
        parentId: session.parent_id,
        sha256,
        size,
      });
      return {
        ok: true,
        media_id: item.id,
        kdrive_file_id: fileId,
        kdrive_parent_id: session.parent_id,
        content_hash: sha256,
        bytes: size,
      };
    } catch (error) {
      if (error instanceof UploadTooLargeError) {
        return reply.code(413).send({ error: 'upload_too_large', message: error.message });
      }
      if (isUploadSessionInvalid(error)) {
        await closeUploadSession(session.id);
        request.log.warn({ mediaId: item.id }, 'kDrive upload session expired on finish');
        return reply.code(410).send({ error: 'session_expired' });
      }
      request.log.warn({ err: error.message, mediaId: item.id }, 'kDrive session finish failed');
      await markUploadFailed(item.id, error.message);
      return reply.code(502).send({ error: 'upload_failed', message: error.message });
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
