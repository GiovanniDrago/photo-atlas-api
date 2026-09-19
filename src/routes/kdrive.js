import { query } from '../db.js';
import { config } from '../config.js';
import { encryptSecret } from '../lib/crypto.js';
import { KDriveClient, mediaTypeOf } from '../services/kdrive.js';
import { getKDriveClient } from '../services/kdrive-account.js';
import { ensureThumbnail } from '../services/media-assets.js';
import { extractImageMetadata, computeMetadataStatus } from '../services/enrich.js';
import { upsertMediaItems, updateScanRun, markKdriveBacked } from '../services/media-index.js';

const BATCH_SIZE = 100;

function mapFile(file) {
  const mediaType = mediaTypeOf(file.name ?? '', file.mime_type ?? file.mime ?? null);
  if (!mediaType) return null;
  return {
    external_key: String(file.id),
    path: null,
    name: file.name,
    mime: file.mime_type ?? file.mime ?? null,
    media_type: mediaType,
    size_bytes: file.size ?? null,
    taken_at: null,
    file_created_at: file.created_at ? new Date(file.created_at * 1000).toISOString() : null,
    modified_at: file.last_modified_at ? new Date(file.last_modified_at * 1000).toISOString() : null,
    metadata_status: 'none',
  };
}

async function ensureSource(label, driveId, folderId, ownerId, includeSubfolders) {
  const { rows } = await query(
    `SELECT * FROM sources
     WHERE kind = 'kdrive' AND kdrive_drive_id = $1 AND kdrive_folder_id = $2 AND owner_id = $3
     LIMIT 1`,
    [driveId, folderId, ownerId],
  );
  if (rows.length > 0) {
    const updated = await query(
      `UPDATE sources SET label = $2, include_subfolders = $3 WHERE id = $1 RETURNING *`,
      [rows[0].id, label, includeSubfolders],
    );
    return updated.rows[0];
  }
  const inserted = await query(
    `INSERT INTO sources (kind, label, kdrive_drive_id, kdrive_folder_id, owner_id, include_subfolders)
     VALUES ('kdrive', $1, $2, $3, $4, $5)
     RETURNING *`,
    [label, driveId, folderId, ownerId, includeSubfolders],
  );
  return inserted.rows[0];
}

async function runScan({ scanRunId, sourceId, ownerId, client, folderId, recursive }) {
  let filesSeen = 0;
  let filesIndexed = 0;
  let filesSkipped = 0;
  const errors = [];
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    try {
      const rows = await upsertMediaItems(sourceId, batch);
      filesIndexed += rows.length;
      await markKdriveBacked(sourceId, batch.map((item) => item.external_key));
    } catch (error) {
      errors.push(String(error.message));
    }
    batch = [];
  };

  try {
    const collect = async function* () {
      if (recursive) {
        yield* client.walkFiles(folderId);
        return;
      }
      let cursor;
      do {
        const page = await client.listChildren(folderId, { type: 'file', cursor });
        for (const item of page.items) yield item;
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    };

    for await (const file of collect()) {
      filesSeen += 1;
      const mapped = mapFile(file);
      if (!mapped) {
        filesSkipped += 1;
        continue;
      }
      batch.push(mapped);
      if (batch.length >= BATCH_SIZE) await flush();
      if (filesSeen % 25 === 0) {
        await updateScanRun(scanRunId, {
          files_seen: filesSeen,
          files_indexed: filesIndexed,
          files_skipped: filesSkipped,
        });
      }
    }
    await flush();
    await query('UPDATE sources SET last_scan_at = now() WHERE id = $1', [sourceId]);
    await updateScanRun(scanRunId, {
      status: 'completed',
      files_seen: filesSeen,
      files_indexed: filesIndexed,
      files_skipped: filesSkipped,
      errors,
    });
    setImmediate(() => {
      runPreviews(ownerId, { sourceId }).catch(() => {});
    });
  } catch (error) {
    await updateScanRun(scanRunId, {
      status: 'failed',
      files_seen: filesSeen,
      files_indexed: filesIndexed,
      files_skipped: filesSkipped,
      errors: [...errors, String(error.message)],
    });
  }
}

