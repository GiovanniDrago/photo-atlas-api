import crypto from 'node:crypto';
import { config } from '../config.js';

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
  };
}

export function withAssetUrls(row, baseUrl) {
  const urls = assetUrls(row.id);
  return {
    ...row,
    thumbnail_url: `${baseUrl}${urls.thumbnail_url}`,
    download_url: `${baseUrl}${urls.download_url}`,
  };
}
