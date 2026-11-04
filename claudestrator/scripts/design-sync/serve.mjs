// Serves out/*.json and builder.js to Penpot's plugin, on 127.0.0.1:4799 only, with CORS open (the plugin runs in the
// Penpot tab's origin).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DESIGN_SYNC_PORT || 4799);

http
  .createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.writeHead(204, { 'Access-Control-Allow-Headers': '*' }).end();
    const name = path.basename(decodeURIComponent((req.url || '/').split('?')[0]));
    const file = name === 'builder.js' ? path.join(here, name) : path.join(here, 'out', name);
    try {
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'application/json' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`design-sync: http://127.0.0.1:${PORT}/ (out/ and builder.js)`));
