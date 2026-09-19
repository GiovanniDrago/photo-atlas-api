import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pagePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'netlify',
  'email-confirm',
  'index.html',
);

export default async function confirmPageRoutes(app) {
  app.get('/confirm-email', async (_request, reply) => {
    try {
      const html = await fs.readFile(pagePath, 'utf8');
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-cache');
      return reply.send(html);
    } catch {
      return reply.code(404).send({ error: 'confirm_page_missing' });
    }
  });
}
