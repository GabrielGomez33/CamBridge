import crypto from 'node:crypto';
import { config } from './config.js';
import { buildIceConfig } from './ice.js';
import { parseMessage, isStr, validSdp, validCandidate } from './validation.js';

/**
 * Wires WebSocket signaling onto a session store.
 *
 * Protocol (JSON text frames):
 *
 *   client -> server
 *     { type:'join', sessionId, passcode, role:'broadcaster'|'viewer' }
 *     { type:'offer',     target, sdp }
 *     { type:'answer',    target, sdp }
 *     { type:'candidate', target, candidate }
 *     { type:'kick',      target }            // broadcaster only
 *     { type:'bye' }
 *
 *   server -> client
 *     { type:'joined', peerId, role, iceServers, turnEnabled, session:{...} }
 *     { type:'viewer-joined', peerId }        // -> broadcaster
 *     { type:'viewer-left',   peerId }        // -> broadcaster
 *     { type:'broadcaster-ready', peerId }    // -> viewer (offerer should start)
 *     { type:'broadcaster-gone' }             // -> viewer
 *     { type:'offer'|'answer'|'candidate', from, ... }   // relayed
 *     { type:'kicked' }
 *     { type:'error', code, message }
 *
 * Role model: the broadcaster (phone, holds the media) is always the OFFERER.
 * A viewer (OBS) answers. So when a viewer joins an already-live session we tell
 * the broadcaster to create an offer targeted at that viewer's peerId.
 */
