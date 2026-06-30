import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { RowDataPacket } from 'mysql2';
import { DB } from '../db';
import { TokenManager } from './tokens';

/**
 * Verify the Bearer access token, confirm its session is still live, and that
 * the account isn't locked (auto-unlocking when a lock has expired). On success
 * attaches `req.user` and `req.securityContext`.
 */
export const verifyToken: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    return;
  }

  const claims = TokenManager.verifyAccess(token);
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    return;
  }

  const sessionOk = await TokenManager.validateSession(claims.id, claims.sessionId);
  if (!sessionOk) {
    res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    return;
  }

  // Account lock check with auto-unlock when the lock window has passed.
  const [rows] = await DB.query<RowDataPacket[]>(
    'SELECT account_locked, locked_until FROM users WHERE id = ? LIMIT 1',
    [claims.id]
  );
  const u = rows[0];
  if (!u) {
    res.status(401).json({ error: 'Account not found', code: 'NO_USER' });
    return;
  }
  if (u.account_locked) {
    const until = u.locked_until ? new Date(u.locked_until).getTime() : 0;
    if (until && until <= Date.now()) {
      await DB.query('UPDATE users SET account_locked = 0, locked_until = NULL WHERE id = ?', [claims.id]);
    } else {
      res.status(403).json({ error: 'Account locked', code: 'ACCOUNT_LOCKED' });
      return;
    }
  }

  req.user = claims;
  req.securityContext = { ipAddress: req.ip || '', userAgent: String(req.headers['user-agent'] || '') };
  next();
};

/**
 * In-memory per-identity rate limiter (identity = user id when authenticated,
 * else client IP). Swap for Redis in a multi-instance deployment.
 */
const buckets = new Map<string, { count: number; reset: number }>();
export function rateLimit(limit: number, windowMs: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip || 'unknown'}`;
    const key = `${id}:${limit}:${windowMs}`;
    const now = Date.now();
    const rec = buckets.get(key);
    if (!rec || now > rec.reset) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    rec.count++;
    if (rec.count > limit) {
      res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMIT' });
      return;
    }
    next();
  };
}
