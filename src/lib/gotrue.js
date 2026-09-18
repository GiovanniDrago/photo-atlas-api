import { config } from '../config.js';

let overrides = null;

export function setGoTrueOverrides(next) {
  overrides = next;
}

function settings() {
  return (
    overrides ?? {
      url: config.supabaseUrl ? `${config.supabaseUrl}/auth/v1` : '',
      secretKey: config.supabaseSecretKey,
    }
  );
}

async function request(method, path, { body, searchParams } = {}) {
  const { url, secretKey } = settings();
  if (!url || !secretKey) {
    const error = new Error('Supabase Auth is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)');
    error.statusCode = 500;
    throw error;
  }
  const target = new URL(`${url}${path}`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  const response = await fetch(target, {
    method,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const message =
      parsed?.msg ??
      parsed?.message ??
      parsed?.error_description ??
      `Supabase Auth request failed (${response.status})`;
    const error = new Error(message);
    error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    error.upstreamStatus = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

export function adminGetUser(userId) {
  return request('GET', `/admin/users/${userId}`);
}

export function adminUpdateUser(userId, patch) {
  return request('PUT', `/admin/users/${userId}`, { body: patch });
}

export function adminDeleteFactor(userId, factorId) {
  return request('DELETE', `/admin/users/${userId}/factors/${factorId}`);
}

export async function adminFindUserByEmail(email) {
  const wanted = String(email ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const body = await request('GET', '/admin/users', {
    searchParams: { page: 1, per_page: 50, filter: wanted },
  });
  const users = Array.isArray(body?.users) ? body.users : [];
  return users.find((user) => String(user.email ?? '').toLowerCase() === wanted) ?? null;
}

export async function adminSignOutUser(userId) {
  return request('POST', `/admin/users/${userId}/logout`);
}

export function verifiedFactors(user) {
  return (user?.factors ?? []).filter((factor) => factor.status === 'verified');
}
