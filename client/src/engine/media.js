// Robust media access + permission handling. Modeled on Mirror's VocalStep /
// VisualStep proven flow, extended for camera+mic:
//  - secure-context + capability + platform probe
//  - Permissions API state (with graceful fallback where unsupported: iOS/Safari)
//  - getUserMedia with a 3-tier constraint fallback ladder
//  - full error taxonomy -> actionable messages
//  - device enumeration (labels only appear post-permission) + hot-plug watch
//
// GESTURE PRESERVATION: acquireCamera/acquireMic must be the FIRST awaited call
// inside a user-gesture handler (no awaits before them) or iOS/Safari will block
// the prompt. Callers do sync setup only, then await these.

export function probeEnvironment() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !(/** @type any */ (window).MSStream);
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid || /Mobile|webOS|BlackBerry|Opera Mini|IEMobile/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/CriOS/.test(ua) && !/FxiOS/.test(ua);
  const isFirefox = /Firefox/.test(ua) || /FxiOS/.test(ua);
  const isChrome = /Chrome/.test(ua) && !/Edg/.test(ua) && !/OPR/.test(ua);
  const supportsGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const supportsPermissionsAPI = !!(navigator.permissions && navigator.permissions.query);
  return { isIOS, isAndroid, isMobile, isSafari, isFirefox, isChrome, supportsGetUserMedia, supportsPermissionsAPI };
}

/** getUserMedia needs a secure context — but localhost is exempt. */
export function secureContextOk() {
  if (window.isSecureContext === true) return true;
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

/**
 * Query a permission ('camera' | 'microphone'). Returns the browser state, or
 * 'unsupported' where the Permissions API can't answer (notably iOS Safari).
 */
export async function queryPermission(kind) {
  if (!navigator.permissions || !navigator.permissions.query) return 'unsupported';
  try {
    const res = await navigator.permissions.query({ name: /** @type any */ (kind) });
    return res.state; // 'granted' | 'prompt' | 'denied'
  } catch {
    return 'unsupported';
  }
}

/** Subscribe to permission changes; returns an unsubscribe fn. */
export async function watchPermission(kind, cb) {
  if (!navigator.permissions || !navigator.permissions.query) return () => {};
  try {
    const res = await navigator.permissions.query({ name: /** @type any */ (kind) });
    const handler = () => cb(res.state);
    res.addEventListener('change', handler);
    return () => res.removeEventListener('change', handler);
  } catch {
    return () => {};
  }
}

// Permission-hard failures should NOT be retried with looser constraints.
function isFatal(err) {
  const n = err && err.name;
  return (
    n === 'NotAllowedError' ||
    n === 'SecurityError' ||
    n === 'NotFoundError' ||
    n === 'DevicesNotFoundError'
  );
}

/**
 * Acquire a camera (+mic) stream with a 3-tier fallback ladder:
 *   1) ideal: requested device/facing + resolution + fps
 *   2) basic: just device/facing (drop resolution/fps)  — on OverconstrainedError
 *   3) bare:  { video: true }                            — last resort
 * Permission/not-found errors propagate immediately (no pointless retries).
 */
export async function acquireCamera(opts = {}) {
  const { deviceId, facingMode = 'user', resHeight = 720, fps = 30, audio = true } = opts;
  const env = opts.env || probeEnvironment();
  const audioC = audio
    ? { echoCancellation: !env.isIOS, noiseSuppression: !env.isIOS, autoGainControl: true }
    : false;
  const videoBase = deviceId ? { deviceId: { exact: deviceId } } : { facingMode };

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { ...videoBase, height: { ideal: resHeight }, frameRate: { ideal: fps } },
      audio: audioC,
    });
  } catch (e1) {
    if (isFatal(e1)) throw e1;
    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoBase, audio: audioC });
    } catch (e2) {
      if (isFatal(e2)) throw e2;
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: audioC });
    }
  }
}

/** Acquire a microphone-only stream (for mic switching). */
export async function acquireMic(opts = {}) {
  const { deviceId } = opts;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
  } catch (e) {
    if (isFatal(e)) throw e;
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
}

/** Map a getUserMedia error to an actionable, user-facing description. */
export function describeError(err, env = probeEnvironment()) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      code: 'denied',
      title: 'Camera / microphone blocked',
      detail: env.isMobile
        ? 'Access was denied. Enable camera & microphone for this site in your browser settings, then retry.'
        : 'Access was denied. Click the camera icon in the address bar, allow the camera & mic, then retry.',
      retry: 'settings',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      code: 'notfound',
      title: 'No camera or microphone found',
      detail: 'This device has no available camera/mic. Connect one and retry.',
      retry: 'refresh',
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      code: 'inuse',
      title: 'Camera / microphone in use',
      detail: 'Another app or tab (Zoom, FaceTime, another stream) is using the device. Close it and retry.',
      retry: 'refresh',
    };
  }
  if (name === 'OverconstrainedError') {
    return {
      code: 'constraints',
      title: 'Requested quality not supported',
      detail: "This device can't meet the requested resolution/FPS. Pick lower settings and retry.",
      retry: 'refresh',
    };
  }
  if (name === 'AbortError') {
    return { code: 'abort', title: 'Access interrupted', detail: 'Device access was interrupted. Retry.', retry: 'refresh' };
  }
  return {
    code: 'unknown',
    title: 'Could not access camera / mic',
    detail: (err && err.message) || 'Unknown error. Retry.',
    retry: 'refresh',
  };
}

/** Enumerate inputs. Labels are blank until permission has been granted once. */
export async function listDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return { cameras: [], mics: [], hasLabels: false };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  const mics = devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  const hasLabels = devices.some((d) => d.label);
  return { cameras, mics, hasLabels };
}

/** Fire cb whenever devices are added/removed; returns an unsubscribe fn. */
export function watchDevices(cb) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return () => {};
  navigator.mediaDevices.addEventListener('devicechange', cb);
  return () => navigator.mediaDevices.removeEventListener('devicechange', cb);
}

export function stopStream(stream) {
  if (stream) {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* already stopped */
      }
    });
  }
}
