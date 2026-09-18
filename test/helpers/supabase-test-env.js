import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { setAuthOverrides } from '../../src/lib/supabase-auth.js';
import { setGoTrueOverrides } from '../../src/lib/gotrue.js';

export const ISSUER = 'https://test.supabase.co/auth/v1';

export async function startJwksServer() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const jwksUrl = `http://127.0.0.1:${port}/auth/v1/.well-known/jwks.json`;
  setAuthOverrides({ jwksUrl, issuer: ISSUER });
  return {
    privateKey,
    kid: jwk.kid,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function signToken({
  sub,
  email,
  aal = 'aal1',
  userMetadata = {},
  audience = 'authenticated',
  issuer = ISSUER,
  expiresIn = '1h',
  privateKey,
  kid,
}) {
  return new SignJWT({ email, aal, user_metadata: userMetadata })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

export async function startFakeGoTrue() {
  const state = {
    users: new Map(),
    updates: [],
    deletedFactors: [],
    signOuts: [],
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
      const text = Buffer.concat(chunks).toString();
      return text ? JSON.parse(text) : null;
    };

    if (request.method === 'GET' && url.pathname === '/auth/v1/admin/users') {
      const filter = (url.searchParams.get('filter') ?? '').toLowerCase();
      const users = [...state.users.values()].filter(
        (user) => !filter || String(user.email ?? '').toLowerCase().includes(filter),
      );
      return send(200, { users, aud: 'authenticated' });
    }

    let match = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (match && request.method === 'GET') {
      const user = state.users.get(match[1]);
      return user ? send(200, user) : send(404, { msg: 'User not found' });
    }
    if (match && request.method === 'PUT') {
      const patch = await readBody();
      state.updates.push({ id: match[1], patch });
      const user = state.users.get(match[1]) ?? { id: match[1] };
      state.users.set(match[1], { ...user, ...patch });
      return send(200, state.users.get(match[1]));
    }

    match = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)\/factors\/([^/]+)$/);
    if (match && request.method === 'DELETE') {
      state.deletedFactors.push({ userId: match[1], factorId: match[2] });
      const user = state.users.get(match[1]);
      if (user) {
        user.factors = (user.factors ?? []).filter((factor) => factor.id !== match[2]);
      }
      return send(200, {});
    }

    match = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)\/logout$/);
    if (match && request.method === 'POST') {
      state.signOuts.push(match[1]);
      return send(200, {});
    }

    return send(404, { msg: `no route for ${request.method} ${url.pathname}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  setGoTrueOverrides({
    url: `http://127.0.0.1:${port}/auth/v1`,
    secretKey: 'test-secret-key',
  });
  return {
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
