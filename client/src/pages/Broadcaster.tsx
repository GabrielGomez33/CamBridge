import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Compositor, ASPECT_RATIOS } from '../engine/compositor.js';
import { SignalingClient } from '../engine/signaling.js';
import { BroadcasterRtc } from '../engine/rtc.js';
import { startPeerStats, fmtBitrate, connLabel } from '../engine/stats.js';
import { apiBase, pageBase } from '../engine/base.js';
import { secureContextOk, describeError, listDevices, watchDevices } from '../engine/media.js';

type Device = { deviceId: string; label: string };
type Metrics =
  | {
      bitrate: number;
      fps: number;
      res: string;
      rtt: number;
      loss: number;
      connType?: string;
      localType?: string;
      remoteType?: string;
      protocol?: string;
    }
  | null;

export default function Broadcaster() {
  const [params, setParams] = useSearchParams();
  const [sessionId, setSessionId] = useState(params.get('s') || '');
  const [passcode, setPasscode] = useState(params.get('p') || '');
  const [view, setView] = useState<'create' | 'studio'>(
    params.get('s') && params.get('p') ? 'studio' : 'create'
  );

  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [obsLink, setObsLink] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [emailStatus, setEmailStatus] = useState<string>(''); // '' | sending | sent | <error>


  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<{ text: string; level: string }>({ text: 'Idle', level: 'warn' });
  const [mediaError, setMediaError] = useState<{ title: string; detail: string } | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(null);
  const [peerStats, setPeerStats] = useState<any[]>([]);
  const [viewers, setViewers] = useState(0);
  const controlView = params.get('controlView') === '1';
  const [paused, setPaused] = useState(false);

  const [cameras, setCameras] = useState<Device[]>([]);
  const [mics, setMics] = useState<Device[]>([]);
  const [mirror, setMirror] = useState(false);
  const [aspect, setAspect] = useState('16:9');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [adj, setAdj] = useState({ brightness: 100, contrast: 100, saturation: 100, zoom: 100 });
  const [res, setRes] = useState(720);
  const [fps, setFps] = useState(30);
  const [bitrate, setBitrate] = useState(1500000);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const comp = useRef<any>(null);
  const sig = useRef<any>(null);
  const rtc = useRef<any>(null);
  const stopStats = useRef<null | (() => void)>(null);
  const wakeLock = useRef<any>(null);

  // Build/refresh the OBS viewer link whenever we have a session.
  useEffect(() => {
    if (sessionId && passcode) {
      setObsLink(
        `${location.origin}${pageBase()}/viewer?s=${encodeURIComponent(sessionId)}&p=${encodeURIComponent(passcode)}`
      );
    }
  }, [sessionId, passcode]);

  async function createLink() {
    setCreating(true);
    try {
      const r = await fetch(`${apiBase()}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!r.ok) throw new Error('create failed');
      const d = await r.json();
      setSessionId(d.sessionId);
      setPasscode(d.passcode);
      setParams({ s: d.sessionId, p: d.passcode }, { replace: true });
      if (d.viewerUrl) setObsLink(d.viewerUrl);
      setView('studio');
    } catch {
      alert('Could not create a link. Is the server running?');
    } finally {
      setCreating(false);
    }
  }

  async function goLive() {
    if (live) return stopLive();
    setMediaError(null);

    // Pre-flight: getUserMedia needs a secure context (HTTPS / localhost).
    if (!secureContextOk()) {
      setMediaError({
        title: 'Secure connection required',
        detail: 'Camera & microphone need HTTPS. Open this page over https:// and retry.',
      });
      setStatus({ text: 'Insecure context', level: 'danger' });
      return;
    }

    // 1) Acquire the camera. `start()`'s first await IS getUserMedia, so the
    //    user-gesture context is preserved (critical on iOS/Safari).
    setStatus({ text: 'Requesting camera & mic', level: 'warn' });
    try {
      comp.current = new Compositor(canvasRef.current);
      await comp.current.start({ resHeight: res, fps });
      comp.current.setMirror(mirror);
      comp.current.setAspect(aspect);
      await populateDevices();
      refreshTorch();
    } catch (err) {
      const d = describeError(err);
      setMediaError({ title: d.title, detail: d.detail });
      setStatus({ text: d.title, level: 'danger' });
      comp.current?.stop();
      comp.current = null;
      return;
    }

    // 2) Connect WebRTC (the output stream is already built from the canvas).
    sig.current = new SignalingClient();
    rtc.current = new BroadcasterRtc(sig.current, { forceRelay: params.get('relay') === '1' });
    rtc.current.setStream(comp.current.outputStream);
    rtc.current.onPeerCount = (n: number) => setViewers(n);

    const join = () => sig.current.join(sessionId, passcode, 'broadcaster');
    sig.current.addEventListener('open', join);
    sig.current.addEventListener('reconnected', join);
    sig.current.addEventListener('msg:joined', (e: any) => {
      rtc.current.setIceServers(e.detail.iceServers);
      rtc.current.setMaxBitrate(bitrate);
      setStatus({ text: e.detail.turnEnabled ? 'Live · TURN ready' : 'Live', level: 'success' });
    });
    sig.current.addEventListener('msg:error', (e: any) => {
      setStatus({ text: e.detail.message || 'Signal error', level: 'danger' });
    });
    sig.current.connect();

    setLive(true);
    await acquireWakeLock();
    stopStats.current = startPeerStats(
      () => rtc.current?.peers,
      (arr: any[]) => {
        setPeerStats(arr);
        const primary = arr[0] || null;
        setMetrics(primary);
        if (primary) sig.current?.send({ type: 'stats', metrics: primary });
      }
    );
  }

  function stopLive() {
    setLive(false);
    stopStats.current?.();
    rtc.current?.closeAll();
    sig.current?.close();
    comp.current?.stop();
    releaseWakeLock();
    setStatus({ text: 'Idle', level: 'warn' });
    setMetrics(null);
    setPeerStats([]);
  }

  async function populateDevices() {
    const { cameras: cams, mics: ms } = await listDevices();
    setCameras(cams);
    setMics(ms);
  }

  // Live-refresh device lists when a camera/mic is plugged in or removed.
  useEffect(() => {
    return watchDevices(() => {
      if (comp.current) populateDevices();
    });
  }, []);

  function refreshTorch() {
    setTorchSupported('torch' in (comp.current?.videoCapabilities() || {}));
  }

  // ── control handlers ────────────────────────────────────────────────────────
  const setAdjustment = (name: keyof typeof adj, pct: number) => {
    setAdj((a) => ({ ...a, [name]: pct }));
    if (name === 'zoom') comp.current?.setZoom(pct / 100);
    else comp.current?.setAdjustment(name, pct / 100);
  };
  const toggleMirror = () => {
    const on = !mirror;
    setMirror(on);
    comp.current?.setMirror(on);
  };
  const chooseAspect = (a: string) => {
    setAspect(a);
    comp.current?.setAspect(a);
  };
  const switchCamera = async (id: string) => {
    await comp.current?.switchCamera(id);
    refreshTorch();
  };
  const switchMic = async (id: string) => {
    const track = await comp.current?.switchMic(id);
    if (track) await rtc.current?.replaceAudioTrack(track);
  };
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    comp.current?.setMuted(m);
  };
  const toggleTorch = async () => {
    const on = !torchOn;
    if (await comp.current?.setTorch(on)) setTorchOn(on);
  };
  const applyBitrate = (bps: number) => {
    setBitrate(bps);
    rtc.current?.setMaxBitrate(bps);
  };

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock.current = await (navigator as any).wakeLock.request('screen');
    } catch {
      /* not fatal */
    }
  }
  function releaseWakeLock() {
    try {
      wakeLock.current?.release();
    } catch {
      /* noop */
    }
    wakeLock.current = null;
  }

  // Background handling: the OS freezes capture when the tab is hidden.
  useEffect(() => {
    const onVis = async () => {
      if (document.hidden) {
        if (live) setPaused(true);
      } else {
        setPaused(false);
        if (live) {
          await acquireWakeLock();
          comp.current?.video.play().catch(() => {});
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [live]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(obsLink);
    } catch {
      /* noop */
    }
  };

  async function sendEmail() {
    if (!sessionId || !emailTo) return;
    setEmailStatus('sending');
    try {
      const r = await fetch(`${apiBase()}/sessions/${encodeURIComponent(sessionId)}/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: emailTo, passcode }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'send failed');
      setEmailStatus('sent');
    } catch (e) {
      setEmailStatus((e as Error).message || 'send failed');
    }
  }

  // ── render ──────────────────────────────────────────────────────────────────
  if (view === 'create') {
    return (
      <div style={{ padding: 12 }}>
        <Header status={status} />
        <section className="panel" style={{ maxWidth: 460, margin: '8vh auto 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h1 style={{ fontSize: 16, margin: '0 0 4px' }}>Create a stream link</h1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="label">Stream name (optional)</label>
            <input className="input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Field cam" />
          </div>
          <button className="btn primary" disabled={creating} onClick={createLink}>
            {creating ? 'Creating…' : 'Create link'}
          </button>
          <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
            You'll get a passcode-protected link to drop into OBS as a Browser Source. Then tap{' '}
            <b>Go Live</b> to start streaming from this device's camera.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <Header status={status} />
      <section className="studio-grid">
        <div className="stage">
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', display: 'block' }} />
          <div className="hud">
            {metrics ? (
              <>
                <span>{fmtBitrate(metrics.bitrate)}</span>
                <span>FPS <b>{metrics.fps}</b></span>
                {metrics.res && <span>{metrics.res}</span>}
                <span>RTT <b>{metrics.rtt}ms</b></span>
                <span>LOSS <b>{metrics.loss}%</b></span>
                <span style={{ color: metrics.connType === 'relay' ? 'var(--warn)' : 'var(--accent)' }}>
                  {connLabel(metrics)}
                </span>
              </>
            ) : null}
            <span>VIEWERS <b>{viewers}</b></span>
          </div>
          {paused && (
            <div className="paused" onClick={() => { setPaused(false); comp.current?.video.play().catch(() => {}); }}>
              <div className="dot warn" />
              <div className="label">Paused — tap to resume</div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn primary" onClick={goLive}>{live ? 'Stop' : 'Go Live'}</button>
            {mediaError && (
              <div style={{ border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', padding: 8 }}>
                <div className="label" style={{ color: 'var(--danger)' }}>{mediaError.title}</div>
                <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 4, lineHeight: 1.5 }}>
                  {mediaError.detail}
                </div>
              </div>
            )}
            <span className="label">OBS link</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" style={{ fontSize: 12 }} readOnly value={obsLink} />
              <button className="btn" onClick={copyLink}>Copy</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Passcode: <b>{passcode}</b></div>

            <span className="label" style={{ marginTop: 4 }}>Email the link</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                style={{ fontSize: 12 }}
                type="email"
                inputMode="email"
                placeholder="recipient@example.com"
                value={emailTo}
                onChange={(e) => {
                  setEmailTo(e.target.value);
                  setEmailStatus('');
                }}
              />
              <button className="btn" onClick={sendEmail} disabled={emailStatus === 'sending' || !emailTo}>
                Send
              </button>
            </div>
            {emailStatus && (
              <div
                style={{
                  fontSize: 11,
                  color:
                    emailStatus === 'sent'
                      ? 'var(--accent)'
                      : emailStatus === 'sending'
                      ? 'var(--muted)'
                      : 'var(--danger)',
                }}
              >
                {emailStatus === 'sent' ? 'Sent ✓' : emailStatus === 'sending' ? 'Sending…' : emailStatus}
              </div>
            )}
          </div>

          <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="label">Camera</span>
            <div className="row">
              <select className="input" onChange={(e) => switchCamera(e.target.value)}>
                {cameras.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
              </select>
              <button className={`btn ${mirror ? 'primary' : ''}`} onClick={toggleMirror}>Mirror</button>
            </div>
            <div className="row">
              <span className="label">Aspect</span>
              <span className="seg">
                {ASPECT_RATIOS.map((a: string) => (
                  <button key={a} className={aspect === a ? 'active' : ''} onClick={() => chooseAspect(a)}>{a}</button>
                ))}
              </span>
            </div>
          </div>

          <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Slider label="Brightness" value={adj.brightness} onChange={(v) => setAdjustment('brightness', v)} />
            <Slider label="Contrast" value={adj.contrast} onChange={(v) => setAdjustment('contrast', v)} />
            <Slider label="Saturation" value={adj.saturation} onChange={(v) => setAdjustment('saturation', v)} />
            <Slider label="Zoom" value={adj.zoom} min={100} max={400} onChange={(v) => setAdjustment('zoom', v)} />
            {torchSupported && (
              <div className="row"><span className="label">Torch</span><button className="btn" onClick={toggleTorch}>{torchOn ? 'On' : 'Off'}</button></div>
            )}
          </div>

          <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="row">
              <span className="label">Quality</span>
              <select className="input" style={{ width: 'auto' }} value={res} onChange={(e) => setRes(+e.target.value)}>
                <option value={480}>480p</option><option value={720}>720p</option><option value={1080}>1080p</option>
              </select>
              <select className="input" style={{ width: 'auto' }} value={fps} onChange={(e) => setFps(+e.target.value)}>
                <option value={30}>30 fps</option><option value={60}>60 fps</option>
              </select>
            </div>
            <div className="row">
              <span className="label">Bitrate cap</span>
              <select className="input" style={{ width: 'auto' }} value={bitrate} onChange={(e) => applyBitrate(+e.target.value)}>
                <option value={0}>Auto</option><option value={800000}>0.8 Mbps</option>
                <option value={1500000}>1.5 Mbps</option><option value={3000000}>3 Mbps</option><option value={6000000}>6 Mbps</option>
              </select>
            </div>
            <div className="row">
              <span className="label">Mic</span>
              <select className="input" onChange={(e) => switchMic(e.target.value)}>
                {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
              </select>
              <button className="btn" onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
            </div>
          </div>
        </div>
      </section>

      {controlView && (
        <section className="panel" style={{ marginTop: 12 }}>
          <div className="wordmark" style={{ marginBottom: 4 }}>
            CAMBRIDGE <span className="sep">//</span> <span className="accent">CONTROL</span>
          </div>
          <div className="label" style={{ marginBottom: 10 }}>
            Per-connection telemetry · {peerStats.length} active
          </div>
          {peerStats.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {live ? 'Waiting for a viewer (OBS) to connect…' : 'Go live to see connections.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {peerStats.map((p) => (
                <div
                  key={p.peerId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))',
                    gap: 10,
                    borderTop: '1px solid var(--border)',
                    paddingTop: 10,
                  }}
                >
                  <Stat label="Path" value={connLabel(p)} color={p.connType === 'relay' ? 'var(--warn)' : 'var(--accent)'} />
                  <Stat label="Bitrate" value={fmtBitrate(p.bitrate)} />
                  <Stat label="FPS" value={String(p.fps)} />
                  <Stat label="Resolution" value={p.res || '—'} />
                  <Stat label="RTT" value={`${p.rtt} ms`} />
                  <Stat label="Loss" value={`${p.loss}%`} color={p.loss > 3 ? 'var(--warn)' : undefined} />
                  <Stat label="ICE" value={`${p.localType || '?'} → ${p.remoteType || '?'}`} />
                  <Stat label="Transport" value={(p.protocol || '—').toUpperCase()} />
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span className="label">{label}</span>
      <span style={{ fontSize: 13, color: color || 'var(--text)' }}>{value}</span>
    </div>
  );
}

function Header({ status }: { status: { text: string; level: string } }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <span className="wordmark">CAMBRIDGE <span className="sep">//</span> <span className="accent">BROADCAST</span></span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Link to="/contact" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          Contact
        </Link>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          <span className={`dot ${status.level}`} />{status.text}
        </span>
      </span>
    </header>
  );
}

function Slider({ label, value, min = 0, max = 200, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <input type="range" className="slider" min={min} max={max} value={value} onChange={(e) => onChange(+e.target.value)} />
    </div>
  );
}
