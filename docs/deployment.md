# CamBridge — Deployment

CamBridge deploys exactly like `admin` / `mirror-server`: a git checkout on the
server, built in place, run under PM2, fronted by nginx, with HTTPS from Let's
Encrypt. CI/CD (GitHub Actions) automates the build → restart → health-check →
rollback loop on every push to `master`.

## 1. One-time server setup

```bash
# As administrator on tugrr-portal:
sudo chown -R administrator:administrator /var/www/CamBridge
git config --global --add safe.directory /var/www/CamBridge

# Make /var/www/CamBridge a checkout of this repo's master branch:
cd /var/www/CamBridge
git init && git remote add origin https://github.com/gabrielgomez33/cambridge.git
git fetch origin master && git checkout -f master

# Server env + first build:
cd server
cp .env.example .env        # fill in DB, JWT, TURN, email secrets
npm ci && npm run build

# Start under PM2 (from repo root):
cd ..
sudo pm2 startOrRestart ecosystem.config.js
sudo pm2 save
```

Health check: `curl http://localhost:8447/cambridge/api/health` → `{"ok":true,...}`

## 2. GitHub Actions secrets

The pipeline reuses your existing deploy credentials, plus one new path:

| Secret | Value |
| --- | --- |
| `SERVER_HOST` | tugrr-portal host/IP (shared) |
| `SERVER_USER` | deploy SSH user, e.g. `administrator` (shared) |
| `SERVER_SSH_KEY` | deploy private key (shared) |
| `CAMBRIDGE_DEPLOY_PATH` | `/var/www/CamBridge` |

The deploy user needs passwordless `sudo pm2` (same as admin/mirror-server).

## 3. nginx (reverse proxy + WebSocket upgrade)

```nginx
# Inside your existing HTTPS server block (Let's Encrypt cert):
location /cambridge/ {
    proxy_pass http://127.0.0.1:8447;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;          # WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;                         # keep WS alive
}
```

> `getUserMedia` (camera/mic) requires HTTPS. The Let's Encrypt cert that already
> serves your domain covers this. For local phone testing without a public cert,
> use [`mkcert`](https://github.com/FiloSottile/mkcert) to trust a LAN cert.

## 4. TURN (coturn) — Phase 2

```bash
sudo apt install coturn
# /etc/turnserver.conf:
#   use-auth-secret
#   static-auth-secret=<same value as TURN_SECRET in server/.env>
#   realm=cam.example.com
#   listening-port=3478
#   tls-listening-port=5349
#   cert / pkey  -> your Let's Encrypt fullchain/privkey
```

Then in `server/.env`: `TURN_ENABLED=true`, `TURN_SECRET=...`,
`TURN_URLS=turn:cam.example.com:3478?transport=udp,turns:cam.example.com:5349?transport=tcp`.

## 5. Deploy flow (automated)

Push to `master` → GitHub Actions:
1. Quality gate (`tsc --noEmit`, build, audit, secret scan)
2. SSH → `git reset --hard origin/master` → build → `npm prune --omit=dev`
3. `pm2 startOrRestart ecosystem.config.js`
4. Health check (10 × 5s) — **auto-rollback** to the pre-deploy commit on failure
5. Tag release `vYYYY.MM.DD-<sha>`
