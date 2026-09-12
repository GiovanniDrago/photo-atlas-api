import { pool } from '../db.js';

export default async function healthRoutes(app) {
  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'up', time: new Date().toISOString() };
    } catch (error) {
      return reply.code(503).send({ status: 'degraded', database: 'down', error: String(error.message) });
    }
  });
}
