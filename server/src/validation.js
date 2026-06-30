// Strict, allow-list validation of every inbound signaling message. The
// signaling server forwards SDP/ICE between strangers, so we treat all input as
// hostile: known types only, bounded sizes, no surprise fields acted upon.

const MAX_SDP_BYTES = 60_000;
const MAX_CANDIDATE_BYTES = 4_000;

// Messages a client is allowed to send.
const CLIENT_TYPES = new Set([
  'join', // { sessionId, passcode, role }
  'offer', // { target, sdp }
  'answer', // { target, sdp }
  'candidate', // { target, candidate }
  'kick', // { target }   (broadcaster only)
  'bye', // { }           graceful leave
]);

export function parseMessage(raw, maxBytes) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.length > maxBytes) return { error: 'message too large' };
    text = raw.toString('utf8');
  } else {
    return { error: 'unsupported frame' };
  }

  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { error: 'message too large' };

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { error: 'message must be an object' };
  }
  if (typeof msg.type !== 'string' || !CLIENT_TYPES.has(msg.type)) {
    return { error: 'unknown message type' };
  }
  return { msg };
}

export function isStr(v, max = 256) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * Validate the SDP payload of an offer/answer. We don't parse SDP semantically
 * (the browser does that); we only bound it and confirm shape so a peer can't
 * be handed garbage.
 */
export function validSdp(sdp) {
  return (
    sdp &&
    typeof sdp === 'object' &&
    (sdp.type === 'offer' || sdp.type === 'answer') &&
    typeof sdp.sdp === 'string' &&
    sdp.sdp.length > 0 &&
    Buffer.byteLength(sdp.sdp, 'utf8') <= MAX_SDP_BYTES
  );
}

/**
 * Validate an ICE candidate payload. `candidate: null` is a legitimate
 * end-of-candidates signal, so allow it.
 */
export function validCandidate(candidate) {
  if (candidate === null) return true;
  if (!candidate || typeof candidate !== 'object') return false;
  if (typeof candidate.candidate !== 'string') return false;
  return Buffer.byteLength(candidate.candidate, 'utf8') <= MAX_CANDIDATE_BYTES;
}
