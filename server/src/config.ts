import 'dotenv/config';

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(name: string, def: string[]): string[] {
  const v = process.env[name];
  if (!v) return def;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  // Bind to loopback by default — Apache terminates TLS and proxies to us
  // (admin pattern). Set HOST=0.0.0.0 only for direct LAN testing.
  host: process.env.HOST || '127.0.0.1',
  port: int('CAMBRIDGE_PORT', 8447),
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Base path everything mounts under (mirrors the /mirror, /admin convention).
  basePath: process.env.BASE_PATH || '/cambridge',

  // WS upgrade origin allow-list. Empty array => allow any (dev only).
  allowedOrigins: list('ALLOWED_ORIGINS', []),
  allowNullOrigin: bool('ALLOW_NULL_ORIGIN', true),

  // Trust N reverse-proxy hops so req.ip reflects the real client (nginx).
  trustProxyHops: int('TRUST_PROXY_HOPS', 1),

  // Whether creating a stream link requires a logged-in account.
  requireAuthToCreate: bool('REQUIRE_AUTH_TO_CREATE', false),

  // Session lifecycle
  sessionTtlMs: int('SESSION_TTL_MS', 1000 * 60 * 60 * 6),
  passcodeLength: int('PASSCODE_LENGTH', 6),
  maxLiveSessions: int('MAX_LIVE_SESSIONS', 500),

  // Signaling limits
  maxMessageBytes: int('MAX_MESSAGE_BYTES', 64 * 1024),
  heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 30000),

  // Abuse limits
  createRateLimit: int('CREATE_RATE_LIMIT', 20), // per IP
  createRateWindowMs: int('CREATE_RATE_WINDOW_MS', 60_000),

  // Public base URL for building shareable links (no trailing slash)
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  // ICE
  stunUrls: list('STUN_URLS', ['stun:stun.l.google.com:19302']),
  turn: {
    enabled: bool('TURN_ENABLED', false),
    urls: list('TURN_URLS', []),
    secret: process.env.TURN_SECRET || '',
    ttlSec: int('TURN_TTL_SEC', 3600),
  },

  // Database (MySQL) — mirrors mirror-server's pool config.
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'cambridge',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'cambridge',
    poolSize: int('DB_POOL_SIZE', 20),
  },

  // Auth / JWT
  auth: {
    jwtSecret: process.env.JWT_SECRET || '',
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || '',
    accessTtlSec: int('JWT_ACCESS_TTL_SEC', 15 * 60), // 15m
    refreshTtlSec: int('JWT_REFRESH_TTL_SEC', 7 * 24 * 60 * 60), // 7d
    sessionTtlSec: int('AUTH_SESSION_TTL_SEC', 24 * 60 * 60), // 24h
    requireEmailVerified: bool('LOGIN_REQUIRE_EMAIL_VERIFIED', false),
  },

  // Email (Resend or Brevo)
  email: {
    provider: (process.env.EMAIL_PROVIDER || 'resend').toLowerCase(),
    resendApiKey: process.env.RESEND_API_KEY || '',
    brevoApiKey: process.env.BREVO_API_KEY || '',
    from: process.env.EMAIL_FROM || 'CamBridge <no-reply@cambridge.local>',
    dryRun: bool('EMAIL_DRY_RUN', true),
  },

  // Public app URL used to build verification / reset links in emails.
  appUrl: (process.env.APP_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
};

export type AppConfig = typeof config;

/** Warn loudly on misconfig so TURN/origins never silently no-op. */
export function validateConfig(log: { warn: (o: unknown, m?: string) => void }): void {
  if (config.turn.enabled && (!config.turn.urls.length || !config.turn.secret)) {
    log.warn(
      {},
      'TURN_ENABLED=true but TURN_URLS/TURN_SECRET empty — TURN disabled. Hard-NAT/cellular peers may fail.'
    );
    config.turn.enabled = false;
  } else if (!config.turn.enabled) {
    log.warn(
      {},
      'TURN disabled (STUN-only). ~15-20% of peers behind symmetric NAT/CGNAT may fail to connect.'
    );
  }
  if (config.env === 'production' && config.allowedOrigins.length === 0) {
    log.warn({}, 'ALLOWED_ORIGINS empty in production — signaling accepts any origin.');
  }
}
