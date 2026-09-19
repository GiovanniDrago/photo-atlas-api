import { query } from '../db.js';
import { decodeThumbnailB64 } from '../lib/thumbnail-payload.js';
import { computeMetadataStatus } from './enrich.js';
import { mediaTypeOf } from './kdrive.js';
import { writeThumbnail } from './media-assets.js';

const INSERT_SQL = `
  INSERT INTO media_items (
    source_id, external_key, path, name, mime, media_type, size_bytes,
    taken_at, file_created_at, modified_at, lat, lon, metadata_status,
    width, height, duration_s, thumb_path
  )
  SELECT
    $1::uuid, x.external_key, x.path, x.name, x.mime, x.media_type, x.size_bytes,
    x.taken_at, x.file_created_at, x.modified_at, x.lat, x.lon,
    COALESCE(x.metadata_status, 'none'),
    x.width, x.height, x.duration_s, x.thumb_path
  FROM jsonb_to_recordset($2::jsonb) AS x(
    external_key text, path text, name text, mime text, media_type text, size_bytes bigint,
    taken_at timestamptz, file_created_at timestamptz, modified_at timestamptz,
    lat double precision, lon double precision, metadata_status text,
    width integer, height integer, duration_s numeric, thumb_path text
  )
  ON CONFLICT (source_id, external_key) DO UPDATE SET
    path = EXCLUDED.path,
    name = EXCLUDED.name,
    mime = EXCLUDED.mime,
    media_type = EXCLUDED.media_type,
    size_bytes = EXCLUDED.size_bytes,
    taken_at = COALESCE(EXCLUDED.taken_at, media_items.taken_at),
    file_created_at = COALESCE(EXCLUDED.file_created_at, media_items.file_created_at),
    modified_at = COALESCE(EXCLUDED.modified_at, media_items.modified_at),
    lat = COALESCE(EXCLUDED.lat, media_items.lat),
    lon = COALESCE(EXCLUDED.lon, media_items.lon),
    metadata_status = CASE
      WHEN EXCLUDED.metadata_status = 'none' AND media_items.metadata_status <> 'none' THEN media_items.metadata_status
      ELSE EXCLUDED.metadata_status
    END,
    width = COALESCE(EXCLUDED.width, media_items.width),
    height = COALESCE(EXCLUDED.height, media_items.height),
    duration_s = COALESCE(EXCLUDED.duration_s, media_items.duration_s),
    thumb_path = COALESCE(EXCLUDED.thumb_path, media_items.thumb_path),
    updated_at = now()
  RETURNING id, external_key
`;

export function normalizeItem(item) {
  const mediaType = item.media_type ?? mediaTypeOf(item.name ?? '', item.mime) ?? 'image';
  const takenAt = item.taken_at ?? null;
  const lat = item.lat ?? null;
  const lon = item.lon ?? null;
  const metadataStatus = item.metadata_status ?? computeMetadataStatus({ takenAt, lat, lon });
  return {
    external_key: String(item.external_key ?? item.path ?? item.name),
    path: item.path ?? null,
    name: item.name ?? 'untitled',
    mime: item.mime ?? null,
    media_type: mediaType,
    size_bytes: item.size_bytes ?? null,
    taken_at: takenAt,
    file_created_at: item.file_created_at ?? null,
    modified_at: item.modified_at ?? null,
    lat,
    lon,
    metadata_status: metadataStatus,
    width: item.width ?? null,
    height: item.height ?? null,
    duration_s: item.duration_s ?? null,
    thumb_path: item.thumb_path ?? null,
  };
}

export async function upsertMediaItems(sourceId, items) {
  if (!items || items.length === 0) return 0;
  const normalized = items.map(normalizeItem);
  const thumbnails = new Map();
  for (const item of items) {
    const decoded = decodeThumbnailB64(item.thumbnail_b64);
    if (!decoded) continue;
    thumbnails.set(String(item.external_key ?? item.path ?? item.name), decoded);
  }
  const { rows } = await query(INSERT_SQL, [sourceId, JSON.stringify(normalized)]);
  if (thumbnails.size > 0) {
    await storeThumbnails(rows, thumbnails);
  }
  return rows;
}

export async function markKdriveBacked(sourceId, externalKeys) {
  if (!externalKeys || externalKeys.length === 0) return 0;
  const { rowCount } = await query(
    `UPDATE media_items SET
       backup_status = 'uploaded',
       kdrive_file_id = CASE
         WHEN external_key ~ '^[0-9]+$' THEN external_key::bigint
         ELSE kdrive_file_id
       END,
       backed_up_at = COALESCE(backed_up_at, now()),
       updated_at = now()
     WHERE source_id = $1 AND external_key = ANY($2::text[])`,
    [sourceId, externalKeys],
  );
  return rowCount;
}

async function storeThumbnails(rows, thumbnails) {
  const updates = [];
  for (const row of rows) {
    const buffer = thumbnails.get(row.external_key);
    if (!buffer) continue;
    try {
      const thumbPath = await writeThumbnail(row.id, buffer);
      updates.push({ id: row.id, thumb_path: thumbPath });
    } catch {
      continue;
    }
  }
  if (updates.length === 0) return;
  await query(
    `UPDATE media_items m
     SET thumb_path = x.thumb_path, updated_at = now()
     FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, thumb_path text)
     WHERE m.id = x.id`,
    [JSON.stringify(updates)],
  );
}

export async function updateScanRun(scanRunId, patch) {
  if (!scanRunId) return;
  await query(
    `UPDATE scan_runs SET
       status = COALESCE($2, status),
       files_seen = COALESCE($3, files_seen),
       files_indexed = COALESCE($4, files_indexed),
       files_skipped = COALESCE($5, files_skipped),
       errors = COALESCE($6, errors),
       finished_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [
      scanRunId,
      patch.status ?? null,
      patch.files_seen ?? null,
      patch.files_indexed ?? null,
      patch.files_skipped ?? null,
      patch.errors ? JSON.stringify(patch.errors) : null,
    ],
  );
}
