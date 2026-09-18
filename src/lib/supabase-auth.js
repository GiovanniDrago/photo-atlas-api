import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from '../db.js';
import { config } from '../config.js';

let overrides = null;

export function setAuthOverrides(next) {
  overrides = next;
}

function authSettings() {
  return (
    overrides ?? {
      jwksUrl: config.supabaseJwksUrl,
      issuer: config.supabaseUrl ? `${config.supabaseUrl}/auth/v1` : '',
    }
  );
}

let jwks = null;
let jwksUrl = null;

function jwkSet(url) {
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrl = url;
  }
  return jwks;
}

export async function verifyAccessToken(token) {
  const settings = authSettings();
  if (!settings.jwksUrl) {
    const error = new Error('SUPABASE_JWKS_URL is not configured');
    error.statusCode = 500;
    throw error;
  }
  const { payload } = await jwtVerify(token, jwkSet(settings.jwksUrl), {
    issuer: settings.issuer || undefined,
    audience: 'authenticated',
    clockTolerance: 5,
  });
  return payload;
}

async function upsertProfile(payload) {
  const meta = payload.user_metadata ?? {};
  const displayName = typeof meta.display_name === 'string' ? meta.display_name : null;
  const { rows } = await query(
    `INSERT INTO profiles (id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, profiles.email),
       display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
       updated_at = now()
     RETURNING mfa_enabled`,
    [payload.sub, typeof payload.email === 'string' ? payload.email : null, displayName],
  );
  return rows[0] ?? null;
}

export async function recordAuthEvent(userId, kind, request) {
  try {
    await query('INSERT INTO auth_events (user_id, kind, ip, user_agent) VALUES ($1, $2, $3, $4)', [
      userId ?? null,
      kind,
      request?.ip ?? null,
      request?.headers?.['user-agent'] ?? null,
    ]);
  } catch {
    // Audit logging must never break the request.
  }
}

export async function requireAuth(request, reply) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  let payload;
  try {
    payload = await verifyAccessToken(match[1]);
  } catch (error) {
    request.log?.debug?.({ err: error.message }, 'jwt verification failed');
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!payload.sub) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  let profile;
  try {
    profile = await upsertProfile(payload);
  } catch (error) {
    request.log?.error?.(error);
    return reply.code(500).send({ error: 'internal_error' });
  }
  const mfaEnabled = Boolean(profile?.mfa_enabled);
  if (mfaEnabled && payload.aal !== 'aal2') {
    return reply.code(403).send({ error: 'mfa_required' });
  }
  request.user = {
    id: payload.sub,
    email: payload.email ?? null,
    aal: payload.aal ?? 'aal1',
    displayName: payload.user_metadata?.display_name ?? null,
    mfaEnabled,
  };
  return undefined;
}

const PUBLIC_PATHS = new Set([
  '/api/config',
  '/api/auth/password/reset-with-code',
  '/api/auth/mfa/recovery',
]);

export function registerAuthHook(app) {
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (PUBLIC_PATHS.has(url)) return;
    if (/^\/api\/media\/[0-9a-f-]{36}\/(thumbnail|download)$/i.test(url)) return;
    return requireAuth(request, reply);
  });
}
