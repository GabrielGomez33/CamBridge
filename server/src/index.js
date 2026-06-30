import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { SessionStore } from './sessions.js';
import { attachSignaling } from './signaling.js';
import { json, baseUrlFrom, makeStaticHandler } from './http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '../../client');

validateConfig(logger);

const store = new SessionStore();
const serveStatic = makeStaticHandler(CLIENT_DIR);

// ── HTTP routes ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const route = url.pathname;

  // Liveness/readiness probe for nginx, uptime checks, orchestrators.
  if (route === '/healthz') {
    return json(res, 200, { ok: true, sessions: store.size, turn: config.turn.enabled });
  }

  // Create a new dynamic link (a session). Returns the broadcaster URL (for the
  // phone) and the OBS viewer URL (passcode embedded, for the Browser Source).
  if (route === '/api/sessions' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      const session = store.create({ title: body?.title });
      const base = baseUrlFrom(req);
      const q = `s=${encodeURIComponent(session.id)}&p=${encodeURIComponent(session.passcode)}`;
      logger.info({ sessionId: session.id }, 'session created');
      json(res, 201, {
        sessionId: session.id,
        passcode: session.passcode,
        title: session.title,
        broadcastUrl: `${base}/broadcaster.html?${q}`,
        viewerUrl: `${base}/viewer.html?${q}`,
      });
    });
  }

  // Lightweight existence/status check used by the viewer page before it joins.
  if (route === '/api/sessions/status' && req.method === 'GET') {
    const id = url.searchParams.get('s');
    const session = id && store.get(id);
    if (!session) return json(res, 404, { exists: false });
    return json(res, 200, {
      exists: true,
      status: session.status,
      hasBroadcaster: Boolean(session.broadcaster),
      title: session.title,
    });
  }

  if (route.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  // Everything else: static client assets (dev convenience).
  return serveStatic(req, res);
});

// ── WebSocket signaling on /ws ────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
attachSignaling(wss, store, logger);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://internal');
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (!originAllowed(req.headers.origin)) {
    logger.warn({ origin: req.headers.origin }, 'ws upgrade rejected: origin not allowed');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function originAllowed(origin) {
  // OBS's embedded browser frequently sends Origin "null" or none.
  if (!origin || origin === 'null') return config.allowNullOrigin;
  if (config.allowedOrigins.length === 0) return true; // dev: allow any
  return config.allowedOrigins.includes(origin);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function readJsonBody(req, res, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > 16 * 1024) {
      json(res, 413, { error: 'body too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return cb({});
    try {
      cb(JSON.parse(raw));
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
    }
  });
  req.on('error', () => json(res, 400, { error: 'request error' }));
}

// ── periodic session sweep ────────────────────────────────────────────────────
const sweepTimer = setInterval(() => {
  const removed = store.sweep();
  if (removed) logger.info({ removed, remaining: store.size }, 'swept idle sessions');
}, 60_000);
sweepTimer.unref?.();

// ── lifecycle ─────────────────────────────────────────────────────────────────
server.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, env: config.env, clientDir: CLIENT_DIR },
    'CamBridge signaling server listening'
  );
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  clearInterval(sweepTimer);
  wss.clients.forEach((ws) => ws.close(1001, 'server shutting down'));
  server.close(() => process.exit(0));
  // Hard exit if connections refuse to drain.
  setTimeout(() => process.exit(0), 5000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
