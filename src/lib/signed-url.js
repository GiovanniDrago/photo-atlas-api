import crypto from 'node:crypto';
import { config } from '../config.js';
import { isAllowedLocalPath } from './local-paths.js';

function secret() {
  return config.mediaUrlSecret;
}

export function signAsset(kind, mediaId) {
  return crypto
    .createHmac('sha256', secret())
    .update(`${kind}:${mediaId}`)
    .digest('hex');
}

export function verifyAssetSignature(kind, mediaId, signature) {
  if (!mediaId || !signature) return false;
  const expected = Buffer.from(signAsset(kind, mediaId));
  const provided = Buffer.from(String(signature));
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export function assetUrls(mediaId) {
  return {
    thumbnail_url: `/api/media/${mediaId}/thumbnail?m=${mediaId}&s=${signAsset('thumb', mediaId)}`,
    download_url: `/api/media/${mediaId}/download?m=${mediaId}&s=${signAsset('download', mediaId)}`,
    stream_url: `/api/media/${mediaId}/stream?m=${mediaId}&s=${signAsset('stream', mediaId)}`,
  };
}

export function withAssetUrls(row, baseUrl) {
  const urls = assetUrls(row.id);
  // Uploaded items stay on a local source row but their file lives on kDrive:
  // the cloud copy makes both download and streaming available.
  const cloudAvailable =
    row.kdrive_file_id != null || row.source_kind === 'kdrive';
  const available = cloudAvailable || isAllowedLocalPath(row.path);
  return {
    ...row,
    thumbnail_url: `${baseUrl}${urls.thumbnail_url}`,
    download_url: available ? `${baseUrl}${urls.download_url}` : null,
    stream_url: available ? `${baseUrl}${urls.stream_url}` : null,
  };
}
