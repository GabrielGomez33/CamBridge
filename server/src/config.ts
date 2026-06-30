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
  host: process.env.HOST || '0.0.0.0',
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
