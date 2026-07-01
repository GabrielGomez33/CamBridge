import { Router, Request, Response } from 'express';
import { config } from '../config';
import type { Logger } from '../logger';
import { SessionStore } from '../webrtc/sessions';
import { makeRateLimiter } from '../util/rateLimit';
import { sendTemplate } from '../email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const allowEmail = makeRateLimiter(config.email.linkRateLimit, config.email.linkRateWindowMs);

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

  // Email the OBS viewer link to a recipient. Requires the session's passcode
  // (so only someone who already holds the link can send it) + per-IP limit.
  router.post('/sessions/:id/email', async (req: Request, res: Response) => {
    if (!allowEmail(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'too many emails, slow down' });
    }
    const id = String(req.params.id || '');
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';

    if (!EMAIL_RE.test(to) || to.length > 254) {
      return res.status(422).json({ error: 'enter a valid email address' });
    }
    const session = store.get(id);
    if (!session) return res.status(404).json({ error: 'link not found or expired' });
    if (!store.verifyPasscode(session, passcode)) {
      return res.status(403).json({ error: 'incorrect passcode' });
    }

    const base = baseUrlFrom(req) + config.basePath;
    const viewerUrl = `${base}/viewer?s=${encodeURIComponent(session.id)}&p=${encodeURIComponent(
      session.passcode
    )}`;
    const ok = await sendTemplate(to, 'stream_link', {
      viewerUrl,
      passcode: session.passcode,
      title: session.title,
    });
    if (!ok) {
      logger.warn({ sessionId: session.id }, 'stream link email failed');
      return res.status(502).json({ error: 'could not send email — check the server email config' });
    }
    logger.info({ sessionId: session.id, to }, 'stream link emailed');
    res.json({ message: 'Link sent.' });
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
