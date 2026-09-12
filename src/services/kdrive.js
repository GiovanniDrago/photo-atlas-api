const DEFAULT_MIN_INTERVAL_MS = 1100;

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif', 'dng', 'raw', 'cr2', 'nef', 'arw',
]);

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp', 'mpg', 'mpeg', 'wmv',
]);

export function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index + 1).toLowerCase();
}

export function mediaTypeOf(name, mime) {
  const mimeValue = (mime ?? '').toLowerCase();
  if (mimeValue.startsWith('image/')) return 'image';
  if (mimeValue.startsWith('video/')) return 'video';
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

export class KDriveClient {
  constructor({ token, driveId, baseUrl = 'https://api.infomaniak.com', minIntervalMs = DEFAULT_MIN_INTERVAL_MS }) {
    this.token = token;
    this.driveId = driveId;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.minIntervalMs = minIntervalMs;
    this.lastRequestAt = 0;
  }

  async throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
  }

  async requestJson(pathname, { method = 'GET', query: queryParams } = {}) {
    await this.throttle();
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(queryParams ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`kDrive request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async requestStream(pathname) {
    await this.throttle();
    return fetch(`${this.baseUrl}${pathname}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }

  getDrive() {
    return this.requestJson(`/2/drive/${this.driveId}`);
  }

  getFile(fileId) {
    return this.requestJson(`/3/drive/${this.driveId}/files/${fileId}`);
  }

  async listChildren(fileId, { type, cursor, limit = 100 } = {}) {
    const body = await this.requestJson(`/3/drive/${this.driveId}/files/${fileId}/files`, {
      query: { type, cursor, limit },
    });
    return {
      items: body.data ?? [],
      cursor: body.cursor ?? null,
      hasMore: Boolean(body.has_more),
    };
  }

  async search(term, { directoryId, depth } = {}) {
    const body = await this.requestJson(`/3/drive/${this.driveId}/files/search`, {
      query: { query: term, directory_id: directoryId, depth },
    });
    return body.data ?? [];
  }

  async *walkFiles(rootId) {
    const queue = [rootId];
    while (queue.length > 0) {
      const directoryId = queue.shift();
      let cursor;
      do {
        const page = await this.listChildren(directoryId, { cursor });
        for (const item of page.items) {
          if (item.type === 'dir') {
            queue.push(item.id);
          } else if (item.type === 'file') {
            yield item;
          }
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    }
  }

  async readPrefix(fileId, byteCount = 262144) {
    const response = await this.requestStream(`/2/drive/${this.driveId}/files/${fileId}/download`);
    if (!response.ok) {
      throw new Error(`kDrive download failed (${response.status})`);
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (received < byteCount) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
    }
    await reader.cancel().catch(() => {});
    return Buffer.concat(chunks);
  }

  async fetchThumbnail(fileId, width = 256) {
    return this.requestStream(`/2/drive/${this.driveId}/files/${fileId}/thumbnail?width=${width}`);
  }
}