export function attachSignaling(wss, store, logger) {
  /** @type {Map<string, import('ws').WebSocket>} peerId -> socket */
  const peers = new Map();

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function sendTo(peerId, obj) {
    send(peers.get(peerId), obj);
  }

  function fail(ws, code, message) {
    send(ws, { type: 'error', code, message });
  }

  // ── connection lifecycle ───────────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    ws.peerId = crypto.randomUUID();
    ws.sessionId = null;
    ws.role = null;
    ws.isAlive = true;
    peers.set(ws.peerId, ws);

    const ip = req.socket.remoteAddress;
    logger.debug({ peerId: ws.peerId, ip }, 'ws connected');

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      const { msg, error } = parseMessage(data, config.maxMessageBytes);
      if (error) return fail(ws, 'bad_message', error);

      try {
        handleMessage(ws, msg);
      } catch (err) {
        logger.error({ err, peerId: ws.peerId, type: msg.type }, 'message handler threw');
        fail(ws, 'internal', 'internal error');
      }
    });

    ws.on('close', () => detach(ws));
    ws.on('error', (err) => {
      logger.debug({ err, peerId: ws.peerId }, 'ws error');
    });
  });

  // ── message routing ─────────────────────────────────────────────────────────
  function handleMessage(ws, msg) {
    if (msg.type === 'join') return onJoin(ws, msg);

    // All other messages require a joined session.
    if (!ws.sessionId) return fail(ws, 'not_joined', 'join a session first');
    const session = store.get(ws.sessionId);
    if (!session) return fail(ws, 'no_session', 'session no longer exists');
    store.touch(session);

    switch (msg.type) {
      case 'offer':
      case 'answer':
        return onSdp(ws, session, msg);
      case 'candidate':
        return onCandidate(ws, session, msg);
      case 'kick':
        return onKick(ws, session, msg);
      case 'bye':
        ws.close(1000, 'bye');
        return;
    }
  }

  function onJoin(ws, msg) {
    if (ws.sessionId) return fail(ws, 'already_joined', 'already in a session');
    if (!isStr(msg.sessionId, 64)) return fail(ws, 'bad_join', 'missing sessionId');
    if (!isStr(msg.passcode, 64)) return fail(ws, 'bad_join', 'missing passcode');
    if (msg.role !== 'broadcaster' && msg.role !== 'viewer') {
      return fail(ws, 'bad_join', 'role must be broadcaster or viewer');
    }

    const session = store.get(msg.sessionId);
    if (!session) return fail(ws, 'no_session', 'no such session');
    if (!store.verifyPasscode(session, msg.passcode)) {
      logger.warn({ sessionId: session.id, role: msg.role }, 'join rejected: bad passcode');
      return fail(ws, 'bad_passcode', 'incorrect passcode');
    }

    if (msg.role === 'broadcaster') {
      // Only one broadcaster per session. Replace a stale one if its socket died.
      if (session.broadcaster && peers.has(session.broadcaster)) {
        return fail(ws, 'broadcaster_exists', 'this session already has a broadcaster');
      }
      session.broadcaster = ws.peerId;
      session.status = 'live';
    } else {
      session.viewers.add(ws.peerId);
    }

    ws.sessionId = session.id;
    ws.role = msg.role;
    store.touch(session);

    const { iceServers, turnEnabled } = buildIceConfig(ws.peerId);
    send(ws, {
      type: 'joined',
      peerId: ws.peerId,
      role: ws.role,
      iceServers,
      turnEnabled,
      session: { id: session.id, title: session.title, status: session.status },
    });

    logger.info(
      { sessionId: session.id, peerId: ws.peerId, role: ws.role, viewers: session.viewers.size },
      'peer joined'
    );

    // Connect the two ends. Broadcaster offers; viewer answers.
    if (ws.role === 'viewer') {
      if (session.broadcaster && peers.has(session.broadcaster)) {
        // Tell the broadcaster to open an offer toward this viewer.
        sendTo(session.broadcaster, { type: 'viewer-joined', peerId: ws.peerId });
      } else {
        send(ws, { type: 'broadcaster-gone' });
      }
    } else {
      // A broadcaster (re)joined — nudge any waiting viewers to expect an offer.
      for (const viewerId of session.viewers) {
        if (peers.has(viewerId)) {
          sendTo(session.broadcaster, { type: 'viewer-joined', peerId: viewerId });
        }
      }
    }
  }

  // Relay an offer/answer to its target, but only between peers of the SAME
  // session — a peer can never address someone in another room.
  function onSdp(ws, session, msg) {
    if (!isStr(msg.target, 64)) return fail(ws, 'bad_target', 'missing target');
    if (!validSdp(msg.sdp)) return fail(ws, 'bad_sdp', 'invalid sdp');
    if (!inSession(session, msg.target)) return fail(ws, 'bad_target', 'target not in session');
    sendTo(msg.target, { type: msg.type, from: ws.peerId, sdp: msg.sdp });
  }

  function onCandidate(ws, session, msg) {
    if (!isStr(msg.target, 64)) return fail(ws, 'bad_target', 'missing target');
    if (!validCandidate(msg.candidate)) return fail(ws, 'bad_candidate', 'invalid candidate');
    if (!inSession(session, msg.target)) return fail(ws, 'bad_target', 'target not in session');
    sendTo(msg.target, { type: 'candidate', from: ws.peerId, candidate: msg.candidate });
  }

  // Broadcaster-only: forcibly disconnect a viewer.
  function onKick(ws, session, msg) {
    if (ws.role !== 'broadcaster') return fail(ws, 'forbidden', 'only the broadcaster can kick');
    if (!isStr(msg.target, 64)) return fail(ws, 'bad_target', 'missing target');
    if (!session.viewers.has(msg.target)) return fail(ws, 'bad_target', 'not a viewer here');
    const victim = peers.get(msg.target);
    if (victim) {
      send(victim, { type: 'kicked' });
      victim.close(4003, 'kicked');
    }
  }

  function inSession(session, peerId) {
    return session.broadcaster === peerId || session.viewers.has(peerId);
  }

  // ── detach / cleanup ────────────────────────────────────────────────────────
  function detach(ws) {
    peers.delete(ws.peerId);
    if (!ws.sessionId) return;

    const session = store.get(ws.sessionId);
    if (!session) return;

    if (ws.role === 'broadcaster' && session.broadcaster === ws.peerId) {
      session.broadcaster = null;
      session.status = 'open';
      // Tell every viewer the source dropped so they can show a placeholder.
      for (const viewerId of session.viewers) {
        sendTo(viewerId, { type: 'broadcaster-gone' });
      }
      logger.info({ sessionId: session.id }, 'broadcaster left');
    } else if (ws.role === 'viewer') {
      session.viewers.delete(ws.peerId);
      if (session.broadcaster) {
        sendTo(session.broadcaster, { type: 'viewer-left', peerId: ws.peerId });
      }
    }
    store.touch(session);
  }

  // ── heartbeat: prune half-open sockets ───────────────────────────────────────
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket already gone */
      }
    }
  }, config.heartbeatIntervalMs);
  hb.unref?.();

  return {
    peers,
    stop() {
      clearInterval(hb);
    },
  };
}
