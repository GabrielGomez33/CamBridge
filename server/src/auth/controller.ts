import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { DB } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { TokenManager, SessionMeta } from './tokens';
import { sendTemplate } from '../email';
import {
  sanitizeEmail,
  normalizePassword,
  validEmail,
  validUsername,
  passwordProblem,
  isDisposableEmail,
} from './util';

const SALT_ROUNDS = 10;
// Constant bcrypt hash compared against on user-not-found so login timing does
// not reveal whether an email exists.
const DUMMY_HASH = bcrypt.hashSync('cambridge_dummy_password_x', SALT_ROUNDS);

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  email_verified: number;
  account_locked: number;
  locked_until: string | null;
  role: string;
  last_login: string | null;
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    emailVerified: Boolean(u.email_verified),
    role: u.role,
    lastLogin: u.last_login,
  };
}

function metaFrom(req: Request): SessionMeta {
  return {
    userAgent: String(req.headers['user-agent'] || '').slice(0, 255) || null,
    ipAddress: (req.ip || '').slice(0, 64) || null,
    deviceFingerprint:
      typeof req.body?.deviceFingerprint === 'string'
        ? req.body.deviceFingerprint.slice(0, 255)
        : null,
  };
}

async function issueTokens(u: UserRow, req: Request) {
  const sessionId = await TokenManager.createSession(u.id, metaFrom(req));
  const accessToken = TokenManager.signAccess({
    id: u.id,
    email: u.email,
    username: u.username,
    sessionId,
  });
  const refreshToken = TokenManager.signRefresh({ id: u.id, sessionId });
  return { accessToken, refreshToken, expiresIn: config.auth.accessTtlSec, sessionId };
}

async function findByEmail(email: string): Promise<UserRow | undefined> {
  const [rows] = await DB.query<UserRow[]>('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  return rows[0];
}
async function findById(id: number): Promise<UserRow | undefined> {
  const [rows] = await DB.query<UserRow[]>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0];
}

// ── handlers ──────────────────────────────────────────────────────────────────

export async function register(req: Request, res: Response): Promise<void> {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const email = sanitizeEmail(req.body?.email);
  const password = normalizePassword(req.body?.password);

  if (!validUsername(username)) {
    res.status(422).json({ error: 'Username must be 3-20 letters, numbers or underscore', code: 'BAD_USERNAME' });
    return;
  }
  if (!validEmail(email)) {
    res.status(422).json({ error: 'Enter a valid email', code: 'BAD_EMAIL' });
    return;
  }
  if (isDisposableEmail(email)) {
    res.status(422).json({ error: 'Disposable email addresses are not allowed', code: 'DISPOSABLE_EMAIL' });
    return;
  }
  const pwProblem = passwordProblem(password);
  if (pwProblem) {
    res.status(422).json({ error: pwProblem, code: 'WEAK_PASSWORD' });
    return;
  }

  const [dupes] = await DB.query<RowDataPacket[]>(
    'SELECT email, username FROM users WHERE email = ? OR username = ? LIMIT 1',
    [email, username]
  );
  if (dupes.length) {
    const taken = dupes[0].email === email ? 'Email already registered' : 'Username taken';
    res.status(409).json({ error: taken, code: 'ALREADY_EXISTS' });
    return;
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const [result] = await DB.query<ResultSetHeader>(
    'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
    [username, email, hash]
  );
  const user = await findById(result.insertId);
  if (!user) {
    res.status(500).json({ error: 'Registration failed', code: 'INTERNAL' });
    return;
  }

  await sendVerificationFor(user).catch((err) => logger.error({ err }, 'verification email failed'));
  await sendTemplate(email, 'welcome', { username }).catch(() => {});

  const tokens = await issueTokens(user, req);
  logger.info({ userId: user.id, username }, 'user registered');
  res.status(201).json({ message: 'Registration successful', user: publicUser(user), tokens });
}

export async function login(req: Request, res: Response): Promise<void> {
  const email = sanitizeEmail(req.body?.email);
  const password = normalizePassword(req.body?.password);
  const user = await findByEmail(email);

  // Always run a bcrypt compare to keep timing uniform.
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) {
    res.status(401).json({ error: 'Email or password is incorrect', code: 'INVALID_CREDENTIALS' });
    return;
  }

  if (user.account_locked) {
    res.status(403).json({ error: 'Account locked', code: 'ACCOUNT_LOCKED' });
    return;
  }
  if (config.auth.requireEmailVerified && !user.email_verified) {
    res.status(403).json({ error: 'Verify your email to sign in', code: 'EMAIL_NOT_VERIFIED' });
    return;
  }

  await DB.query('UPDATE users SET last_login = NOW(), last_active = NOW() WHERE id = ?', [user.id]);
  const tokens = await issueTokens(user, req);
  logger.info({ userId: user.id }, 'user logged in');
  res.json({ message: 'Login successful', user: publicUser(user), tokens });
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.user) await TokenManager.revokeSession(req.user.sessionId);
  res.json({ message: 'Logged out successfully' });
}

