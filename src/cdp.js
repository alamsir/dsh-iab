/**
 * dsh-iab — minimal Chrome DevTools Protocol client.
 *
 * Uses only Node built-ins (`child_process`, `fs`, global `WebSocket`), so the
 * plugin needs no npm dependencies. One browser-level socket multiplexes
 * per-tab sessions via `sessionId` (flat mode).
 */

/** Reject a CDP command after this long so a wedged page cannot hang a tool. */
const COMMAND_TIMEOUT_MS = 30000;

export class CdpError extends Error {
  constructor(method, payload) {
    super(`CDP ${method} failed: ${JSON.stringify(payload)}`);
    this.name = 'CdpError';
    this.method = method;
    this.payload = payload;
  }
}

export class CdpConnection {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(ws, url) {
    this.#ws = ws;
    this.url = url;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => this.#onClose());
  }

  static async connect(url, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${url}`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${url} (${event?.message ?? 'socket error'})`));
      }, { once: true });
    });
    return new CdpConnection(ws, url);
  }

  get closed() {
    return this.#closed;
  }

  #onClose() {
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error('CDP connection closed'));
    }
    this.#pending.clear();
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(entry.method, message.error));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const handlers = this.#listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message.params ?? {}, message.sessionId);
      } catch {
        /* a listener failure must not break the socket */
      }
    }
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method, handler) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(handler);
    return () => this.#listeners.get(method)?.delete(handler);
  }

  /** Send one command, optionally inside a flat session. */
  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.#nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.#pending.set(id, { resolve, reject, timer, method });
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
    this.#onClose();
  }
}
