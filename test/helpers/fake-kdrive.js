import http from 'node:http';
import { config } from '../../src/config.js';

const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

export async function startFakeKDrive() {
  const state = {
    folders: new Map(),
    files: new Map(),
    uploads: [],
    sessions: [],
    deleted: [],
    thumbnails: [],
    downloads: [],
    downloadAttempts: 0,
    failNextDownloads: 0,
    nextId: 1000,
    // Failure injection for the upload retry tests.
    uploadAttempts: 0,
    chunkAttempts: 0,
    failNextUploads: 0,
    failNextChunks: 0,
    failUploadStatus: null,
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    const path = url.pathname;
    let match;

    match = path.match(/^\/3\/drive\/(\d+)\/files\/(\d+)\/files$/);
    if (match && request.method === 'GET') {
      const parent = Number(match[2]);
      const type = url.searchParams.get('type[]') ?? url.searchParams.get('type');
      let items = state.folders.get(parent) ?? [];
      if (type === 'dir') items = items.filter((item) => item.type === 'dir');
      return send(200, { data: items, has_more: false, cursor: null });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/files\/(\d+)\/directory$/);
    if (match && request.method === 'POST') {
      const parent = Number(match[2]);
      const body = JSON.parse((await readBody()).toString() || '{}');
      const folder = { id: state.nextId++, name: body.name, type: 'dir' };
      const list = state.folders.get(parent) ?? [];
      list.push(folder);
      state.folders.set(parent, list);
      return send(200, { data: folder });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/upload$/);
    if (match && request.method === 'POST') {
      state.uploadAttempts += 1;
      if (state.failUploadStatus !== null) {
        const status = state.failUploadStatus;
        state.failUploadStatus = null;
        return send(status, { result: 'error', error: { description: 'injected failure' } });
      }
      if (state.failNextUploads > 0) {
        state.failNextUploads -= 1;
        request.socket.destroy();
        return;
      }
      const bytes = await readBody();
      const directoryId = Number(url.searchParams.get('directory_id'));
      const fileName = url.searchParams.get('file_name');
      const totalSize = Number(url.searchParams.get('total_size'));
      state.uploads.push({
        directoryId,
        fileName,
        totalSize,
        conflict: url.searchParams.get('conflict'),
        bytes: bytes.length,
      });
      const file = {
        id: state.nextId++,
        name: fileName,
        size: bytes.length,
        parentId: directoryId,
        type: 'file',
        content: bytes,
      };
      state.files.set(file.id, file);
      return send(200, { data: file });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/upload\/session\/start$/);
    if (match && request.method === 'POST') {
      const body = JSON.parse((await readBody()).toString() || '{}');
      const session = { ...body, token: `session-${state.nextId++}`, chunks: [], finished: false };
      state.sessions.push(session);
      return send(200, {
        data: {
          upload_url: `http://127.0.0.1:${server.address().port}`,
          token: session.token,
        },
      });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/upload\/session\/([^/]+)\/chunk$/);
    if (match && request.method === 'POST') {
      state.chunkAttempts += 1;
      if (state.failNextChunks > 0) {
        state.failNextChunks -= 1;
        request.socket.destroy();
        return;
      }
      const bytes = await readBody();
      const session = state.sessions.find((item) => item.token === match[2]);
      if (session) {
        session.chunks.push({
          number: Number(url.searchParams.get('chunk_number')),
          size: Number(url.searchParams.get('chunk_size')),
          hash: url.searchParams.get('chunk_hash'),
          bytes: bytes.length,
          data: bytes,
        });
      }
      return send(200, { result: 'success' });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/upload\/session\/([^/]+)\/finish$/);
    if (match && request.method === 'POST') {
      const session = state.sessions.find((item) => item.token === match[2]);
      session.finished = true;
      const content = Buffer.concat(
        [...(session?.chunks ?? [])]
          .sort((a, b) => a.number - b.number)
          .map((chunk) => chunk.data),
      );
      const file = {
        id: state.nextId++,
        name: session?.file_name ?? 'file',
        size: session?.total_size ?? 0,
        parentId: session?.directory_id ?? null,
        type: 'file',
        content,
      };
      state.files.set(file.id, file);
      return send(200, { data: file });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/files\/(\d+)$/);
    if (match && request.method === 'GET') {
      const file = state.files.get(Number(match[2]));
      return file
        ? send(200, { data: file })
        : send(404, { result: 'error', error: { description: 'File not found' } });
    }

    match = path.match(/^\/2\/drive\/(\d+)\/files\/(\d+)\/download$/);
    if (match && request.method === 'GET') {
      state.downloadAttempts += 1;
      if (state.failNextDownloads > 0) {
        state.failNextDownloads -= 1;
        request.socket.destroy();
        return;
      }
      const fileId = Number(match[2]);
      const file = state.files.get(fileId);
      if (!file) {
        return send(404, { result: 'error', error: { description: 'File not found' } });
      }
      const body = file.content ?? Buffer.alloc(file.size ?? 0);
      const range = request.headers.range ?? null;
      state.downloads.push({ fileId, range });
      let start = 0;
      let end = Math.max(0, body.length - 1);
      let status = 200;
      const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(String(range ?? '').trim());
      if (rangeMatch && (rangeMatch[1] !== '' || rangeMatch[2] !== '')) {
        if (rangeMatch[1] === '') {
          start = Math.max(0, body.length - Number(rangeMatch[2]));
        } else {
          start = Number(rangeMatch[1]);
          if (rangeMatch[2] !== '') end = Math.min(Number(rangeMatch[2]), body.length - 1);
        }
        if (start > end || start >= body.length) {
          response.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
          response.end();
          return;
        }
        status = 206;
      }
      const headers = {
        'Content-Type': file.mime ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      response.writeHead(status, headers);
      response.end(body.subarray(start, end + 1));
      return;
    }

    match = path.match(/^\/2\/drive\/(\d+)\/files\/(\d+)\/thumbnail$/);
    if (match && request.method === 'GET') {
      const fileId = Number(match[2]);
      const width = Number(url.searchParams.get('width') ?? 0);
      state.thumbnails.push({ fileId, width });
      if (!state.files.has(fileId)) {
        return send(404, { result: 'error', error: { description: 'File not found' } });
      }
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      response.end(JPEG_1X1);
      return;
    }

    match = path.match(/^\/2\/drive\/(\d+)\/files\/(\d+)$/);
    if (match && request.method === 'DELETE') {
      const fileId = Number(match[2]);
      const file = state.files.get(fileId);
      if (!file) {
        return send(404, { result: 'error', error: { description: 'File not found' } });
      }
      state.files.delete(fileId);
      state.deleted.push(fileId);
      return send(200, { data: { id: fileId, result: 'success' } });
    }

    return send(404, { result: 'error', error: { description: `no route ${request.method} ${path}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previousBase = config.kdriveApiBase;
  const previousInterval = config.kdriveMinIntervalMs;
  config.kdriveApiBase = base;
  config.kdriveMinIntervalMs = 0;

  return {
    state,
    base,
    close: async () => {
      config.kdriveApiBase = previousBase;
      config.kdriveMinIntervalMs = previousInterval;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
