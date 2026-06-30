import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Resolve the public base URL for building links. Prefer the configured
 * PUBLIC_BASE_URL; otherwise derive from the request (honouring a reverse
 * proxy's X-Forwarded-* headers).
 */
export function baseUrlFrom(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`)
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

/**
 * Minimal, traversal-safe static file server rooted at `root`. Exists so the
 * whole app runs from `npm start` in dev; in production nginx serves the client
 * and proxies /ws + /api here.
 */
export function makeStaticHandler(root) {
  const rootResolved = path.resolve(root);

  return async function serveStatic(req, res) {
    try {
      const urlPath = decodeURIComponent((req.url.split('?')[0] || '/'));
      let rel = urlPath === '/' ? '/index.html' : urlPath;
      // Resolve and confirm the result stays inside root (no ../ escapes).
      const filePath = path.join(rootResolved, rel);
      if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
        return json(res, 403, { error: 'forbidden' });
      }

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      if (stat.isDirectory()) return json(res, 404, { error: 'not found' });

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-cache',
      });
      createReadStream(filePath).pipe(res);
    } catch {
      json(res, 500, { error: 'static error' });
    }
  };
}
