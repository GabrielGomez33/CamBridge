// OBS-facing viewer. Joins a session as a viewer, plays the incoming stream
// fullscreen, and shows a clean standby card whenever there's no live signal
// (so OBS never displays a frozen frame).

import { SignalingClient } from './signaling.js';
import { ViewerRtc } from './rtc.js';

const params = new URLSearchParams(location.search);
const sessionId = params.get('s');
const passcode = params.get('p');
if (params.get('bg') === 'transparent') document.body.classList.add('transparent');

const video = document.getElementById('video');
const standby = document.getElementById('standby');
const standbyTitle = document.getElementById('standbyTitle');
const standbySub = document.getElementById('standbySub');

function showStandby(title, sub) {
  standbyTitle.textContent = title;
  if (sub) standbySub.textContent = sub;
  standby.classList.remove('hidden');
}
function hideStandby() {
  standby.classList.add('hidden');
}

if (!sessionId || !passcode) {
  showStandby('Invalid link', 'Missing session or passcode');
} else {
  start();
}

function start() {
  const signaling = new SignalingClient();
  const rtc = new ViewerRtc(signaling, video);

  const join = () => signaling.join(sessionId, passcode, 'viewer');
  signaling.addEventListener('open', join);
  signaling.addEventListener('reconnected', join);

  signaling.addEventListener('msg:joined', (e) => {
    rtc.setIceServers(e.detail.iceServers);
    showStandby('Connecting', 'CAMBRIDGE // VIEWER');
  });
  signaling.addEventListener('msg:error', (e) => {
    const code = e.detail.code;
    if (code === 'bad_passcode') showStandby('Access denied', 'Incorrect passcode');
    else if (code === 'no_session') showStandby('Stream not found', 'Link expired or invalid');
    else showStandby('Signal error', e.detail.message || '');
  });

  rtc.onTrack = () => {
    hideStandby();
    tryPlay();
  };
  rtc.onGone = () => showStandby('Signal lost', 'Reconnecting…');

  // Track-level freeze detection (e.g. broadcaster backgrounded the app).
  video.addEventListener('loadedmetadata', () => {
    const track = video.srcObject && video.srcObject.getVideoTracks()[0];
    if (track) {
      track.addEventListener('mute', () => showStandby('Signal paused', 'Source interrupted'));
      track.addEventListener('unmute', () => hideStandby());
    }
  });

  signaling.connect();
}

// Autoplay with audio is blocked outside a gesture in normal browsers; OBS's CEF
// allows it. Try with audio, fall back to muted so the picture always shows.
function tryPlay() {
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(() => {});
  });
}
