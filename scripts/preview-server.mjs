/**
 * Minimal static file server for previewing this site locally.
 *
 * The site is plain HTML/CSS/JS with no build step, so previewing it is just
 * serving the repository root over HTTP. `file://` will not work, because the
 * pages fetch the Worker and read the JSON in schedule/, which the browser
 * blocks for local files.
 *
 * Binds 0.0.0.0 so the preview is reachable from outside the sandbox, and
 * takes the port from PORT when the host injects one.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  // normalize() collapses "..", and the prefix check refuses anything that
  // still points outside the served directory.
  const requested = decodeURIComponent(url.pathname);
  let filePath = join(ROOT, normalize(requested));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT} on http://${HOST}:${PORT}`);
});