import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { apiRouter } from './api.js';

// Map tiles are loaded straight from these hosts by the browser.
const TILE_HOSTS = ['https://server.arcgisonline.com', 'https://*.tile.openstreetmap.org'];

export function createApp({ db, routing, clientDist }) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:', 'blob:', ...TILE_HOSTS],
          // HTTPS is the host's job; upgrading here breaks plain-HTTP local runs.
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRouter({ db, routing }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  if (clientDist && existsSync(join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist));
    app.get('/{*splat}', (req, res) => res.sendFile(join(clientDist, 'index.html')));
  }

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}
