import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import exifr from 'exifr';
import { config } from '../config.js';
import { query } from '../db.js';
import { getKDriveClient } from './kdrive-account.js';
import { computeMetadataStatus } from './enrich.js';
import { isRetryableUploadError } from './kdrive.js';

/** Files up to this size go in one request; bigger ones use a chunk session. */
function directUploadLimit() {
  return Math.max(0, config.directUploadLimitBytes);
}

/** Chunk size for session uploads (kDrive allows up to 1 GB per chunk). */
function uploadChunkSize() {
  return Math.min(Math.max(1, config.uploadChunkSizeBytes), 1024 * 1024 * 1024);
}

/** Transient network failures are retried; kDrive 4xx are not. */
const UPLOAD_RETRY_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_DELAY_MS = 750;

/**
 * Runs [attempt] again on retryable upload failures (socket resets, timeouts,
 * 429/5xx from kDrive) with exponential backoff. The caller must recreate the
 * body stream on every call: a failed fetch consumes it.
 */
async function withUploadRetry(attempt) {
  let lastError;
  for (let tryIndex = 1; tryIndex <= UPLOAD_RETRY_ATTEMPTS; tryIndex += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isRetryableUploadError(error) || tryIndex === UPLOAD_RETRY_ATTEMPTS) throw error;
      const delay = UPLOAD_RETRY_BASE_DELAY_MS * 2 ** (tryIndex - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function sanitizeFolderName(value, fallback = 'Album') {
  const cleaned = String(value ?? '')
    .replace(/[\\/]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export function manualFolderParts() {
  return [...config.kdriveBasePath, 'Manual'];
}

export function sourceFolderParts(label) {
  return [...config.kdriveBasePath, sanitizeFolderName(label, 'Album')];
}

export class UploadTooLargeError extends Error {
  constructor(maxBytes) {
    super(`upload exceeds the ${maxBytes} byte limit`);
    this.name = 'UploadTooLargeError';
  }
}

export async function streamToTempFile(readable, { maxBytes = config.uploadMaxBytes } = {}) {
  await fsp.mkdir(config.uploadTmpDir, { recursive: true });
  const filePath = path.join(config.uploadTmpDir, `upload-${crypto.randomUUID()}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) {
        callback(new UploadTooLargeError(maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(readable, meter, fs.createWriteStream(filePath));
  } catch (error) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
  return { filePath, size, sha256: hash.digest('hex') };
}

export async function removeTempFile(filePath) {
  if (!filePath) return;
  await fsp.rm(filePath, { force: true }).catch(() => {});
}

export async function sweepUploadTmpDir(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const entries = await fsp.readdir(config.uploadTmpDir);
    const now = Date.now();
    for (const entry of entries) {
      const filePath = path.join(config.uploadTmpDir, entry);
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat && now - stat.mtimeMs > maxAgeMs) {
        await fsp.rm(filePath, { force: true }).catch(() => {});
      }
    }
  } catch {
    // The directory is created on the first upload.
  }
}

export async function extractMetadata(filePath, mime) {
  if (!mime || !mime.startsWith('image/')) return null;
  try {
    const data = await exifr.parse(filePath, { gps: true, exif: true, tiff: true });
    if (!data) return null;
    const takenAt = data.DateTimeOriginal ?? data.CreateDate ?? data.ModifyDate ?? null;
    return {
      takenAt: takenAt instanceof Date ? takenAt : null,
      lat: typeof data.latitude === 'number' ? data.latitude : null,
      lon: typeof data.longitude === 'number' ? data.longitude : null,
      width:
        typeof data.ExifImageWidth === 'number'
          ? data.ExifImageWidth
          : typeof data.ImageWidth === 'number'
            ? data.ImageWidth
            : null,
      height:
        typeof data.ExifImageHeight === 'number'
          ? data.ExifImageHeight
          : typeof data.ImageHeight === 'number'
            ? data.ImageHeight
            : null,
    };
  } catch {
    return null;
  }
}

const manualFolderCache = new Map();

async function ensureManualFolder(client, userId) {
  const cached = manualFolderCache.get(userId);
  if (cached) return cached;
  const folder = await client.ensureFolderPath(manualFolderParts());
  manualFolderCache.set(userId, folder);
  return folder;
}

async function ensureSourceFolder(client, item, destination) {
  if (destination === 'manual') {
    return ensureManualFolder(client, item.owner_id);
  }
  if (item.backup_folder_id) {
    return { id: item.backup_folder_id, path: item.backup_folder_path ?? sourceFolderParts(item.source_label).join('/') };
  }
  const folder = await client.ensureFolderPath(sourceFolderParts(item.source_label));
  await query(
    'UPDATE sources SET backup_folder_id = $2, backup_folder_path = $3 WHERE id = $1',
    [item.source_id, folder.id, folder.path],
  );
  return folder;
}

export async function uploadChunked(client, { parentId, name, size, filePath, log = null }) {
  const chunkSize = uploadChunkSize();
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const session = await client.startUploadSession({ parentId, name, size, totalChunks });
  const uploadUrl = session.upload_url ?? session.url;
  const sessionToken = session.token ?? session.session_token;
  if (!uploadUrl || !sessionToken) {
    throw new Error('kDrive did not return an upload URL for the chunked session');
  }
  log?.info({ name, size, totalChunks }, 'kDrive chunked upload started');
  const handle = await fsp.open(filePath, 'r');
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const length = Math.min(chunkSize, size - start);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const chunkHash = `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
      const chunkStartedAt = Date.now();
      await withUploadRetry(() =>
        client.uploadChunk(uploadUrl, buffer, {
          sessionToken,
          chunkNumber: index + 1,
          chunkSize: length,
          chunkHash,
        }),
      );
      log?.info(
        {
          name,
          chunk: index + 1,
          totalChunks,
          bytes: length,
          ms: Date.now() - chunkStartedAt,
        },
        'kDrive chunk uploaded',
      );
    }
  } finally {
    await handle.close();
  }
  return withUploadRetry(() => client.finishUploadSession(uploadUrl, sessionToken));
}

export async function uploadToKDrive({ item, destination, filePath, size, log = null }) {
  const { client } = await getKDriveClient(item.owner_id);
  const folder = await ensureSourceFolder(client, item, destination);
  const uploaded =
    size <= directUploadLimit()
      ? await withUploadRetry(() =>
          client.uploadFile({
            parentId: folder.id,
            name: item.name,
            size,
            body: fs.createReadStream(filePath),
          }),
        )
      : await uploadChunked(client, {
          parentId: folder.id,
          name: item.name,
          size,
          filePath,
          log,
        });
  const fileId = uploaded?.id ?? uploaded?.file?.id ?? null;
  return { folder, fileId, uploaded };
}

export async function applyUploadedMetadata(itemId, metadata) {
  if (!metadata) return;
  const { rows } = await query('SELECT taken_at, lat, lon FROM media_items WHERE id = $1', [itemId]);
  const current = rows[0] ?? {};
  const takenAt = current.taken_at ?? metadata.takenAt ?? null;
  const lat = current.lat ?? metadata.lat ?? null;
  const lon = current.lon ?? metadata.lon ?? null;
  const status = computeMetadataStatus({ takenAt, lat, lon });
  await query(
    `UPDATE media_items SET
       taken_at = COALESCE(taken_at, $2),
       lat = COALESCE(lat, $3),
       lon = COALESCE(lon, $4),
       width = COALESCE(width, $5),
       height = COALESCE(height, $6),
       metadata_status = $7,
       updated_at = now()
     WHERE id = $1`,
    [itemId, metadata.takenAt ?? null, metadata.lat ?? null, metadata.lon ?? null, metadata.width ?? null, metadata.height ?? null, status],
  );
}

export async function markUploaded(itemId, { fileId, parentId, sha256, size }) {
  await query(
    `UPDATE media_items SET
       backup_status = 'uploaded',
       kdrive_file_id = $2,
       kdrive_parent_id = $3,
       content_hash = COALESCE($4, content_hash),
       hash_algo = CASE WHEN $4 IS NULL THEN hash_algo ELSE 'sha256' END,
       backed_up_at = now(),
       backup_error = NULL,
       backup_attempts = backup_attempts + 1,
       updated_at = now()
     WHERE id = $1`,
    [itemId, fileId, parentId, sha256],
  );
  if (size != null) {
    await query('UPDATE media_items SET size_bytes = COALESCE(size_bytes, $2) WHERE id = $1', [itemId, size]);
  }
}

export async function markUploadFailed(itemId, message) {
  await query(
    `UPDATE media_items SET
       backup_status = 'failed',
       backup_error = $2,
       backup_attempts = backup_attempts + 1,
       updated_at = now()
     WHERE id = $1`,
    [itemId, String(message ?? 'upload failed').slice(0, 500)],
  );
}

/** Reads a small request body (one chunk) into memory, enforcing the cap. */
export async function readStreamToBuffer(readable, { maxBytes = config.uploadMaxBytes } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    size += chunk.length;
    if (maxBytes > 0 && size > maxBytes) throw new UploadTooLargeError(maxBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The open, non-expired kDrive session for an item, if any (for resume). */
export async function getOpenUploadSession(mediaId) {
  const { rows } = await query(
    `SELECT * FROM upload_sessions
     WHERE media_id = $1 AND status = 'open'
       AND expires_at IS NOT NULL AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [mediaId],
  );
  return rows[0] ?? null;
}

/**
 * Closes open sessions that kDrive has already cancelled (expired `expires_at`,
 * or legacy rows with a NULL deadline). Needed before opening a new session for
 * the same item: the partial unique index allows only one 'open' row per media.
 */
export async function closeExpiredUploadSessions(mediaId) {
  const { rowCount } = await query(
    `UPDATE upload_sessions
     SET status = 'closed', updated_at = now()
     WHERE media_id = $1 AND status = 'open'
       AND (expires_at IS NULL OR expires_at <= now())`,
    [mediaId],
  );
  return rowCount ?? 0;
}

export async function closeUploadSession(sessionId) {
  await query(
    "UPDATE upload_sessions SET status = 'closed', updated_at = now() WHERE id = $1",
    [sessionId],
  );
}

/** True when kDrive rejected the chunk/finish because the session token died. */
export function isUploadSessionInvalid(error) {
  const message = String(error?.message ?? '');
  return (
    error?.status === 400 &&
    /invalid_upload_token|upload token is invalid/i.test(message)
  );
}

/** Opens a kDrive chunked session and records it for resuming. */
export async function startResumableUpload({ item, destination, size, chunkSize, name }) {
  const { client } = await getKDriveClient(item.owner_id);
  const folder = await ensureSourceFolder(client, item, destination);
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const session = await client.startUploadSession({
    parentId: folder.id,
    name,
    size,
    totalChunks,
  });
  const uploadUrl = session.upload_url ?? session.url;
  const sessionToken = session.token ?? session.session_token;
  if (!uploadUrl || !sessionToken) {
    throw new Error('kDrive did not return an upload URL for the chunked session');
  }
  // kDrive cancels a session after 4 hours; store the deadline so it is never
  // resumed afterwards.
  const expiresAt = new Date(Date.now() + config.uploadSessionTtlMs);
  const { rows } = await query(
    `INSERT INTO upload_sessions
       (media_id, session_token, upload_url, total_chunks, uploaded_chunks,
        chunk_size, size_bytes, parent_id, status, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 'open', $8, now())
     RETURNING *`,
    [item.id, sessionToken, uploadUrl, totalChunks, chunkSize, size, folder.id, expiresAt],
  );
  return { session: rows[0], folder };
}

/** Forwards one chunk (0-based [index]) to the kDrive session. */
export async function uploadSessionChunk({ ownerId, session, index, buffer }) {
  const { client } = await getKDriveClient(ownerId);
  const chunkHash = `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
  await withUploadRetry(() =>
    client.uploadChunk(session.upload_url, buffer, {
      sessionToken: session.session_token,
      chunkNumber: index + 1,
      chunkSize: buffer.length,
      chunkHash,
    }),
  );
  await query(
    'UPDATE upload_sessions SET uploaded_chunks = $2, updated_at = now() WHERE id = $1',
    [session.id, index + 1],
  );
}

/** Finalizes the kDrive session; returns the created file id. */
export async function finishResumableUpload({ ownerId, session }) {
  const { client } = await getKDriveClient(ownerId);
  const uploaded = await withUploadRetry(() =>
    client.finishUploadSession(session.upload_url, session.session_token),
  );
  const fileId = uploaded?.id ?? uploaded?.file?.id ?? null;
  await closeUploadSession(session.id);
  return { fileId };
}

export async function markMissingOnKDrive(itemId) {
  await query(
    `UPDATE media_items SET
       backup_status = 'pending',
       kdrive_file_id = NULL,
       backup_error = 'missing_on_kdrive',
       updated_at = now()
     WHERE id = $1`,
    [itemId],
  );
}
