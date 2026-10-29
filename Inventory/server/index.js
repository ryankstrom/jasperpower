import express from 'express';
import { createServer as createHttps } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.js';
import { createApi } from './api.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = Number(process.env.PORT) || 8790;

const db = openDb();
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

app.use('/api', createApi(db));

// QR labels encode /u/<uid> so a phone's own camera app can open the device page directly.
app.get('/u/:uid', (req, res) => res.redirect(`/#/scan/${encodeURIComponent(req.params.uid)}`));

app.use('/vendor/jsqr', express.static(resolve(root, 'node_modules/jsqr/dist')));
app.use(express.static(resolve(root, 'public'), { extensions: ['html'] }));

// Phones only allow camera access on https (or localhost). If certs/key.pem + certs/cert.pem
// exist, also serve https on HTTPS_PORT so the scanner works from a phone on the LAN.
const certDir = resolve(root, 'certs');
app.listen(PORT, () => {
  console.log(`JasperInventory on http://localhost:${PORT}  (db: ${DB_PATH})`);
});
if (existsSync(resolve(certDir, 'key.pem')) && existsSync(resolve(certDir, 'cert.pem'))) {
  const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8791;
  createHttps({ key: readFileSync(resolve(certDir, 'key.pem')), cert: readFileSync(resolve(certDir, 'cert.pem')) }, app)
    .listen(HTTPS_PORT, () => console.log(`JasperInventory on https://<this-machine>:${HTTPS_PORT}`));
}
