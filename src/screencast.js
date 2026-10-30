/**
 * dsh-iab — screencast fan-out.
 *
 * `Page.startScreencast` emits JPEG frames only while at least one consumer is
 * attached, so the hub keeps one CDP subscription per tab and broadcasts each
 * frame to every connected panel over Server-Sent Events. Frames are base64,
 * which SSE carries without escaping.
 */
const MAX_CLIENTS = 4;

export class ScreencastHub {
  #clients = new Set();
  #tabs = new Map(); // tabId-ish key -> { tab, unsubscribe }
  #logger;

  constructor({ logger } = {}) {
    this.#logger = logger;
  }

  get clientCount() {
    return this.#clients.size;
  }

  /** Attach one SSE response stream to a tab, starting its screencast if needed. */
  attach(res, tab) {
    if (this.#clients.size >= MAX_CLIENTS) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('too many browser viewers');
      return;
    }
    const key = tab.sessionId;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': dsh-iab screencast\n\n');

    const client = { res, tab, key };
    this.#clients.add(client);
    void this.#start(key, tab);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        this.#detach(client, heartbeat);
      }
    }, 15000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    res.on?.('close', () => this.#detach(client, heartbeat));
  }

  #detach(client, heartbeat) {
    clearInterval(heartbeat);
    this.#clients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already closed */
    }
    // Stop the CDP stream when the last viewer of that tab leaves.
    if (![...this.#clients].some((c) => c.key === client.key)) {
      const entry = this.#tabs.get(client.key);
      if (entry) {
        this.#tabs.delete(client.key);
        entry.unsubscribe?.();
        void entry.tab.send('Page.stopScreencast').catch(() => {});
      }
    }
  }

  async #start(key, tab) {
    if (this.#tabs.has(key)) return;
    const entry = { tab, unsubscribe: null };
    this.#tabs.set(key, entry);
    entry.unsubscribe = tab.manager.connection.on('Page.screencastFrame', (params, sessionId) => {
      if (sessionId !== tab.sessionId) return;
      const payload = JSON.stringify({
        data: params.data,
        metadata: params.metadata ?? {},
      });
      for (const client of this.#clients) {
        if (client.key !== key) continue;
        try {
          client.res.write(`data: ${payload}\n\n`);
        } catch {
          /* the close handler tidies up */
        }
      }
      void tab.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    });
    try {
      await tab.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 62,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      });
    } catch (error) {
      this.#logger?.error?.(`dsh-iab: screencast failed: ${error?.message ?? error}`);
    }
  }

  dispose() {
    for (const client of [...this.#clients]) {
      try {
        client.res.end();
      } catch {
        /* already closed */
      }
    }
    this.#clients.clear();
    for (const [, entry] of this.#tabs) {
      entry.unsubscribe?.();
      void entry.tab.send('Page.stopScreencast').catch(() => {});
    }
    this.#tabs.clear();
  }
}
