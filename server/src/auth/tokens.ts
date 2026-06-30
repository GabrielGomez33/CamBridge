import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';
import { DB } from '../db';
import { config } from '../config';

export interface AccessClaims {
  id: number;
  email: string;
  username: string;
  sessionId: string;
}
export interface RefreshClaims {
  id: number;
  sessionId: string;
}

export interface SessionMeta {
  userAgent?: string | null;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
}

/**
 * Hybrid token + DB session auth (ported from mirror-server):
 *  - short-lived access JWT (15m), long-lived refresh JWT (7d)
 *  - every token references a row in `user_sessions`; the token is only valid
 *    while that session exists, is unexpired, and not revoked.
 *  - logout / password-change flip `revoked`, instantly killing refresh.
 */
export const TokenManager = {
  async createSession(userId: number, meta: SessionMeta): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex'); // 64 chars
    const expiresAt = new Date(Date.now() + config.auth.sessionTtlSec * 1000);
    await DB.query(
      `INSERT INTO user_sessions (user_id, session_id, user_agent, ip_address, device_fingerprint, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        sessionId,
        meta.userAgent ?? null,
        meta.ipAddress ?? null,
        meta.deviceFingerprint ?? null,
        expiresAt,
      ]
    );
    return sessionId;
  },

  async validateSession(userId: number, sessionId: string): Promise<boolean> {
    const [rows] = await DB.query<RowDataPacket[]>(
      `SELECT id FROM user_sessions
       WHERE session_id = ? AND user_id = ? AND revoked = 0 AND expires_at > NOW()
       LIMIT 1`,
      [sessionId, userId]
    );
    return rows.length > 0;
  },

  async revokeSession(sessionId: string): Promise<void> {
    await DB.query(
      `UPDATE user_sessions SET revoked = 1, revoked_at = NOW() WHERE session_id = ? AND revoked = 0`,
      [sessionId]
    );
  },

  async revokeAllUserSessions(userId: number, exceptSessionId?: string): Promise<void> {
    if (exceptSessionId) {
      await DB.query(
        `UPDATE user_sessions SET revoked = 1, revoked_at = NOW()
         WHERE user_id = ? AND revoked = 0 AND session_id <> ?`,
        [userId, exceptSessionId]
      );
    } else {
      await DB.query(
        `UPDATE user_sessions SET revoked = 1, revoked_at = NOW() WHERE user_id = ? AND revoked = 0`,
        [userId]
      );
    }
  },

  signAccess(claims: AccessClaims): string {
    return jwt.sign(claims, config.auth.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: config.auth.accessTtlSec,
    });
  },

  signRefresh(claims: RefreshClaims): string {
    return jwt.sign(claims, config.auth.jwtRefreshSecret, {
      algorithm: 'HS256',
      expiresIn: config.auth.refreshTtlSec,
    });
  },

  verifyAccess(token: string): AccessClaims | null {
    try {
      return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] }) as AccessClaims;
    } catch {
      return null;
    }
  },

  verifyRefresh(token: string): RefreshClaims | null {
    try {
      return jwt.verify(token, config.auth.jwtRefreshSecret, {
        algorithms: ['HS256'],
      }) as RefreshClaims;
    } catch {
      return null;
    }
  },
};
