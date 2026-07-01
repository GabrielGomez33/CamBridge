// Always-canvas camera compositor — the WYSIWYS engine.
//
// The camera feeds a hidden <video>; every frame is drawn to a <canvas> with the
// current adjustments (brightness/contrast/saturation, mirror, aspect/crop,
// zoom). The OUTGOING video track is `canvas.captureStream()`, so what the
// operator sees is exactly what streams — and switching camera / aspect /
// resolution changes only what we draw, never the track identity (no WebRTC
// renegotiation). Audio bypasses the canvas entirely.

const ASPECTS = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
};

export class Compositor {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;

    this.camStream = null; // raw getUserMedia stream
    this.outputStream = null; // canvas video + mic audio
    this._rafId = 0;
    this._running = false;

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

  /** Start capture. Resolves once the first frame is drawable. */
  async start(opts = {}) {
    Object.assign(this.settings, opts);
    const constraints = {
      video: this._videoConstraints(opts.deviceId, opts.facingMode || 'user'),
      audio:
        opts.audio === false
          ? false
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    };
    this.camStream = await navigator.mediaDevices.getUserMedia(constraints);
    this._deviceId = this._currentVideoSettings()?.deviceId || null;

    this.video.srcObject = this.camStream;
    await this.video.play().catch(() => {});
    this._resizeCanvas();

    // Build the output stream: canvas video + the (untouched) mic track.
    const canvasStream = this.canvas.captureStream(this.settings.fps);
    const tracks = [canvasStream.getVideoTracks()[0]];
    const audio = this.camStream.getAudioTracks()[0];
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
    const draw = () => {
      if (!this._running) return;
      this._drawFrame();
      // Prefer requestVideoFrameCallback (battery-friendly, real frames).
      if (this.video.requestVideoFrameCallback) {
        this._rafId = this.video.requestVideoFrameCallback(draw);
      } else {
        this._rafId = requestAnimationFrame(draw);
      }
    };
    draw();
  }

  _drawFrame() {
    const { ctx, canvas, video, settings } = this;
    if (!video.videoWidth) return;
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
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /** Switch source camera. Output canvas track is unchanged → no renegotiation. */
  async switchCamera(deviceId) {
    const audio = this.camStream?.getAudioTracks()[0] || null;
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: this._videoConstraints(deviceId, undefined),
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
    this._resizeCanvas();
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
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined },
      video: false,
    });
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
    return newAudio;
  }
  setMuted(muted) {
    this.camStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  stop() {
    this._running = false;
    if (this._rafId && !this.video.requestVideoFrameCallback) cancelAnimationFrame(this._rafId);
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.outputStream?.getTracks().forEach((t) => t.stop());
  }
}

export const ASPECT_RATIOS = Object.keys(ASPECTS);
