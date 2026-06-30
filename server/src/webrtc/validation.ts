// Strict, allow-list validation of every inbound signaling message. The
// signaling server forwards SDP/ICE between strangers, so all input is treated
// as hostile: known types only, bounded sizes, no surprise fields acted upon.

const MAX_SDP_BYTES = 60_000;
const MAX_CANDIDATE_BYTES = 4_000;

const CLIENT_TYPES = new Set([
  'join', // { sessionId, passcode, role }
  'offer', // { target, sdp }
  'answer', // { target, sdp }
  'candidate', // { target, candidate }
  'stats', // { metrics }   broadcaster telemetry
  'kick', // { target }     broadcaster only
  'bye', // { }
]);

export interface ClientMessage {
  type: string;
  [k: string]: unknown;
}

export function parseMessage(
  raw: unknown,
  maxBytes: number
): { msg?: ClientMessage; error?: string } {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.length > maxBytes) return { error: 'message too large' };
    text = raw.toString('utf8');
  } else {
    return { error: 'unsupported frame' };
  }

  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { error: 'message too large' };

  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { error: 'message must be an object' };
  }
  const type = (msg as Record<string, unknown>).type;
  if (typeof type !== 'string' || !CLIENT_TYPES.has(type)) {
    return { error: 'unknown message type' };
  }
  return { msg: msg as ClientMessage };
}

export function isStr(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

export interface SdpPayload {
  type: 'offer' | 'answer';
  sdp: string;
}

/** Bound and shape-check an SDP payload (the browser does the real parsing). */
export function validSdp(sdp: unknown): sdp is SdpPayload {
  if (!sdp || typeof sdp !== 'object') return false;
  const s = sdp as Record<string, unknown>;
  return (
    (s.type === 'offer' || s.type === 'answer') &&
    typeof s.sdp === 'string' &&
    s.sdp.length > 0 &&
    Buffer.byteLength(s.sdp, 'utf8') <= MAX_SDP_BYTES
  );
}

/** Validate an ICE candidate. `null` is a legit end-of-candidates signal. */
export function validCandidate(candidate: unknown): boolean {
  if (candidate === null) return true;
  if (!candidate || typeof candidate !== 'object') return false;
  const c = candidate as Record<string, unknown>;
  if (typeof c.candidate !== 'string') return false;
  return Buffer.byteLength(c.candidate, 'utf8') <= MAX_CANDIDATE_BYTES;
}
