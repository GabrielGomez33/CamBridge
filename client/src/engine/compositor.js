// Always-canvas camera compositor — the WYSIWYS engine.
//
// The camera feeds a hidden <video>; every frame is drawn to a <canvas> with the
// current adjustments (brightness/contrast/saturation, mirror, aspect/crop,
// zoom). The OUTGOING video track is `canvas.captureStream()`, so what the
// operator sees is exactly what streams — and switching camera / aspect /
// resolution changes only what we draw, never the track identity (no WebRTC
// renegotiation). Audio bypasses the canvas entirely.

import { acquireCamera, acquireMic, listDevices } from './media.js';
import { primeAudioSession, keepMicAlive, releaseMicSink } from './audioSession.js';

const ASPECTS = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
};

export class Compositor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{direct?: boolean, previewVideo?: HTMLVideoElement}} [opts]
   *   direct = iOS standalone PWA path: send the RAW getUserMedia tracks
   *   (no canvas.captureStream), previewed in a VISIBLE <video>. Standalone
   *   WebKit delivers hidden/off-screen capture as black frames + muted audio
   *   (WebKit #252465) and is flaky with canvas.captureStream — so on-screen
   *   raw capture is the reliable path there.
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.direct = !!opts.direct;
    this.ctx = canvas ? canvas.getContext('2d', { alpha: false, desynchronized: true }) : null;

    if (this.direct && opts.previewVideo) {
      // Use the caller's VISIBLE on-screen <video> as both preview and source.
      this.video = opts.previewVideo;
      this._ownsVideo = false;
    } else {
      // Canvas mode: a hidden source <video> feeding the compositor. Must be
      // attached to the DOM (not display:none) or standalone WebKit won't
      // decode it (videoWidth stays 0 → black canvas). Kept visually hidden.
      this.video = document.createElement('video');
      this.video.style.cssText =
        'position:fixed;top:0;left:0;width:1px;height:1px;min-width:1px;opacity:0.01;' +
        'pointer-events:none;z-index:-1;transform:translateY(-100%);';
      if (typeof document !== 'undefined' && document.body) {
        document.body.appendChild(this.video);
      }
      this._ownsVideo = true;
    }
    this.video.muted = true;
    this.video.defaultMuted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    // Belt-and-suspenders for older/stricter WebKit (attributes, not just props).
    this.video.setAttribute('muted', '');
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.setAttribute('autoplay', '');
    // iOS occasionally needs a nudge to actually start pushing frames once the
    // stream is attached — re-issue play() as the video becomes ready.
    const kick = () => this.video.play().catch(() => {});
    this.video.addEventListener('loadedmetadata', kick);
    this.video.addEventListener('canplay', kick);

    this.camStream = null; // raw getUserMedia stream
    this.outputStream = null; // canvas video + mic audio
    this._rafId = 0;
    this._running = false;
    this._frames = 0; // drawn-frame counter (diagnostics)
    this._lastErr = ''; // last non-fatal pipeline error (diagnostics)

    this.settings = {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      mirror: false,
      aspect: '16:9',
      zoom: 1, // canvas crop-zoom (universal)
      fps: 30,
      resHeight: 720, // short edge target
    };
    this._deviceId = null;
  }

  /**
   * Start capture. Resolves once the first frame is drawable. Acquisition runs
   * through the robust media layer (fallback ladder + typed errors). MUST be the
   * first awaited call in a user-gesture handler (iOS gesture preservation).
   */
  async start(opts = {}) {
    Object.assign(this.settings, opts);
    // Activate the iOS audio session synchronously, still inside the user
    // gesture (before the getUserMedia await) — else standalone WebKit may hand
    // back a suspended/silent mic track.
    primeAudioSession();
    this.camStream = await acquireCamera({
      deviceId: opts.deviceId,
      facingMode: opts.facingMode || 'user',
      resHeight: this.settings.resHeight,
      fps: this.settings.fps,
      audio: opts.audio !== false,
    });
    this._deviceId = this._currentVideoSettings()?.deviceId || null;

    this.video.srcObject = this.camStream;
    await this.video.play().catch((e) => {
      this._lastErr = 'play: ' + (e?.name || e);
    });

    const audio = this.camStream.getAudioTracks()[0];
    // Keep the mic session alive on iOS standalone (silent tap, no echo).
    if (audio) keepMicAlive(this.camStream);

    if (this.direct) {
      // Direct mode: the RAW camera + mic tracks ARE the outgoing stream. No
      // canvas, no draw loop — the visible <video> is the local preview.
      this.outputStream = this.camStream;
      this._running = true;
      return this.outputStream;
    }

    this._resizeCanvas();
    // Build the output stream: canvas video + the (untouched) mic track.
    const canvasStream = this.canvas.captureStream(this.settings.fps);
    const tracks = [canvasStream.getVideoTracks()[0]];
    if (audio) tracks.push(audio);
    this.outputStream = new MediaStream(tracks);

    this._startLoop();
    return this.outputStream;
  }

  _videoConstraints(deviceId, facingMode) {
    const ideal = { height: { ideal: this.settings.resHeight } };
    if (deviceId) return { deviceId: { exact: deviceId }, ...ideal };
    return { facingMode, ...ideal };
  }

  _currentVideoSettings() {
    const t = this.camStream && this.camStream.getVideoTracks()[0];
    return t ? t.getSettings() : null;
  }

  _resizeCanvas() {
    if (!this.canvas) return; // direct mode has no compositing canvas
    // Build the target frame around the configured short-edge resolution so
    // 720p means 1280x720 landscape or 720x1280 portrait, etc.
    const ar = ASPECTS[this.settings.aspect] || 16 / 9;
    const edge = this.settings.resHeight;
    if (ar >= 1) {
      this.canvas.height = edge;
      this.canvas.width = Math.round(edge * ar);
    } else {
      this.canvas.width = edge;
      this.canvas.height = Math.round(edge / ar);
    }
  }

  _startLoop() {
    if (this._running) return;
    this._running = true;
    // Use requestAnimationFrame, NOT requestVideoFrameCallback. rVFC is
    // throttled — and in the iOS home-screen PWA context effectively never
    // fires — for a hidden / off-screen <video>, which stalls the draw loop
    // after the first frame (black canvas, black captured stream). rAF is
    // driven by the visible page, so it keeps ticking; drawImage reads the
    // decoded frame from the hidden source regardless of its CSS visibility.
    const draw = () => {
      if (!this._running) return;
      this._drawFrame();
      this._rafId = requestAnimationFrame(draw);
    };
    this._rafId = requestAnimationFrame(draw);
  }

  _drawFrame() {
    const { ctx, canvas, video, settings } = this;
    if (!video.videoWidth) return;
    this._frames++;
    const W = canvas.width;
    const H = canvas.height;

    // Cover-fit the source into the target frame, with crop-zoom.
    const scale = Math.max(W / video.videoWidth, H / video.videoHeight) * settings.zoom;
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;

    ctx.save();
    ctx.filter = `brightness(${settings.brightness}) contrast(${settings.contrast}) saturate(${settings.saturation})`;
    if (settings.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();
  }

  // ── live adjustments (reflected in-stream instantly, no renegotiation) ──────
  setAdjustment(name, value) {
    if (name in this.settings) this.settings[name] = value;
  }
  setMirror(on) {
    this.settings.mirror = !!on;
  }
  setZoom(z) {
    this.settings.zoom = Math.max(1, Math.min(z, 5));
  }
  setAspect(aspect) {
    if (ASPECTS[aspect]) {
      this.settings.aspect = aspect;
      this._resizeCanvas();
    }
  }

  // ── cameras ────────────────────────────────────────────────────────────────
  async listCameras() {
    return (await listDevices()).cameras;
  }

  /**
   * Switch source camera.
   * - Canvas mode: the output canvas track is unchanged → no renegotiation.
   * - Direct mode: the camera track IS the outgoing track, so this returns the
   *   new video track for the caller to replaceTrack() on the RTP senders.
   * @returns {Promise<MediaStreamTrack|null>} new video track in direct mode
   */
  async switchCamera(deviceId) {
    const audio = this.camStream?.getAudioTracks()[0] || null;
    const newStream = await acquireCamera({
      deviceId,
      resHeight: this.settings.resHeight,
      fps: this.settings.fps,
      audio: false,
    });
    // Stop the old video track, keep audio.
    this.camStream?.getVideoTracks().forEach((t) => t.stop());
    const newVideo = newStream.getVideoTracks()[0];
    const combined = new MediaStream([newVideo]);
    if (audio) combined.addTrack(audio);
    this.camStream = combined;
    this._deviceId = deviceId;
    this.video.srcObject = this.camStream;
    await this.video.play().catch(() => {});
    if (this.direct) {
      this.outputStream = this.camStream;
      return newVideo; // caller: rtc.replaceVideoTrack(newVideo)
    }
    this._resizeCanvas();
    return null;
  }

  // ── native hardware controls (where the device supports them) ───────────────
  videoCapabilities() {
    const t = this.camStream?.getVideoTracks()[0];
    return t && t.getCapabilities ? t.getCapabilities() : {};
  }

  async applyNative(constraint) {
    const t = this.camStream?.getVideoTracks()[0];
    if (!t) return false;
    try {
      await t.applyConstraints({ advanced: [constraint] });
      return true;
    } catch {
      return false;
    }
  }
  async setTorch(on) {
    return this.applyNative({ torch: !!on });
  }
  async setNativeZoom(value) {
    return this.applyNative({ zoom: value });
  }

  // ── audio ────────────────────────────────────────────────────────────────
  /** Switch mic; returns the new audio track so RTC can replaceTrack it. */
  async switchMic(deviceId) {
    const s = await acquireMic({ deviceId });
    const newAudio = s.getAudioTracks()[0];
    const old = this.camStream?.getAudioTracks()[0];
    if (old) {
      this.camStream.removeTrack(old);
      old.stop();
    }
    this.camStream?.addTrack(newAudio);
    // Reflect in the output stream too.
    const outOld = this.outputStream?.getAudioTracks()[0];
    if (outOld) this.outputStream.removeTrack(outOld);
    this.outputStream?.addTrack(newAudio);
    // Rebuild the iOS keep-alive tap around the new mic.
    if (this.camStream) keepMicAlive(this.camStream);
    return newAudio;
  }
  setMuted(muted) {
    this.camStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  /**
   * Re-acquire capture if iOS muted/ended the tracks after the app was
   * backgrounded (WebKit #212040 — standalone PWA silences tracks on
   * background/route change). Returns the fresh { video, audio } tracks so the
   * caller can replaceTrack() on the senders, or null if nothing was wrong.
   */
  async recover() {
    const v = this.camStream?.getVideoTracks()[0];
    const broken = !v || v.readyState === 'ended' || v.muted;
    if (!broken) return null;
    let fresh;
    try {
      fresh = await acquireCamera({
        deviceId: this._deviceId || undefined,
        resHeight: this.settings.resHeight,
        fps: this.settings.fps,
        audio: true,
      });
    } catch (e) {
      this._lastErr = 'recover: ' + (e?.name || e);
      return null;
    }
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.camStream = fresh;
    this.video.srcObject = this.camStream;
    await this.video.play().catch(() => {});
    if (this.direct) this.outputStream = this.camStream;
    keepMicAlive(this.camStream);
    return { video: fresh.getVideoTracks()[0] || null, audio: fresh.getAudioTracks()[0] || null };
  }

  /** Live pipeline state for the on-screen debug overlay (?debug=1). */
  diagnostics() {
    const v = this.video;
    const outV = this.outputStream?.getVideoTracks()[0];
    const outA = this.outputStream?.getAudioTracks()[0];
    const camV = this.camStream?.getVideoTracks()[0];
    const camA = this.camStream?.getAudioTracks()[0];
    const t = (tr) => (tr ? `${tr.readyState}${tr.muted ? '/muted' : ''}${tr.enabled ? '' : '/off'}` : '—');
    return {
      mode: this.direct ? 'direct' : 'canvas',
      running: this._running,
      frames: this._frames,
      videoWH: `${v.videoWidth}x${v.videoHeight}`,
      videoReady: v.readyState,
      videoPaused: v.paused,
      inDom: !!v.isConnected,
      canvasWH: this.canvas ? `${this.canvas.width}x${this.canvas.height}` : 'n/a',
      camVideo: t(camV),
      camAudio: t(camA),
      outVideo: t(outV),
      outAudio: t(outA),
      lastErr: this._lastErr,
    };
  }

  stop() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    releaseMicSink();
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.outputStream?.getTracks().forEach((t) => t.stop());
    // Clear the source video. Only remove it if WE created it (canvas mode) —
    // in direct mode the <video> is owned by the caller's React tree.
    try {
      this.video.pause();
      this.video.srcObject = null;
      if (this._ownsVideo) this.video.remove();
    } catch {
      /* noop */
    }
  }
}

export const ASPECT_RATIOS = Object.keys(ASPECTS);
