import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SignalingClient } from '../engine/signaling.js';
import { ViewerRtc } from '../engine/rtc.js';
import { startPeerStats, fmtBitrate, connLabel } from '../engine/stats.js';

// OBS-facing viewer. Plays the incoming stream fullscreen and shows a clean
// standby card whenever there's no live signal, so OBS never shows a frozen
// frame. Add ?bg=transparent for a transparent OBS background.
export default function Viewer() {
  const [params] = useSearchParams();
  const sessionId = params.get('s');
  const passcode = params.get('p');
  const transparent = params.get('bg') === 'transparent';
  const controlView = params.get('controlView') === '1';

  const videoRef = useRef<HTMLVideoElement>(null);
  const [standby, setStandby] = useState<{ title: string; sub: string } | null>({
    title: 'Connecting',
    sub: 'CAMBRIDGE // VIEWER',
  });
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    const video = videoRef.current!;
    if (!sessionId || !passcode) {
      setStandby({ title: 'Invalid link', sub: 'Missing session or passcode' });
      return;
    }

    const signaling = new SignalingClient();
    const rtc = new ViewerRtc(signaling, video);
    const join = () => signaling.join(sessionId, passcode, 'viewer');

    signaling.addEventListener('open', join);
    signaling.addEventListener('reconnected', join);
    signaling.addEventListener('msg:joined', (e: any) => {
      rtc.setIceServers(e.detail.iceServers);
      setStandby({ title: 'Connecting', sub: 'CAMBRIDGE // VIEWER' });
    });
    signaling.addEventListener('msg:error', (e: any) => {
      const code = e.detail.code;
      if (code === 'bad_passcode') setStandby({ title: 'Access denied', sub: 'Incorrect passcode' });
      else if (code === 'no_session')
        setStandby({ title: 'Stream not found', sub: 'Link expired or invalid' });
      else setStandby({ title: 'Signal error', sub: e.detail.message || '' });
    });

    rtc.onTrack = () => {
      setStandby(null);
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
    };
    rtc.onGone = () => setStandby({ title: 'Signal lost', sub: 'Reconnecting…' });

    // Optional telemetry overlay (?controlView=1) — poll the single connection.
    let stopStats: null | (() => void) = null;
    if (controlView) {
      stopStats = startPeerStats(
        () => (rtc.pc ? new Map([['broadcaster', { pc: rtc.pc }]]) : new Map()),
        (arr: any[]) => setStats(arr[0] || null)
      );
    }

    signaling.connect();
    return () => {
      signaling.close();
      stopStats?.();
    };
  }, [sessionId, passcode, controlView]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: transparent ? 'transparent' : '#000' }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: transparent ? 'transparent' : '#000',
        }}
      />
      {controlView && stats && (
        <div className="hud" style={{ position: 'fixed' }}>
          <span>{fmtBitrate(stats.bitrate)}</span>
          <span>FPS <b>{stats.fps}</b></span>
          {stats.res && <span>{stats.res}</span>}
          <span>RTT <b>{stats.rtt}ms</b></span>
          <span>LOSS <b>{stats.loss}%</b></span>
          <span style={{ color: stats.connType === 'relay' ? 'var(--warn)' : 'var(--accent)' }}>
            {connLabel(stats)}
          </span>
        </div>
      )}
      {standby && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: 'var(--bg)',
            textAlign: 'center',
          }}
        >
          <div className="pulse" />
          <div
            style={{
              fontSize: 13,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--text)',
            }}
          >
            {standby.title}
          </div>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--muted)' }}>
            {standby.sub}
          </div>
        </div>
      )}
    </div>
  );
}
