// Input normalization + validation shared by the auth handlers. Mirrors the
// hardening in mirror-server / the Mirror client so behaviour is consistent
// across devices (notably iOS smart-quote substitution).

/** Trim, strip inline whitespace, lowercase, cap length. */
export function sanitizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, '').toLowerCase().slice(0, 100);
}

/** Normalize iOS smart quotes / dashes so a password hashes identically anywhere. */
export function normalizePassword(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/…/g, '...');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 100;
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export function validUsername(username: unknown): username is string {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

/** 8–128 chars with upper, lower, number, and symbol. Returns null if OK. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 128) return 'Password is too long';
  if (!/[a-z]/.test(pw)) return 'Password needs a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password needs an uppercase letter';
  if (!/[0-9]/.test(pw)) return 'Password needs a number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password needs a symbol';
  return null;
}

// Reject obvious throwaway domains at registration.
const DISPOSABLE = new Set([
  'mailinator.com',
  '10minutemail.com',
  'guerrillamail.com',
  'tempmail.com',
  'trashmail.com',
  'yopmail.com',
  'getnada.com',
  'dispostable.com',
]);
export function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1] || '';
  return DISPOSABLE.has(domain);
}
