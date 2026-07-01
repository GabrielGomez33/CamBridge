// Poll RTCPeerConnection.getStats() into a simple metrics object, ~1Hz.
// Works for a broadcaster (outbound-rtp) or a viewer (inbound-rtp).

export function startStats(getPc, cb, interval = 1000) {
  let lastBytes = 0;
  let lastTs = 0;

  const id = setInterval(async () => {
    const pc = typeof getPc === 'function' ? getPc() : getPc;
    if (!pc || pc.connectionState === 'closed') {
      cb(null);
      return;
    }
    let report;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }

    let bitrate = 0;
    let fps = 0;
    let rtt = 0;
    let loss = 0;
    let res = '';

    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        if (lastTs) {
          const dt = (s.timestamp - lastTs) / 1000;
          if (dt > 0) bitrate = Math.round((8 * (s.bytesSent - lastBytes)) / dt);
        }
        lastBytes = s.bytesSent;
        lastTs = s.timestamp;
        fps = Math.round(s.framesPerSecond || 0);
        if (s.frameWidth) res = `${s.frameWidth}x${s.frameHeight}`;
      } else if (s.type === 'inbound-rtp' && s.kind === 'video') {
        if (lastTs) {
          const dt = (s.timestamp - lastTs) / 1000;
          if (dt > 0) bitrate = Math.round((8 * (s.bytesReceived - lastBytes)) / dt);
        }
        lastBytes = s.bytesReceived;
        lastTs = s.timestamp;
        fps = Math.round(s.framesPerSecond || 0);
        if (s.frameWidth) res = `${s.frameWidth}x${s.frameHeight}`;
        if (s.packetsLost != null && s.packetsReceived)
          loss = +((100 * s.packetsLost) / (s.packetsLost + s.packetsReceived)).toFixed(1);
      } else if (s.type === 'remote-inbound-rtp' && s.kind === 'video') {
        rtt = Math.round((s.roundTripTime || 0) * 1000);
        if (s.fractionLost != null) loss = +(s.fractionLost * 100).toFixed(1);
      }
    });

    cb({ bitrate, fps, rtt, loss, res });
  }, interval);

  return () => clearInterval(id);
}

/** Human-friendly bitrate. */
export function fmtBitrate(bps) {
  if (!bps) return '0 kbps';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/**
 * Read one broadcaster→viewer connection: throughput + the ACTIVE ICE candidate
 * pair, so we can tell direct P2P from a TURN relay. `last` is a per-peer
 * {bytes, ts} carried across calls for the bitrate delta.
 */
async function readPeer(pc, last) {
  const m = {
    bitrate: 0,
    fps: 0,
    res: '',
    rtt: 0,
    loss: 0,
    connType: 'unknown', // 'direct' | 'relay' | 'unknown'
    localType: '', // host | srflx | prflx | relay
    remoteType: '',
    protocol: '', // udp | tcp
    state: pc.connectionState,
  };
  let report;
  try {
    report = await pc.getStats();
  } catch {
    return { m, last };
  }

  const all = new Map();
  report.forEach((s) => all.set(s.id, s));

  let next = last;
  for (const s of all.values()) {
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      // Sending side (broadcaster).
      if (last && last.ts) {
        const dt = (s.timestamp - last.ts) / 1000;
        if (dt > 0) m.bitrate = Math.round((8 * (s.bytesSent - last.bytes)) / dt);
      }
      next = { bytes: s.bytesSent, ts: s.timestamp };
      m.fps = Math.round(s.framesPerSecond || 0);
      if (s.frameWidth) m.res = `${s.frameWidth}x${s.frameHeight}`;
    } else if (s.type === 'inbound-rtp' && s.kind === 'video') {
      // Receiving side (viewer / OBS).
      if (last && last.ts) {
        const dt = (s.timestamp - last.ts) / 1000;
        if (dt > 0) m.bitrate = Math.round((8 * (s.bytesReceived - last.bytes)) / dt);
      }
      next = { bytes: s.bytesReceived, ts: s.timestamp };
      m.fps = Math.round(s.framesPerSecond || 0);
      if (s.frameWidth) m.res = `${s.frameWidth}x${s.frameHeight}`;
      if (s.packetsLost != null && s.packetsReceived)
        m.loss = +((100 * s.packetsLost) / (s.packetsLost + s.packetsReceived)).toFixed(1);
    } else if (s.type === 'remote-inbound-rtp' && s.kind === 'video') {
      m.rtt = Math.round((s.roundTripTime || 0) * 1000);
      if (s.fractionLost != null) m.loss = +(s.fractionLost * 100).toFixed(1);
    }
  }

  // Resolve the selected candidate pair (prefer transport's pointer).
  let pairId = null;
  for (const s of all.values()) {
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      pairId = s.selectedCandidatePairId;
      break;
    }
  }
  if (!pairId) {
    for (const s of all.values()) {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        pairId = s.id;
        break;
      }
    }
  }
  const pair = pairId ? all.get(pairId) : null;
  if (pair) {
    const local = all.get(pair.localCandidateId);
    const remote = all.get(pair.remoteCandidateId);
    m.localType = (local && local.candidateType) || '';
    m.remoteType = (remote && remote.candidateType) || '';
    m.protocol = (local && local.protocol) || pair.protocol || '';
    if (m.localType === 'relay' || m.remoteType === 'relay') m.connType = 'relay';
    else if (m.localType || m.remoteType) m.connType = 'direct';
    // Viewer side has no remote-inbound-rtp RTT — fall back to the pair's RTT.
    if (!m.rtt && pair.currentRoundTripTime != null) m.rtt = Math.round(pair.currentRoundTripTime * 1000);
  }

  return { m, last: next };
}

/**
 * Poll EVERY broadcaster→viewer connection ~1Hz. `getPeers` returns the
 * BroadcasterRtc.peers Map (peerId -> {pc}). Calls cb with an array of per-peer
 * metrics (including connType so the UI can show P2P vs TURN).
 */
export function startPeerStats(getPeers, cb, interval = 1000) {
  const last = new Map(); // peerId -> {bytes, ts}
  const id = setInterval(async () => {
    const peers = (typeof getPeers === 'function' ? getPeers() : getPeers) || new Map();
    const out = [];
    for (const [peerId, entry] of peers) {
      const pc = entry && entry.pc;
      if (!pc) continue;
      const { m, last: nl } = await readPeer(pc, last.get(peerId));
      last.set(peerId, nl);
      out.push({ peerId, ...m });
    }
    // Drop bookkeeping for peers that went away.
    for (const key of [...last.keys()]) if (!peers.has(key)) last.delete(key);
    cb(out);
  }, interval);
  return () => clearInterval(id);
}

/** Short human label for a connection's path. */
export function connLabel(m) {
  if (!m || m.connType === 'unknown') return 'connecting…';
  if (m.connType === 'relay') return 'TURN · relay';
  const stun = m.localType === 'srflx' || m.remoteType === 'srflx';
  const lan = m.localType === 'host' && m.remoteType === 'host';
  return lan ? 'P2P · direct (LAN)' : `P2P · direct${stun ? ' (STUN)' : ''}`;
}
