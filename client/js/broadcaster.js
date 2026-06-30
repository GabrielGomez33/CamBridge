// Broadcaster (camera app) controller. Wires the always-canvas Compositor to the
// UI controls and the BroadcasterRtc/Signaling layers. Reliability extras: wake
// lock while live, reconnecting signaling, and a paused overlay when the OS
// backgrounds the tab (which freezes capture on mobile).

import { Compositor } from './compositor.js';
import { SignalingClient } from './signaling.js';
import { BroadcasterRtc } from './rtc.js';
import { startStats, fmtBitrate } from './stats.js';
import { apiBase, pageBase } from './base.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let sessionId = params.get('s');
let passcode = params.get('p');

const dot = $('dot');
const stateText = $('stateText');
function setState(state, level) {
  stateText.textContent = state;
  dot.className = `dot ${level || ''}`;
}

const canvas = $('preview');
const compositor = new Compositor(canvas);
let signaling = null;
let rtc = null;
let stopStats = null;
let wakeLock = null;
let live = false;

// ── view routing ──────────────────────────────────────────────────────────
if (sessionId && passcode) {
  showStudio();
} else {
  $('create').classList.remove('hidden');
}

$('createBtn').addEventListener('click', async () => {
  $('createBtn').disabled = true;
  try {
    const res = await fetch(`${apiBase()}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: $('title').value || '' }),
    });
    if (!res.ok) throw new Error('create failed');
    const data = await res.json();
    sessionId = data.sessionId;
    passcode = data.passcode;
    const url = new URL(location.href);
    url.searchParams.set('s', sessionId);
    url.searchParams.set('p', passcode);
    history.replaceState(null, '', url);
    showStudio(data.viewerUrl);
  } catch {
    alert('Could not create a link. Is the server running?');
    $('createBtn').disabled = false;
  }
});

function showStudio(viewerUrl) {
  $('create').classList.add('hidden');
  $('studio').classList.remove('hidden');
  const link = viewerUrl || `${location.origin}${pageBase()}/viewer.html?s=${encodeURIComponent(sessionId)}&p=${encodeURIComponent(passcode)}`;
  $('obsLink').value = link;
  $('passcodeText').textContent = passcode;
}

$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('obsLink').value);
    $('copyLink').textContent = 'Copied';
    setTimeout(() => ($('copyLink').textContent = 'Copy'), 1500);
  } catch {
    $('obsLink').select();
  }
});

// ── go live ────────────────────────────────────────────────────────────────
$('goLive').addEventListener('click', async () => {
  if (live) return stopLive();
  setState('Starting camera', 'warn');
  try {
    const stream = await compositor.start({
      resHeight: parseInt($('resSelect').value, 10),
      fps: parseInt($('fpsSelect').value, 10),
    });
    await populateDevices();
    revealTorchIfSupported();

    signaling = new SignalingClient();
    rtc = new BroadcasterRtc(signaling);
    rtc.setStream(stream);
    rtc.onPeerCount = () => renderHud(lastMetrics);

    const join = () => signaling.join(sessionId, passcode, 'broadcaster');
    signaling.addEventListener('open', join);
    signaling.addEventListener('reconnected', join);
    signaling.addEventListener('msg:joined', (e) => {
      rtc.setIceServers(e.detail.iceServers);
      applyBitrate();
      setState(e.detail.turnEnabled ? 'Live · TURN ready' : 'Live', 'success');
    });
    signaling.addEventListener('msg:error', (e) => {
      if (e.detail.code === 'broadcaster_exists') setState('Already broadcasting elsewhere', 'danger');
      else setState(e.detail.message || 'Signal error', 'danger');
    });
    signaling.connect();

    live = true;
    $('goLive').textContent = 'Stop';
    dot.classList.remove('warn');
    dot.classList.add('success');
    await acquireWakeLock();
    startTelemetry();
  } catch (err) {
    setState('Camera blocked', 'danger');
    alert('Could not start the camera. Grant camera/mic permission and use HTTPS.');
  }
});

function stopLive() {
  live = false;
  $('goLive').textContent = 'Go Live';
  if (stopStats) stopStats();
  rtc?.closeAll();
  signaling?.close();
  compositor.stop();
  releaseWakeLock();
  setState('Idle', 'warn');
}

// ── device pickers ───────────────────────────────────────────────────────────
async function populateDevices() {
  const cams = await compositor.listCameras();
  const camSel = $('cameraSelect');
  camSel.innerHTML = '';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || `Camera ${i + 1}`;
    camSel.appendChild(o);
  });

  const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const micSel = $('micSelect');
  micSel.innerHTML = '';
  mics.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = m.deviceId;
    o.textContent = m.label || `Mic ${i + 1}`;
    micSel.appendChild(o);
  });
}

$('cameraSelect').addEventListener('change', (e) => compositor.switchCamera(e.target.value).then(revealTorchIfSupported));
$('micSelect').addEventListener('change', async (e) => {
  const track = await compositor.switchMic(e.target.value);
  await rtc?.replaceAudioTrack(track);
});
$('muteBtn').addEventListener('click', () => {
  const muted = $('muteBtn').textContent === 'Mute';
  compositor.setMuted(muted);
  $('muteBtn').textContent = muted ? 'Unmute' : 'Mute';
});

// ── adjustments ──────────────────────────────────────────────────────────────
$('brightness').addEventListener('input', (e) => compositor.setAdjustment('brightness', e.target.value / 100));
$('contrast').addEventListener('input', (e) => compositor.setAdjustment('contrast', e.target.value / 100));
$('saturation').addEventListener('input', (e) => compositor.setAdjustment('saturation', e.target.value / 100));
$('zoom').addEventListener('input', (e) => compositor.setZoom(e.target.value / 100));
$('flipBtn').addEventListener('click', () => {
  const on = $('flipBtn').classList.toggle('active');
  compositor.setMirror(on);
});
$('aspectSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  [...$('aspectSeg').children].forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  compositor.setAspect(btn.dataset.a);
});
$('bitrateSelect').addEventListener('change', applyBitrate);
function applyBitrate() {
  rtc?.setMaxBitrate(parseInt($('bitrateSelect').value, 10));
}

function revealTorchIfSupported() {
  const caps = compositor.videoCapabilities();
  const supported = 'torch' in caps;
  $('torchRow').style.display = supported ? 'flex' : 'none';
}
$('torchBtn').addEventListener('click', async () => {
  const on = $('torchBtn').textContent === 'Off';
  const ok = await compositor.setTorch(on);
  if (ok) $('torchBtn').textContent = on ? 'On' : 'Off';
});

// ── telemetry HUD + dashboard relay ─────────────────────────────────────────
let lastMetrics = null;
function startTelemetry() {
  stopStats = startStats(
    () => {
      const first = rtc?.peers.values().next().value;
      return first ? first.pc : null;
    },
    (m) => {
      lastMetrics = m;
      renderHud(m);
      if (m) signaling?.send({ type: 'stats', metrics: m });
    }
  );
}
function renderHud(m) {
  const viewers = rtc?.peers.size || 0;
  if (!m) {
    $('hud').innerHTML = `<span>VIEWERS <b>${viewers}</b></span>`;
    return;
  }
  $('hud').innerHTML =
    `<span>${fmtBitrate(m.bitrate)}</span>` +
    `<span>FPS <b>${m.fps}</b></span>` +
    (m.res ? `<span>${m.res}</span>` : '') +
    `<span>RTT <b>${m.rtt}ms</b></span>` +
    `<span>LOSS <b>${m.loss}%</b></span>` +
    `<span>VIEWERS <b>${viewers}</b></span>`;
}

// ── wake lock + background handling ─────────────────────────────────────────
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    /* not fatal */
  }
}
function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch {
    /* noop */
  }
  wakeLock = null;
}

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    if (live) $('pausedOverlay').classList.add('show');
  } else {
    $('pausedOverlay').classList.remove('show');
    if (live) {
      await acquireWakeLock();
      compositor.video.play().catch(() => {});
    }
  }
});
$('pausedOverlay').addEventListener('click', () => {
  $('pausedOverlay').classList.remove('show');
  compositor.video.play().catch(() => {});
});