export async function logoutAll(req: Request, res: Response): Promise<void> {
  if (req.user) await TokenManager.revokeAllUserSessions(req.user.id);
  res.json({ message: 'All sessions revoked' });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
  const claims = token ? TokenManager.verifyRefresh(token) : null;
  if (!claims) {
    res.status(401).json({ error: 'Refresh token invalid or expired', code: 'INVALID_REFRESH_TOKEN' });
    return;
  }
  const sessionOk = await TokenManager.validateSession(claims.id, claims.sessionId);
  if (!sessionOk) {
    res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    return;
  }
  const user = await findById(claims.id);
  if (!user) {
    res.status(401).json({ error: 'Account not found', code: 'NO_USER' });
    return;
  }
  const accessToken = TokenManager.signAccess({
    id: user.id,
    email: user.email,
    username: user.username,
    sessionId: claims.sessionId,
  });
  res.json({ accessToken, expiresIn: config.auth.accessTtlSec });
}

export async function verify(req: Request, res: Response): Promise<void> {
  const user = req.user ? await findById(req.user.id) : undefined;
  if (!user) {
    res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    return;
  }
  res.json({ valid: true, user: publicUser(user) });
}

export async function checkUsername(req: Request, res: Response): Promise<void> {
  const username = String(req.query.username || '').trim();
  if (!validUsername(username)) {
    res.json({ available: false, valid: false });
    return;
  }
  const [rows] = await DB.query<RowDataPacket[]>('SELECT id FROM users WHERE username = ? LIMIT 1', [
    username,
  ]);
  res.json({ available: rows.length === 0, valid: true });
}

// ── email verification ────────────────────────────────────────────────────────

async function sendVerificationFor(user: UserRow): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex');
  await DB.query(
    'INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
    [user.id, token, new Date(Date.now() + EMAIL_TOKEN_TTL_MS)]
  );
  const verificationUrl = `${config.appUrl}/verify-email?token=${token}`;
  await sendTemplate(user.email, 'email_verification', { username: user.username, verificationUrl });
}

export async function sendVerificationEmail(req: Request, res: Response): Promise<void> {
  const user = req.user ? await findById(req.user.id) : undefined;
  if (!user) {
    res.status(401).json({ error: 'Authentication required', code: 'NO_USER' });
    return;
  }
  if (user.email_verified) {
    res.json({ message: 'Email already verified', verified: true });
    return;
  }
  await sendVerificationFor(user);
  res.json({ message: 'Verification email sent' });
}

export async function verifyEmailToken(req: Request, res: Response): Promise<void> {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) {
    res.status(400).json({ error: 'Missing token', code: 'TOKEN_NOT_FOUND' });
    return;
  }
  const [rows] = await DB.query<RowDataPacket[]>(
    'SELECT id, user_id FROM email_verification_tokens WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
    [token]
  );
  if (!rows.length) {
    res.status(400).json({ error: 'Link expired or already used', code: 'TOKEN_EXPIRED' });
    return;
  }
  await DB.query('UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ?', [rows[0].id]);
  await DB.query('UPDATE users SET email_verified = 1 WHERE id = ?', [rows[0].user_id]);
  res.json({ message: 'Email verified successfully', verified: true });
}

// ── password reset ──────────────────────────────────────────────────────────

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function requestPasswordReset(req: Request, res: Response): Promise<void> {
  const email = sanitizeEmail(req.body?.email);
  const generic = { message: "If that email exists, we've sent a reset link." };

  const user = email ? await findByEmail(email) : undefined;
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    await DB.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
      [
        user.id,
        sha256(token),
        new Date(Date.now() + RESET_TOKEN_TTL_MS),
        (req.ip || '').slice(0, 64),
        String(req.headers['user-agent'] || '').slice(0, 255),
      ]
    );
    const resetUrl = `${config.appUrl}/reset-password?token=${token}`;
    await sendTemplate(user.email, 'password_reset', {
      username: user.username,
      resetUrl,
      expiresInMinutes: String(RESET_TOKEN_TTL_MS / 60000),
      ipAddress: req.ip || 'unknown',
    });
  }
  // Same response whether or not the email exists.
  res.json(generic);
}

export async function validateResetToken(req: Request, res: Response): Promise<void> {
  const token = String(req.query.token || '');
  if (!token) {
    res.status(400).json({ valid: false, code: 'TOKEN_NOT_FOUND' });
    return;
  }
  const [rows] = await DB.query<RowDataPacket[]>(
    'SELECT expires_at FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
    [sha256(token)]
  );
  if (!rows.length) {
    res.status(400).json({ valid: false, code: 'TOKEN_EXPIRED' });
    return;
  }
  res.json({ valid: true, expiresAt: rows[0].expires_at });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const newPassword = normalizePassword(req.body?.newPassword);
  const pwProblem = passwordProblem(newPassword);
  if (pwProblem) {
    res.status(400).json({ error: pwProblem, code: 'WEAK_PASSWORD' });
    return;
  }
  const [rows] = await DB.query<RowDataPacket[]>(
    'SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
    [sha256(token)]
  );
  if (!rows.length) {
    res.status(400).json({ error: 'Reset link expired or already used', code: 'TOKEN_EXPIRED' });
    return;
  }
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const userId = rows[0].user_id as number;
  await DB.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  await DB.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [rows[0].id]);
  // Reset revokes every session — force re-login everywhere.
  await TokenManager.revokeAllUserSessions(userId);
  logger.info({ userId }, 'password reset');
  res.json({ message: 'Password reset successfully. All sessions revoked.' });
}
