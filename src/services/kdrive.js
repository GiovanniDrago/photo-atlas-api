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

export function buildChildQuery({ type, cursor, limit } = {}) {
  const search = new URLSearchParams();
  if (type) search.set('type[]', type);
  if (cursor) search.set('cursor', cursor);
  if (limit) search.set('limit', String(limit));
  return search.toString();
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

  async requestJson(pathname, { method = 'GET', query: queryParams, body } = {}) {
    await this.throttle();
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(queryParams ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
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
    const query = buildChildQuery({ type, cursor, limit });
    const suffix = query ? `?${query}` : '';
    const body = await this.requestJson(
      `/3/drive/${this.driveId}/files/${fileId}/files${suffix}`,
    );
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

  async download(fileId) {
    return this.requestStream(`/2/drive/${this.driveId}/files/${fileId}/download`);
  }

  async deleteFile(fileId) {
    return this.requestJson(`/2/drive/${this.driveId}/files/${fileId}`, { method: 'DELETE' });
  }

  async findChildFolder(parentId, name) {
    let cursor;
    do {
      const page = await this.listChildren(parentId, { type: 'dir', cursor });
      const match = page.items.find((item) => item.name === name);
      if (match) return match;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return null;
  }

  async createFolder(parentId, name) {
    const body = await this.requestJson(`/3/drive/${this.driveId}/files/${parentId}/directory`, {
      method: 'POST',
      body: { name },
    });
    return body.data ?? body;
  }

  async ensureFolderPath(parts) {
    let parentId = 1;
    const walked = [];
    for (const part of parts) {
      walked.push(part);
      const existing = await this.findChildFolder(parentId, part);
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const created = await this.createFolder(parentId, part);
      const createdId = created?.id ?? created?.data?.id;
      if (!createdId) {
        throw new Error(`kDrive folder creation failed for ${walked.join('/')}`);
      }
      parentId = createdId;
    }
    return { id: parentId, path: walked.join('/') };
  }

  async uploadFile({ parentId, name, size, body }) {
    await this.throttle();
    const url = new URL(`${this.baseUrl}/3/drive/${this.driveId}/upload`);
    url.searchParams.set('directory_id', String(parentId));
    url.searchParams.set('file_name', name);
    url.searchParams.set('total_size', String(size));
    url.searchParams.set('conflict', 'rename');
    const isStream = body && typeof body !== 'string' && !Buffer.isBuffer(body);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
      ...(isStream ? { duplex: 'half' } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`kDrive upload failed (${response.status}): ${text.slice(0, 300)}`);
    }
    const parsed = text ? JSON.parse(text) : {};
    return parsed.data ?? parsed;
  }

  async startUploadSession({ parentId, name, size, totalChunks, conflict = 'rename' }) {
    const body = await this.requestJson(`/3/drive/${this.driveId}/upload/session/start`, {
      method: 'POST',
      body: {
        file_name: name,
        directory_id: parentId,
        total_size: size,
        total_chunks: totalChunks,
        conflict,
      },
    });
    return body.data ?? body;
  }

  async uploadChunk(uploadUrl, chunk, { index, sessionToken } = {}) {
    await this.throttle();
    const url = new URL(uploadUrl);
    if (index !== undefined && index !== null) url.searchParams.set('chunk', String(index));
    const isStream = chunk && typeof chunk !== 'string' && !Buffer.isBuffer(chunk);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}),
      },
      body: chunk,
      ...(isStream ? { duplex: 'half' } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`kDrive chunk upload failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async finishUploadSession(sessionToken) {
    const body = await this.requestJson(`/3/drive/${this.driveId}/upload/session/finish`, {
      method: 'POST',
      body: { session_token: sessionToken },
    });
    return body.data ?? body;
  }
}
