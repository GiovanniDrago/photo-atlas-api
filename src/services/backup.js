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

export const DIRECT_UPLOAD_LIMIT = 1024 * 1024 * 1024;
export const CHUNK_SIZE = 1024 * 1024 * 1024;

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

export async function streamToTempFile(readable) {
  await fsp.mkdir(config.uploadTmpDir, { recursive: true });
  const filePath = path.join(config.uploadTmpDir, `upload-${crypto.randomUUID()}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(readable, meter, fs.createWriteStream(filePath));
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

async function uploadChunked(client, { parentId, name, size, filePath }) {
  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  const session = await client.startUploadSession({ parentId, name, size, totalChunks });
  const uploadUrl = session.upload_url ?? session.url;
  const sessionToken = session.session_token ?? session.token;
  if (!uploadUrl) {
    throw new Error('kDrive did not return an upload URL for the chunked session');
  }
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, size) - 1;
    const stream = fs.createReadStream(filePath, { start, end });
    await client.uploadChunk(uploadUrl, stream, { index, sessionToken });
  }
  return client.finishUploadSession(sessionToken);
}

export async function uploadToKDrive({ item, destination, filePath, size }) {
  const { client } = await getKDriveClient(item.owner_id);
  const folder = await ensureSourceFolder(client, item, destination);
  const uploaded =
    size <= DIRECT_UPLOAD_LIMIT
      ? await client.uploadFile({
          parentId: folder.id,
          name: item.name,
          size,
          body: fs.createReadStream(filePath),
        })
      : await uploadChunked(client, {
          parentId: folder.id,
          name: item.name,
          size,
          filePath,
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
       content_hash = $4,
       hash_algo = 'sha256',
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