const enrichStates = new Map();
function enrichStateFor(userId) {
  let state = enrichStates.get(userId);
  if (!state) {
    state = { running: false, processed: 0, updated: 0, errors: [], started_at: null, finished_at: null };
    enrichStates.set(userId, state);
  }
  return state;
}

async function runEnrichment(userId, limit) {
  const state = enrichStateFor(userId);
  state.running = true;
  state.processed = 0;
  state.updated = 0;
  state.errors = [];
  state.started_at = new Date().toISOString();
  state.finished_at = null;
  try {
    const { client } = await getKDriveClient(userId);
    const { rows } = await query(
      `SELECT m.id, m.external_key, m.name
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE s.owner_id = $1 AND s.kind = 'kdrive' AND m.media_type = 'image' AND m.metadata_status <> 'full'
       ORDER BY m.indexed_at ASC
       LIMIT $2`,
      [userId, limit],
    );
    for (const row of rows) {
      try {
        const prefix = await client.readPrefix(row.external_key);
        const metadata = await extractImageMetadata(prefix);
        const status = computeMetadataStatus(metadata);
        await query(
          `UPDATE media_items SET
             taken_at = COALESCE($2, taken_at),
             lat = COALESCE($3, lat),
             lon = COALESCE($4, lon),
             width = COALESCE($5, width),
             height = COALESCE($6, height),
             metadata_status = $7,
             updated_at = now()
           WHERE id = $1`,
          [
            row.id,
            metadata.takenAt ?? null,
            metadata.lat ?? null,
            metadata.lon ?? null,
            metadata.width ?? null,
            metadata.height ?? null,
            status,
          ],
        );
        state.updated += 1;
      } catch (error) {
        state.errors.push(`${row.name}: ${error.message}`);
      }
      state.processed += 1;
    }
  } catch (error) {
    state.errors.push(String(error.message));
  } finally {
    state.running = false;
    state.finished_at = new Date().toISOString();
  }
}

const previewStates = new Map();

function previewStateFor(userId) {
  let state = previewStates.get(userId);
  if (!state) {
    state = {
      running: false,
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      started_at: null,
      finished_at: null,
    };
    previewStates.set(userId, state);
  }
  return state;
}

async function runPreviews(userId, { sourceId } = {}) {
  const state = previewStateFor(userId);
  if (state.running) return;
  state.running = true;
  state.processed = 0;
  state.updated = 0;
  state.skipped = 0;
  state.errors = [];
  state.started_at = new Date().toISOString();
  state.finished_at = null;
  try {
    const params = [userId];
    let sourceFilter = '';
    if (sourceId) {
      params.push(sourceId);
      sourceFilter = `AND m.source_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT m.*, s.kind AS source_kind, s.owner_id
       FROM media_items m
       JOIN sources s ON s.id = m.source_id
       WHERE s.owner_id = $1 AND s.kind = 'kdrive'
         AND (m.thumb_path IS NULL OR m.thumb_path = '')
         ${sourceFilter}
       ORDER BY m.indexed_at ASC
       LIMIT 5000`,
      params,
    );
    for (const row of rows) {
      try {
        const result = await ensureThumbnail(row);
        if (result) {
          state.updated += 1;
        } else {
          state.skipped += 1;
        }
      } catch (error) {
        state.errors.push(`${row.name}: ${error.message}`);
        state.skipped += 1;
      }
      state.processed += 1;
    }
  } catch (error) {
    state.errors.push(String(error.message));
  } finally {
    state.running = false;
    state.finished_at = new Date().toISOString();
  }
}

