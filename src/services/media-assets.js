import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { query } from '../db.js';
import { getKDriveClient } from './kdrive-account.js';

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

export function thumbnailDir() {
  return path.join(config.mediaCacheDir, 'thumbs');
}

function cacheFilePath(mediaId, contentType) {
  return path.join(thumbnailDir(), `${mediaId}${EXT_BY_MIME[contentType] ?? '.img'}`);
}

export async function ensureThumbnail(item) {
  if (item.thumb_path && fs.existsSync(item.thumb_path)) {
    return { path: item.thumb_path, contentType: item.mime ?? 'image/jpeg' };
  }
  if (item.source_kind !== 'kdrive' || !item.external_key || !item.owner_id) {
    return null;
  }
  await fsp.mkdir(thumbnailDir(), { recursive: true });
  const { client } = await getKDriveClient(item.owner_id);
  const response = await client.fetchThumbnail(item.external_key, 320);
  if (!response.ok) return null;
  const contentType = response.headers.get('content-type') ?? 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = cacheFilePath(item.id, contentType);
  await fsp.writeFile(filePath, buffer);
  await query('UPDATE media_items SET thumb_path = $2, updated_at = now() WHERE id = $1', [
    item.id,
    filePath,
  ]);
  return { path: filePath, contentType };
}
