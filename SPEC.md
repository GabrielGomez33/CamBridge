# CamBridge — Technical Spec (source of truth)

> Stream from any phone/camera-equipped device, peer-to-peer, into OBS (or any
> WebRTC consumer) with full live camera controls. A lightweight Node signaling
> server brokers the connection; media flows directly device→OBS.

## 1. Product shape

```
📱 Camera app (broadcaster)  ──WebRTC P2P──▶  🎥 OBS Browser Source (viewer)  ──▶  any platform
   create link + passcode        STUN/TURN          passcode embedded in URL
```

- **Topology:** 1 broadcaster → 1+ viewers per *dynamic link* (normally exactly
  one viewer: OBS). No SFU, no mesh — each link is an isolated P2P pipe.
- **Audience** is downstream on whatever platform OBS streams to. The WebRTC
  link itself is never the audience.

## 2. Access model

| Surface | Gate |
| --- | --- |
| Platform accounts (manage/save links) | Mirror auth: login, register, forgot/reset password, email verify |
| Stream link (broadcaster + OBS) | Per-session **passcode**, embedded in the OBS viewer URL, constant-time validated |
| Control dashboard | **No login** (open / embedded in TUGRR portal) |

- `REQUIRE_AUTH_TO_CREATE` (config flag) decides whether link creation needs a
  logged-in account. Default **false** (open create); flip to require login.

## 3. Client — the camera app (always-canvas)

The outgoing video track is **always** `canvas.captureStream()`. Source camera
is drawn to a canvas every frame; all edits happen on the canvas. Because the
outgoing track never changes identity, **camera switches / resolution / aspect
changes never trigger WebRTC renegotiation** — the pipe is stable by design.

- **WYSIWYS** — what the operator sees in preview is exactly what streams.
- Audio bypasses the canvas (canvas is video-only); mic track is added directly;
  mic switching uses `replaceTrack` on the audio sender.
- Draw loop uses `requestVideoFrameCallback` (battery-friendly), rAF fallback.

### Controls (all in-stream, no tiers)
- Camera switch (front/back/enumerated), **mirror/flip**
- Brightness, contrast, saturation (canvas `ctx.filter`) — universal incl. iOS
- Zoom, white balance, focus, **torch** (native `applyConstraints` where the
  device reports capability via `getCapabilities()`)
- Resolution + FPS selector; **bitrate cap** (`sender.setParameters.maxBitrate`)
- Aspect/orientation: 16:9, 9:16, 1:1, 4:3 (canvas compositor: fit/crop/pan)
- Degradation preference: maintain-framerate vs maintain-resolution
- Audio: mic select, mute, gain, noise-suppression/echo-cancel, level meter
- Grid overlay (local only), optional text/lower-third overlay (in-stream)

## 4. Reliability (the actual product)

State machine: `idle → ready → connecting → live → reconnecting → failed`.
- WS auto-reconnect w/ exponential backoff; re-join session on reconnect.
- ICE restart (`pc.restartIce()`) on `disconnected`/`failed` before teardown.
- Adaptive bitrate: poll `getStats`, step down on sustained loss.
- **Wake Lock** while live (re-acquired on visibility regain).
- Mobile backgrounding freezes capture → **standby splash** on broadcaster, and
  a clean **standby card** on the viewer/OBS side (never a frozen frame).

## 5. Server (port :8447, base `/cambridge/api`)

- **TS + Express + MySQL + PM2**, sibling to mirror-server/admin.
- **Signaling** over WS at `/cambridge/ws`: `join / offer / answer / candidate /
  kick / bye`; broadcaster is always the offerer; strict allow-list validation;
  heartbeat ping/pong; origin gate (allows OBS `null` origin).
- **ICE/TURN:** STUN always; coturn via `use-auth-secret` short-lived HMAC creds
  (no static TURN password reaches a client).
- **REST:** `POST /sessions` (create link → broadcastUrl + viewerUrl + passcode),
  `GET /sessions/status`, `GET /health`.
- **Abuse:** per-IP create rate-limit, max-live-sessions cap, join-attempt limit.
- **Telemetry:** broadcaster sends `stats` (bitrate/fps/res/RTT/loss ~1Hz) →
  server → dashboard clients.

## 6. Auth (ported from mirror-server)

bcrypt(10) · JWT HS256 (access 15m / refresh 7d) · sessions in `user_sessions` ·
email via Resend/Brevo · Helmet · rate-limit. Routes + migrations ported 1:1,
namespaced under `/cambridge/api/auth`.

## 7. Dashboard — `CAMBRIDGE // CONTROL`

Terminal aesthetic (see §9). Live session cards (status, bitrate, fps, res, RTT,
viewer count), kick/close controls, aggregate stats. No admin login.

## 8. CI/CD (adapted from admin)

Node 22 · quality gate (`tsc --noEmit`, build, `npm audit`, secret scan for
`server/` + `client/`) · deploy on push to `master`: SSH → `git reset --hard` →
build → `npm prune --omit=dev` → `pm2 restart` → health check (10×5s) →
auto-rollback → tag release. Secrets: `SERVER_HOST`, `SERVER_USER`,
`SERVER_SSH_KEY` (shared) + `CAMBRIDGE_DEPLOY_PATH=/var/www/CamBridge`.

## 9. Design system (terminal aesthetic — from TUGRR portal)

```
bg #0a0a0a · panel #111114 · border #1f1f23 (1px) · text #e6e6e6 · muted #6b6b72
accent #34e57f (green) · warn #e5c234 (amber) · danger #e5484d (red)
font JetBrains Mono / ui-monospace · UPPERCASE letter-spaced labels
thin green meter bars; CAMBRIDGE // <SECTION> wordmark; auto-refresh dot
```

## 10. Phases

0. **Foundation** — TS/Express skeleton, signaling ported, CI/CD, ecosystem,
   design tokens, env, spec. ← *in progress*
1. **Auth** — port mirror auth (routes, migrations, email) + reskinned UI.
2. **Core streaming** — camera app, viewer/OBS page, TURN/coturn.
3. **Dashboard** — live telemetry + controls.
4. **Hardening & deploy** — rate limits, Let's Encrypt + nginx + coturn, docs.
