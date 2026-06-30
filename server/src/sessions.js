import crypto from 'node:crypto';
import { config } from './config.js';

// Unambiguous alphabet: no 0/O, 1/I/L — easier to read aloud / off a screen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * In-memory store of streaming sessions. Each session is a single dynamic link:
 * one broadcaster (the phone camera app) and one-or-more viewers (OBS browser
 * sources). Realistically a session has exactly one viewer (OBS), but we allow
 * a few so the same camera can feed multiple scenes — each extra viewer costs
 * the broadcaster one more P2P upload (no SFU).
 */
export class SessionStore {
  constructor() {
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  create({ title = '' } = {}) {
    const id = crypto.randomUUID();
    /** @type {Session} */
    const session = {
      id,
      passcode: randomCode(config.passcodeLength),
      title: String(title || '').slice(0, 120),
      broadcaster: null, // peerId of the broadcaster, or null
      viewers: new Set(), // Set<peerId>
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: 'open', // open | live | closed
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  touch(session) {
    if (session) session.lastActivity = Date.now();
  }

  remove(id) {
    this.sessions.delete(id);
  }

  /** Constant-time passcode check; tolerant of case. */
  verifyPasscode(session, passcode) {
    if (!session || typeof passcode !== 'string') return false;
    const a = Buffer.from(session.passcode, 'utf8');
    const b = Buffer.from(passcode.toUpperCase(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** Drop sessions idle longer than the configured TTL. Returns count removed. */
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > config.sessionTtlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size() {
    return this.sessions.size;
  }
}

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} passcode
 * @property {string} title
 * @property {string|null} broadcaster
 * @property {Set<string>} viewers
 * @property {number} createdAt
 * @property {number} lastActivity
 * @property {'open'|'live'|'closed'} status
 */
