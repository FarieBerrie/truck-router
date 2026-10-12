import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createOsrmClient } from './osrm.js';

const here = dirname(fileURLToPath(import.meta.url));

const dbFile = resolve(process.env.DATABASE_FILE || join(here, '../data/truck-router.db'));
mkdirSync(dirname(dbFile), { recursive: true });

const osrmUrl = process.env.OSRM_URL || 'https://router.project-osrm.org';
const app = createApp({
  db: openDb(dbFile),
  routing: createOsrmClient(osrmUrl),
  clientDist: join(here, '../../client/dist'),
});

const port = Number(process.env.PORT) || 3010;
app.listen(port, () => console.log(`Truck Router API on http://localhost:${port} (routing via ${osrmUrl})`));
