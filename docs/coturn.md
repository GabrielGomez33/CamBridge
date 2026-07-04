# CamBridge — coturn (TURN) setup, A→Z

TURN relays media when a **direct P2P connection can't be made** (symmetric NAT /
CGNAT / most cellular). CamBridge already mints coturn's native short-lived HMAC
credentials, so once coturn is running you only flip a few env vars — **no code
change**.

> coturn is tiny (it just relays UDP). CPU/RAM are irrelevant; the only real
> cost is **upstream bandwidth** for the fraction of connections that relay
> (~3–6 Mbps of your upload per relayed 1080p stream). Only ~15–20% of
> connections relay; the rest go direct.

Assumes Ubuntu, the domain `theundergroundrailroad.world`, public IP
`24.39.41.126`, and an existing Let's Encrypt cert at
`/etc/letsencrypt/live/theundergroundrailroad.world/`.

---

## 1. Install

```bash
sudo apt update && sudo apt install -y coturn
```

Enable the service (Ubuntu ships it disabled): edit `/etc/default/coturn` and
uncomment:

```
TURNSERVER_ENABLED=1
```

## 2. Generate the shared secret

This ONE secret goes in both `turnserver.conf` and CamBridge's `.env`.

```bash
openssl rand -hex 32
# copy the output — call it <TURN_SECRET>
```

## 3. Give coturn read access to the TLS cert (renewal-safe)

coturn runs as the `turnserver` user, which can't read Let's Encrypt's
root-owned private key. Copy the cert into a coturn-owned dir on every renewal:

```bash
sudo mkdir -p /etc/coturn/certs
sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn-certs.sh >/dev/null <<'HOOK'
#!/bin/bash
D=/etc/letsencrypt/live/theundergroundrailroad.world
cp "$D/fullchain.pem" "$D/privkey.pem" /etc/coturn/certs/
chown -R turnserver:turnserver /etc/coturn/certs
chmod 640 /etc/coturn/certs/privkey.pem
systemctl try-reload-or-restart coturn 2>/dev/null || true
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn-certs.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/coturn-certs.sh   # seed it once now
```

## 4. Configure coturn

Replace `/etc/turnserver.conf` with this (set `<TURN_SECRET>`; see the
`external-ip` note):

```conf
# --- Networking ---
listening-port=3478
tls-listening-port=5349
# The public IP clients reach you on. If this box is behind a home router
# (its own interface shows a 10.x / 192.168.x address), use the PUBLIC/PRIVATE
# form instead, e.g.:  external-ip=24.39.41.126/192.168.1.50
external-ip=24.39.41.126
# Limit the relay UDP port range — you forward exactly these on your router.
min-port=49160
max-port=49200

# --- Auth: coturn's ephemeral HMAC scheme (matches CamBridge) ---
use-auth-secret
static-auth-secret=<TURN_SECRET>
realm=theundergroundrailroad.world

# --- TLS for turns: (copied cert from step 3) ---
cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/certs/privkey.pem
no-tlsv1
no-tlsv1_1

# --- Hardening ---
fingerprint
no-cli
no-multicast-peers
# Never let the relay reach private/internal networks (SSRF protection):
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# --- Basic quotas ---
user-quota=12
total-quota=1200
stale-nonce=600

# --- Run as the service user + log ---
proc-user=turnserver
proc-group=turnserver
log-file=/var/log/turnserver/turnserver.log
simple-log
```

> **Which hostname?** The `turns:` URL must match the cert. Confirm the cert
> covers `theundergroundrailroad.world`:
> `sudo openssl x509 -in /etc/coturn/certs/fullchain.pem -noout -text | grep DNS`
> If it only lists `www.theundergroundrailroad.world`, use that host in the
> `TURN_URLS` below instead.

Start it:

```bash
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn          # should be active (running)
sudo ss -ulnp | grep turnserver       # should show :3478 listening
```

## 5. Open the ports

**Host firewall** (if `ufw` is active):
```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49160:49200/udp
```

**Home router — port-forward the same to this box's LAN IP** (find it with
`hostname -I`):

| Protocol | Port(s) | → to box |
| --- | --- | --- |
| UDP | 3478 | TURN/STUN |
| TCP | 3478 | TURN over TCP |
| TCP + UDP | 5349 | TURNS (TLS/DTLS) |
| UDP | 49160–49200 | relay range |

## 6. Wire CamBridge

In `/var/www/CamBridge/server/.env`:

```
TURN_ENABLED=true
TURN_SECRET=<TURN_SECRET>          # SAME value as static-auth-secret
TURN_URLS=turn:theundergroundrailroad.world:3478?transport=udp,turn:theundergroundrailroad.world:3478?transport=tcp,turns:theundergroundrailroad.world:5349?transport=tcp
TURN_TTL_SEC=3600
```

Restart (env-only change, no rebuild needed):
```bash
sudo pm2 restart cambridge-server
```
The startup log should NOT show the "TURN disabled" warning, and
`curl -s localhost:8447/cambridge/api/health` should report `"turn":true`.

## 7. Verify TURN actually relays

Two ways:

**A. In-app (easiest) — force a relay-only connection.** Add `&relay=1` to BOTH
links. This sets `iceTransportPolicy: 'relay'`, so the connection *must* go
through TURN — if it connects, TURN works.

```
…/cambridge/broadcaster?s=…&p=…&relay=1&controlView=1
…/cambridge/viewer?s=…&p=…&relay=1&controlView=1
```
With `controlView`, the panel should read **`TURN · relay`**. (Remove `&relay=1`
for normal use so direct P2P is still preferred.)

**B. Trickle-ICE tester.** Generate a temporary credential:
```bash
SECRET=<TURN_SECRET>
U=$(( $(date +%s) + 3600 ))
P=$(printf "%s" "$U" | openssl dgst -binary -sha1 -hmac "$SECRET" | openssl base64)
echo "username: $U"; echo "credential: $P"
```
Open <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>,
add `turn:theundergroundrailroad.world:3478?transport=udp` with that
username/credential, "Gather candidates" → you should see candidates of type
**`relay`**.

Watch the server side while testing: `sudo journalctl -u coturn -f` (or tail
`/var/log/turnserver/turnserver.log`) shows `allocation` lines on a relay.

## 8. Troubleshooting

- **`turn:false` in health / "TURN disabled" warning** → `TURN_URLS` or
  `TURN_SECRET` empty in `.env`.
- **No `relay` candidates** → ports not open end-to-end (router forward + `ufw`),
  or `external-ip` wrong (behind NAT → use the `PUBLIC/PRIVATE` form).
- **`turns:` (TLS) fails but `turn:` works** → cert hostname mismatch; use the
  exact host from the cert's DNS SANs, or rely on `turn:`/`turn:…tcp` which
  don't need TLS.
- **401 in coturn logs** → `static-auth-secret` ≠ CamBridge `TURN_SECRET`.
- **Bandwidth** → each relayed 1080p stream ≈ 3–6 Mbps of your upload; widen
  `min/max-port` and forward more ports if you need many concurrent relays, or
  move coturn to a small VPS (same config) to spare your home upload.
