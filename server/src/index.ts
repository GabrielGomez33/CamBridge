import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';

import { config, validateConfig } from './config';
import { logger } from './logger';
import { dbHealthy } from './db';
import { runMigrations } from './db/migrate';
import { SessionStore } from './webrtc/sessions';
import { attachSignaling } from './webrtc/signaling';
import { sessionRoutes } from './routes/sessions';
import { authRoutes } from './routes/auth';
import { contactRoutes } from './routes/contact';
import { makeRateLimiter } from './util/rateLimit';
import { clientIp } from './util/net';

validateConfig(logger);

const store = new SessionStore();
const app = express();
const api = `${config.basePath}/api`;
const wsPath = `${config.basePath}/ws`;
// The DB is used for accounts (auth) and/or link persistence.
const needsDb = config.authEnabled || config.sessionPersist;

app.set('trust proxy', config.trustProxyHops);
app.use(helmet({ contentSecurityPolicy: false })); // CSP tuned per-page in Phase 2
app.use(express.json({ limit: '64kb' }));

// Health probe (matches mirror/admin convention for the CI/CD health check).
// Only reports DB status when accounts are enabled (else there's no database).
app.get(`${api}/health`, async (_req, res) => {
  const base = { ok: true, sessions: store.size, turn: config.turn.enabled };
  if (!needsDb) return res.json(base);
  const db = await Promise.race([
    dbHealthy(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
  ]);
  res.json({ ...base, db });
});

// Accounts are optional; only expose the auth API when enabled.
if (config.authEnabled) app.use(`${api}/auth`, authRoutes());
app.use(api, sessionRoutes(store, logger));
app.use(api, contactRoutes(logger));

// Static client assets, served UNDER the base path so the whole app lives at one
// mount point (e.g. /cambridge) behind Apache. Apache can either reverse-proxy
// the whole base path here, or serve client/ itself and only proxy /api + /ws.
const CLIENT_DIR = path.resolve(__dirname, '../../client/dist');
app.use(config.basePath, express.static(CLIENT_DIR, { extensions: ['html'] }));
// Convenience redirect from root to the app.
app.get('/', (_req, res) => res.redirect(`${config.basePath}/`));
// SPA history fallback for client routes (/cambridge/broadcaster, /viewer, …).
// Apache also does this in production; this keeps direct hits working too.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith(api)) return next();
  res.sendFile(path.join(CLIENT_DIR, 'index.html'), (err) => (err ? next() : undefined));
});

// ── HTTP + WebSocket ─────────────────────────────────────────────────────────
// Plain HTTP on loopback — Apache terminates TLS and reverse-proxies to us.
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
const signaling = attachSignaling(wss, store, logger);
const allowWsConnect = makeRateLimiter(config.wsConnectLimit, config.wsConnectWindowMs);

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
  // Per-IP WS connection flood protection.
  if (!allowWsConnect(clientIp(req))) {
    logger.warn({ ip: clientIp(req) }, 'ws upgrade rejected: rate limit');
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
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
function bootstrap(): void {
  server.listen(config.port, config.host, () => {
    logger.info(
      { host: config.host, port: config.port, env: config.env, base: config.basePath, auth: config.authEnabled },
      'CamBridge server listening'
    );
  });

  // Touch MySQL only when accounts or link-persistence need it. Failure is
  // non-fatal: streaming still works in-memory.
  if (config.authEnabled && (!config.auth.jwtSecret || !config.auth.jwtRefreshSecret)) {
    logger.warn({}, 'AUTH_ENABLED but JWT secrets are not set — auth will reject tokens.');
  }
  if (needsDb) {
    runMigrations()
      .then(async () => {
        logger.info({}, 'migrations up to date');
        if (config.sessionPersist) {
          const restored = await store.load();
          if (restored) logger.info({ restored }, 'restored persisted links');
        }
      })
      .catch((err) => logger.error({ err }, 'DB init failed — running in-memory only'));
  }
}

bootstrap();

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
