// WebRTC peer management for CamBridge's 1-broadcaster → N-viewer model.
// The broadcaster is always the OFFERER and holds one RTCPeerConnection per
// viewer (normally just OBS). The viewer answers. Because the outgoing video is
// the canvas captureStream track, camera/aspect/resolution changes never need
// renegotiation — only audio swaps use replaceTrack.

export class BroadcasterRtc {
  /**
   * @param {import('./signaling.js').SignalingClient} signaling
   */
  constructor(signaling, opts = {}) {
    this.signaling = signaling;
    this.iceServers = [];
    this.forceRelay = !!opts.forceRelay; // ?relay=1 → verify TURN (relay-only)
    this.stream = null; // MediaStream (canvas video + mic audio)
    this.maxBitrate = 0; // 0 = unlimited
    /** @type {Map<string, {pc: RTCPeerConnection, videoSender: RTCRtpSender|null, audioSender: RTCRtpSender|null}>} */
    this.peers = new Map();
    this.onPeerCount = null; // (n) => void

    signaling.addEventListener('msg:viewer-joined', (e) => this._addViewer(e.detail.peerId));
    signaling.addEventListener('msg:viewer-left', (e) => this._removeViewer(e.detail.peerId));
    signaling.addEventListener('msg:answer', (e) => this._onAnswer(e.detail));
    signaling.addEventListener('msg:candidate', (e) => this._onCandidate(e.detail));
  }

  setIceServers(servers) {
    this.iceServers = servers || [];
  }

  /** Set/replace the outgoing stream. Safe to call before any viewer connects. */
  setStream(stream) {
    this.stream = stream;
  }

  /** Swap the mic without renegotiation across every active peer. */
  async replaceAudioTrack(track) {
    for (const { audioSender } of this.peers.values()) {
      if (audioSender) await audioSender.replaceTrack(track);
    }
  }

  /** Cap encode bitrate (bps) on every peer — critical on cellular. */
  async setMaxBitrate(bps) {
    this.maxBitrate = bps;
    for (const { videoSender } of this.peers.values()) {
      if (videoSender) await this._applyBitrate(videoSender);
    }
  }

  async _applyBitrate(sender) {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    if (this.maxBitrate > 0) params.encodings[0].maxBitrate = this.maxBitrate;
    else delete params.encodings[0].maxBitrate;
    try {
      await sender.setParameters(params);
    } catch {
      /* some browsers reject mid-flight param changes; ignore */
    }
  }

  async _addViewer(viewerId) {
    if (this.peers.has(viewerId) || !this.stream) return;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(this.forceRelay ? { iceTransportPolicy: 'relay' } : {}),
    });
    const entry = { pc, videoSender: null, audioSender: null };
    this.peers.set(viewerId, entry);

    for (const track of this.stream.getTracks()) {
      const sender = pc.addTrack(track, this.stream);
      if (track.kind === 'video') entry.videoSender = sender;
      else entry.audioSender = sender;
    }
    if (entry.videoSender) await this._applyBitrate(entry.videoSender);

    pc.onicecandidate = (e) =>
      this.signaling.send({ type: 'candidate', target: viewerId, candidate: e.candidate });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try {
          pc.restartIce();
        } catch {
          /* noop */
        }
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send({ type: 'offer', target: viewerId, sdp: pc.localDescription });
    } catch {
      this._removeViewer(viewerId);
    }
    this._emitCount();
  }

  async _onAnswer({ from, sdp }) {
    const entry = this.peers.get(from);
    if (entry) await entry.pc.setRemoteDescription(sdp).catch(() => {});
  }

  async _onCandidate({ from, candidate }) {
    const entry = this.peers.get(from);
    if (entry && candidate) await entry.pc.addIceCandidate(candidate).catch(() => {});
  }

  _removeViewer(viewerId) {
    const entry = this.peers.get(viewerId);
    if (entry) {
      try {
        entry.pc.close();
      } catch {
        /* noop */
      }
      this.peers.delete(viewerId);
      this._emitCount();
    }
  }

  _emitCount() {
    if (this.onPeerCount) this.onPeerCount(this.peers.size);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this._removeViewer(id);
  }
}

export class ViewerRtc {
  /**
   * @param {import('./signaling.js').SignalingClient} signaling
   * @param {HTMLVideoElement} videoEl
   */
  constructor(signaling, videoEl, opts = {}) {
    this.signaling = signaling;
    this.videoEl = videoEl;
    this.iceServers = [];
    this.forceRelay = !!opts.forceRelay; // ?relay=1 → verify TURN (relay-only)
    this.pc = null;
    this.broadcasterId = null;
    this.onTrack = null; // () => void  (first media arrived)
    this.onGone = null; // () => void

    signaling.addEventListener('msg:offer', (e) => this._onOffer(e.detail));
    signaling.addEventListener('msg:candidate', (e) => this._onCandidate(e.detail));
    signaling.addEventListener('msg:broadcaster-gone', () => this._onGone());
  }

  setIceServers(servers) {
    this.iceServers = servers || [];
  }

  async _onOffer({ from, sdp }) {
    this._teardown();
    this.broadcasterId = from;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(this.forceRelay ? { iceTransportPolicy: 'relay' } : {}),
    });
    this.pc = pc;

    pc.ontrack = (e) => {
      if (this.videoEl.srcObject !== e.streams[0]) {
        this.videoEl.srcObject = e.streams[0];
        if (this.onTrack) this.onTrack();
      }
    };
    pc.onicecandidate = (e) =>
      this.signaling.send({ type: 'candidate', target: from, candidate: e.candidate });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try {
          pc.restartIce();
        } catch {
          /* noop */
        }
      }
    };

    try {
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send({ type: 'answer', target: from, sdp: pc.localDescription });
    } catch {
      this._teardown();
    }
  }

  async _onCandidate({ from, candidate }) {
    if (this.pc && from === this.broadcasterId && candidate) {
      await this.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  _onGone() {
    this._teardown();
    if (this.onGone) this.onGone();
  }

  _teardown() {
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* noop */
      }
      this.pc = null;
    }
    this.broadcasterId = null;
  }
}
