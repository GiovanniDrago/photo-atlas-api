import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { pool } from './db.js';
import healthRoutes from './routes/health.js';
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

await app.register(cors, {
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((entry) => entry.trim()),
});

await app.register(healthRoutes);
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
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });

if (config.localMediaRoots.length === 0) {
  app.log.warn('LOCAL_MEDIA_ROOTS is empty: the thumbnail endpoint will serve any readable path. Set it before exposing the API.');
}
app.log.info(`Photo Atlas API ready on http://${config.host}:${config.port}`);
