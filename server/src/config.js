import 'dotenv/config';

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(name, def) {
  const v = process.env[name];
  if (!v) return def;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 8080),
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // WS upgrade origin allow-list. Empty array => allow any (dev only).
  allowedOrigins: list('ALLOWED_ORIGINS', []),
  allowNullOrigin: bool('ALLOW_NULL_ORIGIN', true),

  // Session lifecycle
  sessionTtlMs: int('SESSION_TTL_MS', 1000 * 60 * 60 * 6),
  passcodeLength: int('PASSCODE_LENGTH', 6),

  // Signaling limits
  maxMessageBytes: int('MAX_MESSAGE_BYTES', 64 * 1024),
  heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 30000),

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

// Fail fast on a misconfigured TURN block so it never silently no-ops.
export function validateConfig(logger) {
  if (config.turn.enabled) {
    if (!config.turn.urls.length || !config.turn.secret) {
      logger.warn(
        'TURN_ENABLED=true but TURN_URLS or TURN_SECRET is empty — TURN will be skipped. ' +
          'Hard-NAT/cellular peers may fail to connect.'
      );
      config.turn.enabled = false;
    }
  } else {
    logger.warn(
      'TURN is disabled (STUN-only). ~15-20% of peers behind symmetric NAT / CGNAT ' +
        '(common on cellular) may fail to connect. Enable coturn for production.'
    );
  }
  if (config.env === 'production' && config.allowedOrigins.length === 0) {
    logger.warn(
      'ALLOWED_ORIGINS is empty in production — the signaling socket will accept ' +
        'any browser origin. Set ALLOWED_ORIGINS to your domain(s).'
    );
  }
}
