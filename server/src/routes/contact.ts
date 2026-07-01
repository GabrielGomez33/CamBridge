import { Router, Request, Response } from 'express';
import { config } from '../config';
import type { Logger } from '../logger';
import { makeRateLimiter } from '../util/rateLimit';
import { sendContactInquiry } from '../email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public contact / inquiry endpoint. Emulates mirror-server's feedback/support
 * flow (email to the support inbox, reply-to the sender) but without accounts —
 * gated by a per-IP rate limit + a honeypot instead of auth.
 */
export function contactRoutes(logger: Logger): Router {
  const router = Router();
  const allow = makeRateLimiter(config.email.contactRateLimit, config.email.contactRateWindowMs);

  router.post('/contact', async (req: Request, res: Response) => {
    if (!allow(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'too many messages — try again later' });
    }

    const name = str(req.body?.name, 120);
    const email = str(req.body?.email, 254);
    const subject = str(req.body?.subject, 200);
    const message = str(req.body?.message, 5000);
    const honeypot = str(req.body?.company, 200); // bots fill hidden fields

    // Silently accept honeypot hits so bots don't learn they were caught.
    if (honeypot) return res.json({ message: 'Thanks — your message is on its way.' });

    if (!EMAIL_RE.test(email)) return res.status(422).json({ error: 'enter a valid email' });
    if (!subject) return res.status(422).json({ error: 'a subject is required' });
    if (message.length < 5) return res.status(422).json({ error: 'please write a message' });
    if (!config.email.supportInbox) {
      return res.status(503).json({ error: 'contact is not configured' });
    }

    const ok = await sendContactInquiry({ name, email, subject, message, ip: req.ip });
    logger.info({ email, ok }, 'contact inquiry received');
    if (!ok) {
      return res.status(502).json({ error: 'could not send your message — please try again later' });
    }
    res.json({ message: 'Thanks — your message is on its way.' });
  });

  return router;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
