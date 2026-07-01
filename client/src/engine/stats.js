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
