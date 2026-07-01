import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Compositor, ASPECT_RATIOS } from '../engine/compositor.js';
import { SignalingClient } from '../engine/signaling.js';
import { BroadcasterRtc } from '../engine/rtc.js';
import { startStats, fmtBitrate } from '../engine/stats.js';
import { apiBase, pageBase } from '../engine/base.js';

type Device = { deviceId: string; label: string };
type Metrics = { bitrate: number; fps: number; res: string; rtt: number; loss: number } | null;

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

  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<{ text: string; level: string }>({ text: 'Idle', level: 'warn' });
  const [metrics, setMetrics] = useState<Metrics>(null);
  const [viewers, setViewers] = useState(0);
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
    setStatus({ text: 'Starting camera', level: 'warn' });
    try {
      comp.current = new Compositor(canvasRef.current);
      const stream = await comp.current.start({ resHeight: res, fps });
      comp.current.setMirror(mirror);
      comp.current.setAspect(aspect);
      await populateDevices();
      refreshTorch();

      sig.current = new SignalingClient();
      rtc.current = new BroadcasterRtc(sig.current);
      rtc.current.setStream(stream);
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
      stopStats.current = startStats(
        () => {
          const first = rtc.current?.peers.values().next().value;
          return first ? first.pc : null;
        },
        (m: Metrics) => {
          setMetrics(m);
          if (m) sig.current?.send({ type: 'stats', metrics: m });
        }
      );
    } catch {
      setStatus({ text: 'Camera blocked', level: 'danger' });
      alert('Could not start the camera. Grant camera/mic permission and use HTTPS.');
    }
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
  }

  async function populateDevices() {
    const cams = await comp.current.listCameras();
    setCameras(cams.map((c: any, i: number) => ({ deviceId: c.deviceId, label: c.label || `Camera ${i + 1}` })));
    const devs = await navigator.mediaDevices.enumerateDevices();
    setMics(
      devs
        .filter((d) => d.kind === 'audioinput')
        .map((m, i) => ({ deviceId: m.deviceId, label: m.label || `Mic ${i + 1}` }))
    );
  }

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
            <span className="label">OBS link</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" style={{ fontSize: 12 }} readOnly value={obsLink} />
              <button className="btn" onClick={copyLink}>Copy</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Passcode: <b>{passcode}</b></div>
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
    </div>
  );
}

function Header({ status }: { status: { text: string; level: string } }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <span className="wordmark">CAMBRIDGE <span className="sep">//</span> <span className="accent">BROADCAST</span></span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        <span className={`dot ${status.level}`} />{status.text}
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
