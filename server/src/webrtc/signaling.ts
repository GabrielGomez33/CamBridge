import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer, RawData } from 'ws';
import { config } from '../config';
import type { Logger } from '../logger';
import { buildIceConfig } from './ice';
import { SessionStore, Session } from './sessions';
import { parseMessage, isStr, validSdp, validCandidate, ClientMessage } from './validation';

type Role = 'broadcaster' | 'viewer';

interface PeerSocket extends WebSocket {
  peerId: string;
  sessionId: string | null;
  role: Role | null;
  isAlive: boolean;
}

/**
 * Wires WebSocket signaling onto a session store.
 *
 *   client -> server
 *     { type:'join', sessionId, passcode, role }
 *     { type:'offer'|'answer'|'candidate', target, ... }
 *     { type:'stats', metrics }              // broadcaster telemetry
 *     { type:'kick', target }                // broadcaster only
 *     { type:'bye' }
 *
 *   server -> client
 *     { type:'joined', peerId, role, iceServers, turnEnabled, session }
 *     { type:'viewer-joined'|'viewer-left', peerId }   // -> broadcaster
 *     { type:'broadcaster-gone' }                       // -> viewer
 *     { type:'offer'|'answer'|'candidate', from, ... }  // relayed
 *     { type:'kicked' } | { type:'error', code, message }
 *
 * The broadcaster (holds the media) is always the OFFERER; viewers answer.
 */
export function attachSignaling(wss: WebSocketServer, store: SessionStore, logger: Logger) {
  const peers = new Map<string, PeerSocket>();
  // Dashboard observers (Phase 3) receive a copy of broadcaster `stats`.
  const dashboards = new Set<PeerSocket>();

  function send(ws: WebSocket | undefined, obj: unknown): void {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }
  const sendTo = (peerId: string, obj: unknown) => send(peers.get(peerId), obj);
  const fail = (ws: WebSocket, code: string, message: string) =>
    send(ws, { type: 'error', code, message });

  wss.on('connection', (raw: WebSocket, req: IncomingMessage) => {
    const ws = raw as PeerSocket;
    ws.peerId = crypto.randomUUID();
    ws.sessionId = null;
    ws.role = null;
    ws.isAlive = true;
    peers.set(ws.peerId, ws);

    logger.debug({ peerId: ws.peerId, ip: req.socket.remoteAddress }, 'ws connected');

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data: RawData) => {
      const { msg, error } = parseMessage(data, config.maxMessageBytes);
      if (error || !msg) return fail(ws, 'bad_message', error || 'bad message');
      try {
        handleMessage(ws, msg);
      } catch (err) {
        logger.error({ err, peerId: ws.peerId, type: msg.type }, 'message handler threw');
        fail(ws, 'internal', 'internal error');
      }
    });

    ws.on('close', () => detach(ws));
    ws.on('error', (err) => logger.debug({ err, peerId: ws.peerId }, 'ws error'));
  });

  function handleMessage(ws: PeerSocket, msg: ClientMessage): void {
    if (msg.type === 'join') return onJoin(ws, msg);

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
      case 'stats':
        return onStats(ws, session, msg);
      case 'kick':
        return onKick(ws, session, msg);
      case 'bye':
        ws.close(1000, 'bye');
        return;
    }
  }

  function onJoin(ws: PeerSocket, msg: ClientMessage): void {
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

    // Broadcaster offers; viewer answers.
    if (ws.role === 'viewer') {
      if (session.broadcaster && peers.has(session.broadcaster)) {
        sendTo(session.broadcaster, { type: 'viewer-joined', peerId: ws.peerId });
      } else {
        send(ws, { type: 'broadcaster-gone' });
      }
    } else {
      for (const viewerId of session.viewers) {
        if (peers.has(viewerId)) sendTo(session.broadcaster!, { type: 'viewer-joined', peerId: viewerId });
      }
    }
  }

  // Relay offer/answer to target — only between peers of the SAME session.
  function onSdp(ws: PeerSocket, session: Session, msg: ClientMessage): void {
    if (!isStr(msg.target, 64)) return fail(ws, 'bad_target', 'missing target');
    if (!validSdp(msg.sdp)) return fail(ws, 'bad_sdp', 'invalid sdp');
    if (!inSession(session, msg.target)) return fail(ws, 'bad_target', 'target not in session');
    sendTo(msg.target, { type: msg.type, from: ws.peerId, sdp: msg.sdp });
  }

  function onCandidate(ws: PeerSocket, session: Session, msg: ClientMessage): void {
    if (!isStr(msg.target, 64)) return fail(ws, 'bad_target', 'missing target');
    if (!validCandidate(msg.candidate)) return fail(ws, 'bad_candidate', 'invalid candidate');
    if (!inSession(session, msg.target)) return fail(ws, 'bad_target', 'target not in session');
    sendTo(msg.target, { type: 'candidate', from: ws.peerId, candidate: msg.candidate });
  }

  // Broadcaster telemetry → fan out to dashboard observers (Phase 3 consumers).
  function onStats(ws: PeerSocket, session: Session, msg: ClientMessage): void {
    if (ws.role !== 'broadcaster') return;
    const payload = {
      type: 'session-stats',
      sessionId: session.id,
      title: session.title,
      viewers: session.viewers.size,
      metrics: msg.metrics ?? {},
    };
    for (const d of dashboards) send(d, payload);
  }

  // Broadcaster-only: forcibly disconnect a viewer.
  function onKick(ws: PeerSocket, session: Session, msg: ClientMessage): void {
    if (ws.role !== 'broadcaster') return fail(ws, 'forbidden', 'only the broadcaster can kick');
    if (!isStr(msg.target, 64)) return fail(ws, 'bad_target', 'missing target');
    if (!session.viewers.has(msg.target)) return fail(ws, 'bad_target', 'not a viewer here');
    const victim = peers.get(msg.target);
    if (victim) {
      send(victim, { type: 'kicked' });
      victim.close(4003, 'kicked');
    }
  }

  const inSession = (session: Session, peerId: string) =>
    session.broadcaster === peerId || session.viewers.has(peerId);

  function detach(ws: PeerSocket): void {
    peers.delete(ws.peerId);
    dashboards.delete(ws);
    if (!ws.sessionId) return;

    const session = store.get(ws.sessionId);
    if (!session) return;

    if (ws.role === 'broadcaster' && session.broadcaster === ws.peerId) {
      session.broadcaster = null;
      session.status = 'open';
      for (const viewerId of session.viewers) sendTo(viewerId, { type: 'broadcaster-gone' });
      logger.info({ sessionId: session.id }, 'broadcaster left');
    } else if (ws.role === 'viewer') {
      session.viewers.delete(ws.peerId);
      if (session.broadcaster) sendTo(session.broadcaster, { type: 'viewer-left', peerId: ws.peerId });
    }
    store.touch(session);
  }

  // Heartbeat: prune half-open sockets.
  const hb = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as PeerSocket;
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
    dashboards,
    stop() {
      clearInterval(hb);
    },
  };
}
