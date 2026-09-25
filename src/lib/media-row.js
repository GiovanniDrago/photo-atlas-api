import { withAssetUrls } from './signed-url.js';

export const MEDIA_BASE_FIELDS = `
  m.id, m.source_id, m.external_key, m.path, m.name, m.mime, m.media_type,
  m.size_bytes, m.taken_at, m.file_created_at, m.modified_at, m.lat, m.lon,
  (m.lat IS NOT NULL AND m.lon IS NOT NULL) AS has_gps,
  m.metadata_status, m.width, m.height, m.duration_s, m.indexed_at, m.updated_at,
  m.backup_status, m.kdrive_file_id, m.backed_up_at, m.backup_error,
  s.kind AS source_kind, s.label AS source_label
`;

export const MEDIA_JOIN = 'FROM media_items m JOIN sources s ON s.id = m.source_id';

export const MEDIA_ORDER = 'm.taken_at DESC NULLS LAST, m.indexed_at DESC, m.id DESC';

export function baseUrlOf(request) {
  return `${request.protocol}://${request.headers.host}`;
}

export function serializeMediaRow(row, request) {
  return withAssetUrls(row, baseUrlOf(request));
}
