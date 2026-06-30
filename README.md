# CamBridge

Stream from any phone or camera-equipped device, peer-to-peer over WebRTC,
straight into OBS (or any WebRTC consumer) — with full live camera controls.
A lightweight Node signaling server brokers the connection; media flows directly
device → OBS. Free, open, device-agnostic.

```
📱 Camera app (broadcaster)  ──WebRTC P2P──▶  🎥 OBS Browser Source  ──▶  any platform
   create link + passcode         STUN/TURN        passcode in the URL
```

See **[SPEC.md](./SPEC.md)** for the full technical design and decisions.

## Stack

- **Server** — TypeScript · Express · `ws` · MySQL · PM2 (sibling to mirror-server / admin)
- **Client** — React + Vite (camera app, OBS viewer, dashboard) · terminal aesthetic
- **Media** — WebRTC P2P, STUN + coturn (short-lived HMAC TURN creds)
- **Auth** — ported from mirror-server (bcrypt · JWT · email verify · reset)
- **CI/CD** — GitHub Actions → SSH deploy → PM2 → health check → auto-rollback

## Layout

```
server/        TS/Express signaling + API server (port 8447, base /cambridge)
  src/webrtc/  ICE, sessions, signaling, validation
  src/routes/  REST: create link, status, health
client/        React app (camera, viewer, dashboard) + shared css/tokens.css
ecosystem.config.js   PM2 process (cambridge-server)
.github/workflows/    CI/CD pipeline
docs/          deployment guide
```

## Develop

```bash
cd server
cp .env.example .env      # fill in as needed
npm install
npm run dev               # tsx watch, http://localhost:8447/cambridge/api/health
```

Quick check:

```bash
curl localhost:8447/cambridge/api/health
curl -X POST localhost:8447/cambridge/api/sessions -H 'content-type: application/json' -d '{"title":"test"}'
```

## Status

Phased build — see SPEC.md §10.

- [x] **Phase 0** — foundation: TS/Express skeleton, WebRTC signaling, CI/CD, PM2, design tokens
- [ ] **Phase 1** — auth & accounts (ported from Mirror)
- [ ] **Phase 2** — camera app + OBS viewer + TURN
- [ ] **Phase 3** — `CAMBRIDGE // CONTROL` dashboard
- [ ] **Phase 4** — hardening + deploy (Let's Encrypt, nginx, coturn)

Deployment: see **[docs/deployment.md](./docs/deployment.md)**.
