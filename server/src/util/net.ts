import type { IncomingMessage } from 'node:http';

// Real client IP behind Apache: prefer the first X-Forwarded-For hop, fall back
// to the socket address. (Apache is trusted; we set X-Forwarded-For upstream.)
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
