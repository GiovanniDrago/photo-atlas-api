export const MAX_THUMBNAIL_BYTES = 256 * 1024;

const MAX_BASE64_LENGTH = Math.ceil(MAX_THUMBNAIL_BYTES / 3) * 4 + 16;

export function decodeThumbnailB64(value) {
  if (typeof value !== 'string') return null;
  const payload = value.trim();
  if (payload.length === 0 || payload.length > MAX_BASE64_LENGTH) return null;
  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    return null;
  }
  if (buffer.length < 4 || buffer.length > MAX_THUMBNAIL_BYTES) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  return buffer;
}
