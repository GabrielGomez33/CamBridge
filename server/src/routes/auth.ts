import { Router } from 'express';
import { verifyToken, rateLimit } from '../auth/middleware';
import * as auth from '../auth/controller';

const MIN = 60_000;

/** Auth routes mounted at `${basePath}/api/auth` (e.g. /cambridge/api/auth). */
export function authRoutes(): Router {
  const r = Router();

  // Public (rate-limited)
  r.post('/register', rateLimit(5, 15 * MIN), auth.register);
  r.post('/login', rateLimit(10, 15 * MIN), auth.login);
  r.post('/refresh', rateLimit(30, 15 * MIN), auth.refresh);
  r.get('/check-username', rateLimit(30, MIN), auth.checkUsername);

  // Email verification
  r.post('/verify-email', rateLimit(20, 15 * MIN), auth.verifyEmailToken);

  // Password reset (always-generic responses + rate limits)
  r.post('/forgot-password', rateLimit(5, 15 * MIN), auth.requestPasswordReset);
  r.get('/reset-password/validate', rateLimit(30, 15 * MIN), auth.validateResetToken);
  r.post('/reset-password', rateLimit(10, 15 * MIN), auth.resetPassword);

  // Authenticated
  r.get('/verify', verifyToken, auth.verify);
  r.post('/logout', verifyToken, auth.logout);
  r.post('/logout-all', verifyToken, auth.logoutAll);
  r.post('/send-verification', verifyToken, rateLimit(5, 15 * MIN), auth.sendVerificationEmail);

  return r;
}
