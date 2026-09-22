import http from 'node:http';
import { config } from '../../src/config.js';

export async function startFakeKDrive() {
  const state = {
    folders: new Map(),
    files: new Map(),
    uploads: [],
    sessions: [],
    deleted: [],
    nextId: 1000,
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
      };
      state.files.set(file.id, file);
      return send(200, { data: file });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/upload\/session\/start$/);
    if (match && request.method === 'POST') {
      const body = JSON.parse((await readBody()).toString() || '{}');
      const session = { token: `session-${state.nextId++}`, chunks: [] };
      state.sessions.push({ ...body, token: session.token });
      return send(200, {
        data: {
          upload_url: `http://127.0.0.1:${server.address().port}/chunk/${session.token}`,
          session_token: session.token,
        },
      });
    }

    match = path.match(/^\/chunk\/(.+)$/);
    if (match && request.method === 'POST') {
      const bytes = await readBody();
      const session = state.sessions.find((item) => item.token === match[1]);
      if (session) session.chunks.push(bytes.length);
      return send(200, { result: 'success' });
    }

    match = path.match(/^\/3\/drive\/(\d+)\/upload\/session\/finish$/);
    if (match && request.method === 'POST') {
      const body = JSON.parse((await readBody()).toString() || '{}');
      const session = state.sessions.find((item) => item.token === body.session_token);
      const file = {
        id: state.nextId++,
        name: session?.file_name ?? 'file',
        size: session?.total_size ?? 0,
        parentId: session?.directory_id ?? null,
        type: 'file',
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
