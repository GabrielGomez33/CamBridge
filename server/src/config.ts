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

  // Accounts. Off by default — CamBridge's core (passcode-gated streaming) needs
  // no accounts and no database. Flip on to expose the auth API + run migrations.
  authEnabled: bool('AUTH_ENABLED', false),
  // Whether creating a stream link requires a logged-in account (needs auth).
  requireAuthToCreate: bool('REQUIRE_AUTH_TO_CREATE', false),

  // Session lifecycle
  sessionTtlMs: int('SESSION_TTL_MS', 1000 * 60 * 60 * 3), // idle sweep (3h)
  sessionMaxMs: int('SESSION_MAX_MS', 1000 * 60 * 60 * 24), // absolute cap (24h)
  passcodeLength: int('PASSCODE_LENGTH', 6),
  maxLiveSessions: int('MAX_LIVE_SESSIONS', 500),
  // Persist link metadata to `stream_sessions` so restarts don't kill links.
  sessionPersist: bool('SESSION_PERSIST', true),

  // Signaling limits
  maxMessageBytes: int('MAX_MESSAGE_BYTES', 64 * 1024),
  heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 30000),

  // Abuse limits
  createRateLimit: int('CREATE_RATE_LIMIT', 20), // link creations per IP / window
  createRateWindowMs: int('CREATE_RATE_WINDOW_MS', 60_000),
  wsConnectLimit: int('WS_CONNECT_LIMIT', 30), // WS upgrades per IP / window
  wsConnectWindowMs: int('WS_CONNECT_WINDOW_MS', 60_000),
  joinFailLimit: int('JOIN_FAIL_LIMIT', 10), // bad-passcode attempts per IP / window
  joinFailWindowMs: int('JOIN_FAIL_WINDOW_MS', 10 * 60_000),

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

  // Email (Resend or Brevo) — used for sending stream links (and auth mail).
  email: {
    provider: (process.env.EMAIL_PROVIDER || 'resend').toLowerCase(),
    resendApiKey: process.env.RESEND_API_KEY || '',
    brevoApiKey: process.env.BREVO_API_KEY || '',
    // Prefer EMAIL_FROM; else build "CamBridge <EMAIL_FROM_ADDRESS>" from the
    // shared address so it sends from your verified domain.
    from:
      process.env.EMAIL_FROM ||
      `CamBridge <${process.env.EMAIL_FROM_ADDRESS || 'no-reply@localhost'}>`,
    // Match mirror-server: sending is ON unless EMAIL_DRY_RUN is explicitly true.
    dryRun: bool('EMAIL_DRY_RUN', false),
    // Where contact/inquiry emails are delivered (replies go to the sender).
    supportInbox: (process.env.SUPPORT_INBOX_EMAIL || '').trim(),
    // Emailing the link is rate-limited per IP.
    linkRateLimit: int('EMAIL_LINK_RATE_LIMIT', 5),
    linkRateWindowMs: int('EMAIL_LINK_RATE_WINDOW_MS', 15 * 60_000),
    // Contact-form submissions are rate-limited per IP.
    contactRateLimit: int('CONTACT_RATE_LIMIT', 5),
    contactRateWindowMs: int('CONTACT_RATE_WINDOW_MS', 60 * 60_000),
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
  // A missing EMAIL_FROM_ADDRESS leaves an invalid "from" (…@localhost) that
  // Resend/Brevo reject — surface it clearly rather than failing per-send.
  if (!config.email.dryRun && /@localhost>?$/.test(config.email.from)) {
    log.warn(
      {},
      'EMAIL_FROM_ADDRESS is not set — outgoing "from" is invalid (@localhost) and email will be rejected. ' +
        'Set EMAIL_FROM_ADDRESS to a Resend-verified address.'
    );
  }
}
