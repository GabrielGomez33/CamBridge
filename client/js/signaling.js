// Signaling client — a thin, resilient wrapper over the CamBridge WS endpoint.
// Auto-reconnects with exponential backoff and re-emits a `reconnected` event so
// callers can re-join their session. The browser answers server pings
// automatically, so no app-level heartbeat is needed here.

export class SignalingClient extends EventTarget {
  /** @param {string} [url] defaults to the server's /cambridge/ws on this origin */
  constructor(url) {
    super();
    this.url = url || defaultWsUrl();
    this.ws = null;
    this.shouldRun = false;
    this.backoff = 500; // ms, grows to a cap
    this.maxBackoff = 10000;
    this._everConnected = false;
  }

  connect() {
    this.shouldRun = true;
    this._open();
  }

  _open() {
    if (!this.shouldRun) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoff = 500;
      const reconnected = this._everConnected;
      this._everConnected = true;
      this.dispatchEvent(new CustomEvent(reconnected ? 'reconnected' : 'open'));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Emit both a generic and a type-specific event.
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      if (msg && typeof msg.type === 'string') {
        this.dispatchEvent(new CustomEvent(`msg:${msg.type}`, { detail: msg }));
      }
    });

    ws.addEventListener('close', () => {
      this.dispatchEvent(new CustomEvent('disconnected'));
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    });
  }

  _scheduleReconnect() {
    if (!this.shouldRun) return;
    const wait = Math.min(this.backoff, this.maxBackoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    setTimeout(() => this._open(), wait);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  join(sessionId, passcode, role) {
    return this.send({ type: 'join', sessionId, passcode, role });
  }

  close() {
    this.shouldRun = false;
    if (this.ws) {
      try {
        this.ws.close(1000, 'client closing');
      } catch {
        /* noop */
      }
    }
  }
}

export function defaultWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/cambridge/ws`;
}
