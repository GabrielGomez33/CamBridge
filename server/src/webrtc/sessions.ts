import crypto from 'node:crypto';
import { config } from '../config';

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
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  touch(session: Session | undefined): void {
    if (session) session.lastActivity = Date.now();
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  /** Constant-time passcode check; tolerant of case. */
  verifyPasscode(session: Session | undefined, passcode: unknown): boolean {
    if (!session || typeof passcode !== 'string') return false;
    const a = Buffer.from(session.passcode, 'utf8');
    const b = Buffer.from(passcode.toUpperCase(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** Drop sessions idle longer than the configured TTL. Returns count removed. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > config.sessionTtlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}
