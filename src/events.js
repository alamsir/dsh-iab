/**
 * dsh-iab — host→client event channel.
 *
 * The browser lives in the Host, but the user watches it in a client panel. When
 * a *tool* starts Chromium or opens a page (for example, to reach a Feishu login
 * wall), the panel must appear on its own — otherwise the user has no way to
 * scan the QR code and the tool just fails with "not logged in".
 *
 * One-way Server-Sent Events fan-out. `reveal` asks the client to open the
 * browser panel; `state` keeps late subscribers honest; `login-required` lets the
 * panel draw attention when a tool hit an authentication wall.
 */
const MAX_CLIENTS = 8;

export class EventBus {
  #clients = new Set();
  #logger;
  #running = false;
  #endpoint = null;

  constructor({ logger } = {}) {
    this.#logger = logger;
  }

  get clientCount() {
    return this.#clients.size;
  }

  /** Attach one SSE response stream to the broadcast. */
  subscribe(res) {
    if (this.#clients.size >= MAX_CLIENTS) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('too many event listeners');
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': dsh-iab events\n\n');
    } catch (error) {
      // The socket died between the request arriving and the handshake.
      this.#logger?.error?.(`dsh-iab: event subscribe failed: ${error?.message ?? error}`);
      try {
        res.end();
      } catch {
        /* already closed */
      }
      return;
    }

    // A listener that mounts *after* the browser started would otherwise sit on
    // a stale "not running" canvas, so the first frame restates the state.
    // `#write` swallows its own failure, so a dead socket here is harmless.
    this.#write(res, { type: 'hello', running: this.#running, endpoint: this.#endpoint });
    this.#clients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        this.#drop(res, heartbeat);
      }
    }, 15000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    res.on?.('close', () => this.#drop(res, heartbeat));
  }

  /** Record browser state so late subscribers get an accurate `hello`. */
  setState({ running, endpoint } = {}) {
    if (running !== undefined) this.#running = running;
    if (endpoint !== undefined) this.#endpoint = endpoint;
    this.publish('state', { running: this.#running, endpoint: this.#endpoint });
  }

  /**
   * Broadcast one event.
   *
   * @param {string} type - event name the client switches on.
   * @param {object} [payload] - JSON-serialisable detail.
   */
  publish(type, payload = {}) {
    this.#writeAll({ type, ...payload, at: Date.now() });
  }

  /**
   * Ask every client to open the browser panel.
   *
   * @param {object} detail - `reason` (`'tool'` | `'login'`) and an optional `url`.
   */
  reveal(detail = {}) {
    this.publish('reveal', detail);
  }

  #writeAll(event) {
    for (const res of [...this.#clients]) {
      if (!this.#write(res, event)) this.#drop(res, null);
    }
  }

  #write(res, event) {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch (error) {
      this.#logger?.error?.(`dsh-iab: event write failed: ${error?.message ?? error}`);
      return false;
    }
  }

  #drop(res, heartbeat) {
    if (heartbeat) clearInterval(heartbeat);
    this.#clients.delete(res);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  }

  dispose() {
    for (const res of [...this.#clients]) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    this.#clients.clear();
  }
}
