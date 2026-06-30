import crypto from 'node:crypto';
import { config } from '../config';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Build the ICE server list handed to a browser when it joins a session.
 *
 * STUN is always included. When TURN is enabled we mint short-lived credentials
 * using coturn's `use-auth-secret` (TURN REST) scheme:
 *
 *   username   = <expiryUnixSeconds>[:<label>]
 *   credential = base64( HMAC-SHA1( static-auth-secret, username ) )
 *
 * The credential is valid only until `expiry`, so no long-lived TURN password is
 * ever exposed to a client and coturn needs no per-user records.
 */
export function buildIceConfig(label = ''): { iceServers: IceServer[]; turnEnabled: boolean } {
  const iceServers: IceServer[] = [];

  if (config.stunUrls.length) {
    iceServers.push({ urls: config.stunUrls });
  }

  const turnReady = config.turn.enabled && config.turn.urls.length > 0 && Boolean(config.turn.secret);
  if (turnReady) {
    const expiry = Math.floor(Date.now() / 1000) + config.turn.ttlSec;
    const username = label ? `${expiry}:${label}` : `${expiry}`;
    const credential = crypto
      .createHmac('sha1', config.turn.secret)
      .update(username)
      .digest('base64');
    iceServers.push({ urls: config.turn.urls, username, credential });
  }

  return { iceServers, turnEnabled: turnReady };
}
