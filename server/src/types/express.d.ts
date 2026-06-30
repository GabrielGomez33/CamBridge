import type { AccessClaims } from '../auth/tokens';

// Augment Express's Request so handlers can read the authenticated user that
// AuthMiddleware.verifyToken attaches.
declare global {
  namespace Express {
    interface Request {
      user?: AccessClaims;
      securityContext?: {
        ipAddress: string;
        userAgent: string;
      };
    }
  }
}

export {};