export default async function kdriveRoutes(app) {
  app.post('/api/kdrive/connect', async (request, reply) => {
    const { token, drive_id: driveId, label } = request.body ?? {};
    if (!token || !driveId) {
      return reply.code(400).send({ error: 'token and drive_id are required' });
    }
    if (!config.kdriveEncKey) {
      return reply.code(500).send({ error: 'KDRIVE_ENC_KEY is not configured on the server' });
    }
    const client = new KDriveClient({ token, driveId: Number(driveId), baseUrl: config.kdriveApiBase });
    try {
      await client.getDrive();
    } catch (error) {
      return reply.code(401).send({ error: `kDrive authentication failed: ${error.message}` });
    }
    const encrypted = encryptSecret(token, config.kdriveEncKey);
    await query('DELETE FROM kdrive_accounts WHERE owner_id = $1', [request.user.id]);
    const { rows } = await query(
      `INSERT INTO kdrive_accounts (label, drive_id, token_cipher, token_iv, token_tag, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, label, drive_id, created_at`,
      [label ?? 'kDrive', Number(driveId), encrypted.cipher, encrypted.iv, encrypted.tag, request.user.id],
    );
    return reply.code(201).send({ account: rows[0] });
  });

  app.get('/api/kdrive/status', async (request) => {
    const { rows } = await query(
      'SELECT id, label, drive_id, created_at, updated_at FROM kdrive_accounts WHERE owner_id = $1 LIMIT 1',
      [request.user.id],
    );
    return { connected: rows.length > 0, account: rows[0] ?? null };
  });

  app.delete('/api/kdrive', async (request) => {
    await query('DELETE FROM kdrive_accounts WHERE owner_id = $1', [request.user.id]);
    return { connected: false };
  });

  app.get('/api/kdrive/folders', async (request) => {
    const { client } = await getKDriveClient(request.user.id);
    const parentId = request.query?.parent_id ?? 1;
    const page = await client.listChildren(parentId, { type: 'dir', cursor: request.query?.cursor });
    return {
      parent_id: Number(parentId),
      folders: page.items.map((item) => ({ id: item.id, name: item.name })),
      cursor: page.cursor,
      has_more: page.hasMore,
    };
  });

  app.get('/api/kdrive/files', async (request) => {
    const { client } = await getKDriveClient(request.user.id);
    const parentId = request.query?.parent_id ?? 1;
    const page = await client.listChildren(parentId, {
      type: 'file',
      cursor: request.query?.cursor,
      limit: 200,
    });
    return {
      parent_id: Number(parentId),
      files: page.items
        .map(mapFile)
        .filter(Boolean)
        .map((item) => ({ ...item, id: item.external_key })),
      cursor: page.cursor,
      has_more: page.hasMore,
    };
  });

  app.post('/api/kdrive/scan', async (request, reply) => {
    const {
      folder_id: folderId,
      recursive,
      include_subfolders: includeSubfolders,
      label,
    } = request.body ?? {};
    if (!folderId) return reply.code(400).send({ error: 'folder_id is required' });
    const { account, client } = await getKDriveClient(request.user.id);
    const folder = await client.getFile(folderId);
    const includeValue = includeSubfolders ?? recursive ?? true;
    const folderName = Number(folderId) === 1 || !folder?.name ? 'Root' : folder.name;
    const source = await ensureSource(
      label ?? `${account.label}: ${folderName}`,
      account.drive_id,
      folderId,
      request.user.id,
      Boolean(includeValue),
    );
    const run = await query('INSERT INTO scan_runs (source_id) VALUES ($1) RETURNING *', [source.id]);
    setImmediate(() => {
      runScan({
        scanRunId: run.rows[0].id,
        sourceId: source.id,
        ownerId: request.user.id,
        client,
        folderId,
        recursive: Boolean(includeValue),
      }).catch(() => {});
    });
    return reply.code(202).send({
      scan_run_id: run.rows[0].id,
      source_id: source.id,
      include_subfolders: Boolean(includeValue),
    });
  });

  app.post('/api/kdrive/enrich', async (request, reply) => {
    const state = enrichStateFor(request.user.id);
    if (state.running) {
      return reply.code(409).send({ error: 'enrichment_already_running', state });
    }
    const limit = Math.min(Math.max(Number(request.body?.limit ?? 20), 1), 200);
    setImmediate(() => {
      runEnrichment(request.user.id, limit).catch(() => {});
    });
    return reply.code(202).send({ queued: limit });
  });

  app.get('/api/kdrive/enrich', async (request) => enrichStateFor(request.user.id));

  app.post('/api/kdrive/previews', async (request, reply) => {
    const state = previewStateFor(request.user.id);
    if (state.running) {
      return reply.code(409).send({ error: 'previews_already_running', state });
    }
    setImmediate(() => {
      runPreviews(request.user.id).catch(() => {});
    });
    return reply.code(202).send({ queued: true });
  });

  app.get('/api/kdrive/previews', async (request) => previewStateFor(request.user.id));
}
