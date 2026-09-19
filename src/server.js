import os from 'node:os';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { closePool } from './db.js';
import { corsOptions } from './lib/cors.js';
import { registerJsonBodyParser } from './lib/json-body-parser.js';
import { registerAuthHook } from './lib/supabase-auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import confirmPageRoutes from './routes/confirm-page.js';
import sourceRoutes from './routes/sources.js';
import mediaRoutes from './routes/media.js';
import clusterRoutes from './routes/clusters.js';
import timelineRoutes from './routes/timeline.js';
import scanRunRoutes from './routes/scan-runs.js';
import kdriveRoutes from './routes/kdrive.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 32 * 1024 * 1024,
});

registerJsonBodyParser(app);

await app.register(cors, corsOptions);

await app.register(rateLimit, {
  global: false,
  keyGenerator: (request) => request.ip,
});

registerAuthHook(app);

await app.register(healthRoutes);
await app.register(confirmPageRoutes);
await app.register(authRoutes);
await app.register(sourceRoutes);
await app.register(mediaRoutes);
await app.register(clusterRoutes);
await app.register(timelineRoutes);
await app.register(scanRunRoutes);
await app.register(kdriveRoutes);

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  reply.code(status).send({ error: status >= 500 ? 'internal_error' : error.message });
});

const shutdown = async () => {
  await app.close();
  await closePool();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function reachableUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }
  return urls;
}

await app.listen({ port: config.port, host: config.host });

if (config.localMediaRoots.length === 0) {
  app.log.warn('LOCAL_MEDIA_ROOTS is empty: the thumbnail endpoint will serve any readable path. Set it before exposing the API.');
}
app.log.info(`Photo Atlas API ready: ${reachableUrls(config.port).join('  |  ')}`);
