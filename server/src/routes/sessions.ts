import { Router, Request, Response } from 'express';
import { config } from '../config';
import type { Logger } from '../logger';
import { SessionStore } from '../webrtc/sessions';
import { makeRateLimiter } from '../util/rateLimit';

function baseUrlFrom(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`)
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

export function sessionRoutes(store: SessionStore, logger: Logger): Router {
  const router = Router();
  const allowCreate = makeRateLimiter(config.createRateLimit, config.createRateWindowMs);

  // Create a dynamic link. Returns the broadcaster URL (phone) and the OBS
  // viewer URL (passcode embedded for the Browser Source).
  router.post('/sessions', (req: Request, res: Response) => {
    if (!allowCreate(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'too many links created, slow down' });
    }
    if (store.size >= config.maxLiveSessions) {
      return res.status(503).json({ error: 'server at capacity, try again shortly' });
    }
    // Auth-gating hook: enforced in Phase 1 when auth middleware lands.
    if (config.requireAuthToCreate && !(req as Request & { user?: unknown }).user) {
      return res.status(401).json({ error: 'login required to create a link' });
    }

    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const session = store.create({ title });
    const base = baseUrlFrom(req) + config.basePath; // e.g. https://host/cambridge
    const q = `s=${encodeURIComponent(session.id)}&p=${encodeURIComponent(session.passcode)}`;
    logger.info({ sessionId: session.id }, 'session created');

    res.status(201).json({
      sessionId: session.id,
      passcode: session.passcode,
      title: session.title,
      broadcastUrl: `${base}/broadcaster?${q}`,
      viewerUrl: `${base}/viewer?${q}`,
    });
  });

  // Lightweight existence/status check used by the viewer before it joins.
  router.get('/sessions/status', (req: Request, res: Response) => {
    const id = String(req.query.s || '');
    const session = id ? store.get(id) : undefined;
    if (!session) return res.status(404).json({ exists: false });
    res.json({
      exists: true,
      status: session.status,
      hasBroadcaster: Boolean(session.broadcaster),
      title: session.title,
    });
  });

  return router;
}
