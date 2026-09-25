import { query } from '../db.js';
import { config } from '../config.js';
import {
  MEDIA_BASE_FIELDS,
  MEDIA_JOIN,
  MEDIA_ORDER,
  serializeMediaRow,
} from '../lib/media-row.js';
import {
  buildAlbumWhere,
  rulesAreEmpty,
  validateAlbumRules,
} from '../services/album-rules.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length === 0 || name.length > 120) return null;
  return name;
}

function normalizeMediaIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > config.maxBatchSize) return null;
  const ids = value.filter(isUuid);
  if (ids.length !== value.length) return null;
  return ids;
}

async function ownedAlbum(userId, albumId) {
  const { rows } = await query('SELECT * FROM albums WHERE id = $1 AND owner_id = $2', [
    albumId,
    userId,
  ]);
  return rows[0] ?? null;
}

/// WHERE + params selecting the media of an album (manual membership or smart
/// rules), always scoped to the owner.
function albumMediaScope(album, userId) {
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions = [];
  if (album.kind === 'smart') {
    conditions.push(...buildAlbumWhere(album.rules, push));
  } else {
    conditions.push(
      `m.id IN (SELECT media_id FROM album_items WHERE album_id = ${push(album.id)})`,
    );
  }
  conditions.push(`s.owner_id = ${push(userId)}`);
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

async function mediaCount(album, userId) {
  const { where, params } = albumMediaScope(album, userId);
  const { rows } = await query(
    `SELECT count(*)::int AS total ${MEDIA_JOIN} ${where}`,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

async function albumCover(album, userId, request) {
  if (album.cover_media_id != null) {
    const { rows } = await query(
      `SELECT ${MEDIA_BASE_FIELDS} ${MEDIA_JOIN}
       WHERE m.id = $1 AND s.owner_id = $2`,
      [album.cover_media_id, userId],
    );
    if (rows.length > 0) return serializeMediaRow(rows[0], request);
  }
  const { where, params } = albumMediaScope(album, userId);
  const { rows } = await query(
    `SELECT ${MEDIA_BASE_FIELDS} ${MEDIA_JOIN} ${where}
     ORDER BY ${MEDIA_ORDER} LIMIT 1`,
    params,
  );
  return rows.length > 0 ? serializeMediaRow(rows[0], request) : null;
}

async function decorate(album, userId, request) {
  const [itemCount, cover] = await Promise.all([
    mediaCount(album, userId),
    albumCover(album, userId, request),
  ]);
  return { ...album, item_count: itemCount, cover };
}

async function ownedMediaIds(userId, ids) {
  if (ids.length === 0) return [];
  const { rows } = await query(
    `SELECT m.id FROM media_items m
     JOIN sources s ON s.id = m.source_id
     WHERE m.id = ANY($1::uuid[]) AND s.owner_id = $2`,
    [ids, userId],
  );
  return rows.map((row) => row.id);
}

export default async function albumRoutes(app) {
  app.get('/api/albums', async (request) => {
    const { rows } = await query(
      'SELECT * FROM albums WHERE owner_id = $1 ORDER BY created_at DESC, id DESC',
      [request.user.id],
    );
    const albums = await Promise.all(
      rows.map((album) => decorate(album, request.user.id, request)),
    );
    return { albums };
  });

  app.post('/api/albums/preview', async (request, reply) => {
    const parsed = validateAlbumRules(request.body?.rules);
    if (parsed.error || rulesAreEmpty(parsed.rules)) {
      return reply.code(400).send({ error: parsed.error ?? 'rules_required' });
    }
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions = [
      ...buildAlbumWhere(parsed.rules, push),
      `s.owner_id = ${push(request.user.id)}`,
    ];
    const { rows } = await query(
      `SELECT count(*)::int AS total ${MEDIA_JOIN} WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return { total: Number(rows[0]?.total ?? 0) };
  });

  app.post('/api/albums', async (request, reply) => {
    const body = request.body ?? {};
    const name = normalizeName(body.name);
    if (name == null) return reply.code(400).send({ error: 'name is required' });
    const kind = body.kind ?? 'manual';
    if (!['manual', 'smart'].includes(kind)) {
      return reply.code(400).send({ error: 'kind must be manual or smart' });
    }
    const mediaIds = normalizeMediaIds(body.media_ids);
    if (mediaIds == null) return reply.code(400).send({ error: 'invalid media_ids' });
    if (kind === 'manual' && mediaIds.length > 0 && body.rules != null && !rulesAreEmpty(body.rules)) {
      return reply.code(400).send({ error: 'manual albums do not accept rules' });
    }

    let rules = {};
    if (kind === 'smart') {
      const parsed = validateAlbumRules(body.rules);
      if (parsed.error) return reply.code(400).send({ error: parsed.error });
      if (rulesAreEmpty(parsed.rules)) {
        return reply.code(400).send({ error: 'rules_required' });
      }
      rules = parsed.rules;
    }

    const { rows } = await query(
      `INSERT INTO albums (owner_id, name, kind, rules)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [request.user.id, name, kind, JSON.stringify(rules)],
    );
    const album = rows[0];
    if (mediaIds.length > 0) {
      const owned = await ownedMediaIds(request.user.id, mediaIds);
      if (owned.length > 0) {
        await query(
          `INSERT INTO album_items (album_id, media_id)
           SELECT $1, unnest($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [album.id, owned],
        );
      }
    }
    return reply.code(201).send({ album: await decorate(album, request.user.id, request) });
  });

  app.patch('/api/albums/:id', async (request, reply) => {
    const albumId = request.params.id;
    if (!isUuid(albumId)) return reply.code(400).send({ error: 'invalid id' });
    const album = await ownedAlbum(request.user.id, albumId);
    if (album == null) return reply.code(404).send({ error: 'not_found' });

    const body = request.body ?? {};
    if (body.kind != null && body.kind !== album.kind) {
      return reply.code(400).send({ error: 'kind cannot change' });
    }

    let name = album.name;
    if (body.name != null) {
      const parsed = normalizeName(body.name);
      if (parsed == null) return reply.code(400).send({ error: 'invalid name' });
      name = parsed;
    }

    let rules = album.rules;
    if (body.rules != null) {
      if (album.kind !== 'smart') {
        return reply.code(400).send({ error: 'manual albums do not accept rules' });
      }
      const parsed = validateAlbumRules(body.rules);
      if (parsed.error) return reply.code(400).send({ error: parsed.error });
      if (rulesAreEmpty(parsed.rules)) {
        return reply.code(400).send({ error: 'rules_required' });
      }
      rules = parsed.rules;
    }

    let coverId = album.cover_media_id;
    let clearCover = false;
    if (body.clear_cover === true) {
      coverId = null;
      clearCover = true;
    } else if (body.cover_media_id != null) {
      if (!isUuid(body.cover_media_id)) {
        return reply.code(400).send({ error: 'invalid cover_media_id' });
      }
      const owned = await ownedMediaIds(request.user.id, [body.cover_media_id]);
      if (owned.length === 0) {
        return reply.code(400).send({ error: 'cover_media_id not found' });
      }
      coverId = owned[0];
    }

    const { rows } = await query(
      `UPDATE albums SET
         name = $2,
         rules = $3::jsonb,
         cover_media_id = CASE WHEN $4::boolean THEN NULL::uuid ELSE $5::uuid END,
         updated_at = now()
       WHERE id = $1 AND owner_id = $6
       RETURNING *`,
      [albumId, name, JSON.stringify(rules), clearCover, coverId, request.user.id],
    );
    return { album: await decorate(rows[0], request.user.id, request) };
  });

  app.delete('/api/albums/:id', async (request, reply) => {
    const albumId = request.params.id;
    if (!isUuid(albumId)) return reply.code(400).send({ error: 'invalid id' });
    const { rowCount } = await query('DELETE FROM albums WHERE id = $1 AND owner_id = $2', [
      albumId,
      request.user.id,
    ]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.get('/api/albums/:id/media', async (request, reply) => {
    const albumId = request.params.id;
    if (!isUuid(albumId)) return reply.code(400).send({ error: 'invalid id' });
    const album = await ownedAlbum(request.user.id, albumId);
    if (album == null) return reply.code(404).send({ error: 'not_found' });

    const limit = clamp(Number(request.query?.limit ?? 100), 1, config.maxBatchSize);
    const offset = Math.max(Number(request.query?.offset ?? 0), 0);
    const { where, params } = albumMediaScope(album, request.user.id);
    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const { rows } = await query(
      `SELECT ${MEDIA_BASE_FIELDS} ${MEDIA_JOIN} ${where}
       ORDER BY ${MEDIA_ORDER}
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...params, limit, offset],
    );
    const { rows: countRows } = await query(
      `SELECT count(*)::int AS total ${MEDIA_JOIN} ${where}`,
      params,
    );
    return {
      items: rows.map((row) => serializeMediaRow(row, request)),
      total: Number(countRows[0]?.total ?? 0),
      limit,
      offset,
    };
  });

  app.post('/api/albums/:id/items', async (request, reply) => {
    const albumId = request.params.id;
    if (!isUuid(albumId)) return reply.code(400).send({ error: 'invalid id' });
    const album = await ownedAlbum(request.user.id, albumId);
    if (album == null) return reply.code(404).send({ error: 'not_found' });
    if (album.kind !== 'manual') return reply.code(400).send({ error: 'album_is_smart' });

    const mediaIds = normalizeMediaIds(request.body?.media_ids);
    if (mediaIds == null || mediaIds.length === 0) {
      return reply.code(400).send({ error: 'media_ids must be a non-empty array' });
    }
    const owned = await ownedMediaIds(request.user.id, mediaIds);
    if (owned.length > 0) {
      await query(
        `INSERT INTO album_items (album_id, media_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [albumId, owned],
      );
    }
    return { added: owned.length, skipped: mediaIds.length - owned.length };
  });

  app.delete('/api/albums/:id/items', async (request, reply) => {
    const albumId = request.params.id;
    if (!isUuid(albumId)) return reply.code(400).send({ error: 'invalid id' });
    const album = await ownedAlbum(request.user.id, albumId);
    if (album == null) return reply.code(404).send({ error: 'not_found' });
    if (album.kind !== 'manual') return reply.code(400).send({ error: 'album_is_smart' });

    const mediaIds = normalizeMediaIds(request.body?.media_ids);
    if (mediaIds == null || mediaIds.length === 0) {
      return reply.code(400).send({ error: 'media_ids must be a non-empty array' });
    }
    const { rowCount } = await query(
      'DELETE FROM album_items WHERE album_id = $1 AND media_id = ANY($2::uuid[])',
      [albumId, mediaIds],
    );
    await query(
      'UPDATE albums SET cover_media_id = NULL WHERE id = $1 AND cover_media_id = ANY($2::uuid[])',
      [albumId, mediaIds],
    );
    return { removed: rowCount };
  });
}
