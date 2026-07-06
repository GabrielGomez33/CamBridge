// iOS audio-session priming for the stricter standalone-PWA WebKit context.
//
// Parallel to the video fix: in the installed (home-screen) PWA, iOS can hand
// back a suspended / silent microphone track from getUserMedia unless an
// AudioContext has been activated inside the user gesture. Merely holding the
// MediaStreamTrack isn't enough — the OS audio session has to be running for
// the mic to actually capture and for WebRTC to transmit it.
//
// So on "Go Live" we:
//   1. create + resume() a single shared AudioContext (must happen in-gesture),
//   2. route the mic through a gain(0) → destination sink, which keeps the
//      capture session alive with NO audible local output (no echo),
//   3. resume() again whenever we return from the background (iOS suspends the
//      context when the app is hidden).
//
// All of this is a no-op harmless overlay on desktop / Android — the mic track
// is still sent directly by the RTCPeerConnection; the Web Audio graph only
// taps it to keep iOS's audio session warm.

let ctx = null;
let sinkSource = null;
let sinkGain = null;

function getCtx() {
  try {
    const AC = window.AudioContext || /** @type any */ (window).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Create + resume the shared AudioContext. MUST be called synchronously inside
 * the user gesture (before any await) so iOS activates the audio session.
 */
export function primeAudioSession() {
  const c = getCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  return c;
}

/** Re-activate after returning from the background (iOS suspends on hide). */
export function resumeAudioSession() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/**
 * Keep the mic capturing on iOS by wiring it through a silent sink. Safe to
 * call repeatedly (e.g. after switching mics) — it rebuilds the tap.
 * @param {MediaStream} stream a stream containing the live audio track
 */
export function keepMicAlive(stream) {
  const c = primeAudioSession();
  if (!c || !stream || !stream.getAudioTracks().length) return;
  releaseMicSink();
  try {
    sinkSource = c.createMediaStreamSource(stream);
    sinkGain = c.createGain();
    sinkGain.gain.value = 0; // silent — keeps the session alive without echo
    sinkSource.connect(sinkGain);
    sinkGain.connect(c.destination);
  } catch {
    /* tap is best-effort; the RTCPeerConnection still sends the track */
  }
}

export function releaseMicSink() {
  try {
    sinkSource?.disconnect();
    sinkGain?.disconnect();
  } catch {
    /* noop */
  }
  sinkSource = null;
  sinkGain = null;
}
