import { open } from 'node:fs/promises';
import exifr from 'exifr';

const PICK_FIELDS = [
  'DateTimeOriginal',
  'CreateDate',
  'ModifyDate',
  'GPSLatitude',
  'GPSLongitude',
  'ExifImageWidth',
  'ExifImageHeight',
  'ImageWidth',
  'ImageHeight',
];

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function readLocalPrefix(filePath, byteCount = 262144) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function extractImageMetadata(buffer) {
  if (!buffer || buffer.length === 0) return {};
  try {
    const data = await exifr.parse(buffer, { gps: true, pick: PICK_FIELDS, silentErrors: true });
    if (!data) return {};
    const lat = data.GPSLatitude ?? data.latitude ?? null;
    const lon = data.GPSLongitude ?? data.longitude ?? null;
    return {
      takenAt: toIso(data.DateTimeOriginal ?? data.CreateDate ?? data.ModifyDate),
      lat: typeof lat === 'number' ? lat : null,
      lon: typeof lon === 'number' ? lon : null,
      width: data.ExifImageWidth ?? data.ImageWidth ?? null,
      height: data.ExifImageHeight ?? data.ImageHeight ?? null,
    };
  } catch {
    return {};
  }
}

export function computeMetadataStatus({ takenAt, lat, lon }) {
  const hasTime = Boolean(takenAt);
  const hasGeo = lat !== null && lat !== undefined && lon !== null && lon !== undefined;
  if (hasTime && hasGeo) return 'full';
  if (hasTime || hasGeo) return 'partial';
  return 'none';
}
