import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';

import { config, validateConfig } from './config';
import { logger } from './logger';
import { SessionStore } from './webrtc/sessions';
import { attachSignaling } from './webrtc/signaling';
import { sessionRoutes } from './routes/sessions';

validateConfig(logger);

const store = new SessionStore();
const app = express();
const api = `${config.basePath}/api`;
const wsPath = `${config.basePath}/ws`;

app.set('trust proxy', config.trustProxyHops);
app.use(helmet({ contentSecurityPolicy: false })); // CSP tuned per-page in Phase 2
app.use(express.json({ limit: '64kb' }));

// Health probe (matches mirror/admin convention for the CI/CD health check).
app.get(`${api}/health`, (_req, res) => {
  res.json({ ok: true, sessions: store.size, turn: config.turn.enabled });
});

app.use(api, sessionRoutes(store, logger));

// Static client assets (dev convenience; nginx serves these in production).
const CLIENT_DIR = path.resolve(__dirname, '../../client');
app.use(express.static(CLIENT_DIR, { extensions: ['html'] }));

// ── HTTP + WebSocket ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
const signaling = attachSignaling(wss, store, logger);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '', 'http://internal');
  if (pathname !== wsPath) {
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

function originAllowed(origin: string | undefined): boolean {
  // OBS's embedded browser (CEF) frequently sends Origin "null" or none.
  if (!origin || origin === 'null') return config.allowNullOrigin;
  if (config.allowedOrigins.length === 0) return true; // dev: allow any
  return config.allowedOrigins.includes(origin);
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
    { host: config.host, port: config.port, env: config.env, base: config.basePath },
    'CamBridge server listening'
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  clearInterval(sweepTimer);
  signaling.stop();
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
