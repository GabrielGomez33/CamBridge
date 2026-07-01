import crypto from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { insertSession, deleteSession, loadSessions, purgeExpired } from '../sessionRepo';

// Unambiguous alphabet: no 0/O, 1/I/L — easy to read aloud / off a screen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export type SessionStatus = 'open' | 'live' | 'closed';

export interface Session {
  id: string;
  passcode: string;
  title: string;
  ownerUserId: number | null;
  broadcaster: string | null; // peerId
  viewers: Set<string>; // peerIds
  createdAt: number;
  lastActivity: number;
  status: SessionStatus;
}

/**
 * In-memory store of streaming sessions. Each session is one dynamic link: a
 * single broadcaster (phone camera app) and one-or-more viewers (OBS). Normally
 * exactly one viewer; extra viewers each cost the broadcaster one more P2P
 * upload (no SFU).
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  create(opts: { title?: string; ownerUserId?: number | null } = {}): Session {
    const session: Session = {
      id: crypto.randomUUID(),
      passcode: randomCode(config.passcodeLength),
      title: String(opts.title || '').slice(0, 120),
      ownerUserId: opts.ownerUserId ?? null,
      broadcaster: null,
      viewers: new Set(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: 'open',
    };
    this.sessions.set(session.id, session);
    if (config.sessionPersist) {
      insertSession({
        id: session.id,
        passcode: session.passcode,
        title: session.title,
        ownerUserId: session.ownerUserId,
        createdAt: session.createdAt,
      }).catch((err) => logger.warn({ err, sessionId: session.id }, 'session persist failed'));
    }
    return session;
  }

  /**
   * Load persisted links on boot so a restart/deploy doesn't invalidate them.
   * Live peer state resets — broadcaster + OBS auto-reconnect and re-join.
   */
  async load(): Promise<number> {
    if (!config.sessionPersist) return 0;
    const now = Date.now();
    const minCreated = now - config.sessionMaxMs;
    let rows;
    try {
      rows = await loadSessions(minCreated);
      void purgeExpired(minCreated);
    } catch (err) {
      logger.warn({ err }, 'session load failed — starting with an empty store');
      return 0;
    }
    for (const r of rows) {
      if (this.sessions.has(r.id)) continue;
      this.sessions.set(r.id, {
        id: r.id,
        passcode: r.passcode,
        title: r.title,
        ownerUserId: r.ownerUserId,
        broadcaster: null,
        viewers: new Set(),
        createdAt: r.createdAt,
        lastActivity: now, // fresh idle window after restart
        status: 'open',
      });
    }
    return rows.length;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  touch(session: Session | undefined): void {
    if (session) session.lastActivity = Date.now();
  }

  remove(id: string): void {
    this.sessions.delete(id);
    if (config.sessionPersist) {
      deleteSession(id).catch((err) => logger.warn({ err, sessionId: id }, 'session unpersist failed'));
    }
  }

  /** Constant-time passcode check; tolerant of case. */
  verifyPasscode(session: Session | undefined, passcode: unknown): boolean {
    if (!session || typeof passcode !== 'string') return false;
    const a = Buffer.from(session.passcode, 'utf8');
    const b = Buffer.from(passcode.toUpperCase(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Reclaim sessions that are either idle beyond the TTL (abandoned) or older
   * than the absolute max lifetime (a passcode link must not live forever).
   * Returns the count removed.
   */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [id, s] of this.sessions) {
      const idle = now - s.lastActivity > config.sessionTtlMs;
      const expired = now - s.createdAt > config.sessionMaxMs;
      if (idle || expired) {
        this.sessions.delete(id);
        if (config.sessionPersist) {
          deleteSession(id).catch((err) =>
            logger.warn({ err, sessionId: id }, 'session unpersist failed')
          );
        }
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}
