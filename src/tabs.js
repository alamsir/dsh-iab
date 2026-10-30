/**
 * dsh-iab — tab (target) management over one CDP connection.
 *
 * Every tab gets its own flat session, so commands do not cross-talk. Tabs are
 * addressed by a stable, agent-friendly `tabId` (a short slug) rather than the
 * raw 32-hex CDP target id.
 */
import { CdpConnection } from './cdp.js';

/** Wait until the document reports a ready state, or the deadline passes. */
async function waitForReady(session, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { result } = await session.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (result?.value === 'complete' || result?.value === 'interactive') return result.value;
    } catch {
      /* navigation in flight invalidates the context; retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'timeout';
}

/** One attached page. */
class TabSession {
  constructor(manager, targetId, sessionId, info = {}) {
    this.manager = manager;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.tabId = null; // assigned by the manager once registered
    this.url = info.url ?? 'about:blank';
    this.title = info.title ?? '';
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
  }

  send(method, params = {}) {
    this.lastUsedAt = Date.now();
    return this.manager.connection.send(method, params, this.sessionId);
  }

  /** Evaluate an expression in the page and return the by-value result. */
  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const options = {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    };
    if (timeoutMs) options.timeout = timeoutMs;
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', options);
    if (exceptionDetails) {
      const detail = exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluation failed';
      throw new Error(`page script error: ${detail}`);
    }
    return result?.value;
  }

  async navigate(url) {
    await this.send('Page.enable').catch(() => {});
    await this.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 300));
    await waitForReady(this);
    this.url = url;
    await this.refreshIdentity();
    return { url: this.url, title: this.title };
  }

  async refreshIdentity() {
    try {
      const value = await this.evaluate('JSON.stringify({url: location.href, title: document.title})');
      const parsed = JSON.parse(value);
      this.url = parsed.url ?? this.url;
      this.title = parsed.title ?? this.title;
    } catch {
      /* about:blank or a cross-origin transition */
    }
    return { url: this.url, title: this.title };
  }

  async screenshot({ format = 'png', quality } = {}) {
    const params = { format };
    if (format === 'jpeg' && quality) params.quality = quality;
    const { data } = await this.send('Page.captureScreenshot', params);
    return data;
  }

  /**
   * Scroll the page (or its main inner scroller) by a fraction of the viewport.
   *
   * Feishu renders into a nested `overflow:auto` container; ordinary pages use
   * the document scroller. Both are reported in the same shape so a walker can
   * stop on `atEnd` without knowing which kind of page it is on.
   */
  scroll({ direction = 'down', step = 0.85 } = {}) {
    const sign = direction === 'up' ? -1 : 1;
    const expression = `(function(){
      var inner = document.querySelector('.bear-web-x-container')
        || Array.prototype.find.call(document.querySelectorAll('*'), function(e){
             return e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY);
           });
      var useInner = !!inner && inner.scrollHeight > inner.clientHeight + 1;
      var el = useInner ? inner : (document.scrollingElement || document.documentElement);
      var before = useInner ? el.scrollTop : (window.scrollY || el.scrollTop || 0);
      var viewport = useInner ? el.clientHeight : (window.innerHeight || el.clientHeight);
      var total = useInner ? el.scrollHeight : Math.max(el.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (useInner) el.scrollTop = before + ${sign} * Math.floor(viewport * ${Number(step)});
      else window.scrollTo(0, before + ${sign} * Math.floor(viewport * ${Number(step)}));
      var after = useInner ? el.scrollTop : (window.scrollY || el.scrollTop || 0);
      return JSON.stringify({
        ok: true,
        inner: useInner,
        top: after,
        height: total,
        clientHeight: viewport,
        moved: after !== before,
        atEnd: after + viewport >= total - 5,
        atStart: after <= 5
      });
    })()`;
    return this.evaluate(expression).then((raw) => JSON.parse(raw));
  }
}

export class TabManager {
  #connection = null;
  #tabs = new Map(); // tabId -> TabSession
  #byTarget = new Map(); // targetId -> tabId
  #seq = 0;
  #logger;

  constructor({ logger } = {}) {
    this.#logger = logger;
  }

  get connection() {
    if (this.#connection === null) throw new Error('dsh-iab: not connected');
    return this.#connection;
  }

  get connected() {
    return this.#connection !== null && !this.#connection.closed;
  }

  async connect(endpoint) {
    if (this.connected) return;
    const info = await (await fetch(`${endpoint}/json/version`)).json();
    this.#connection = await CdpConnection.connect(info.webSocketDebuggerUrl);
    this.#connection.on('Target.targetDestroyed', ({ targetId }) => this.#dropTarget(targetId));
    this.#connection.on('Target.targetInfoChanged', ({ targetInfo }) => {
      const tabId = this.#byTarget.get(targetInfo.targetId);
      const tab = tabId && this.#tabs.get(tabId);
      if (tab) {
        tab.url = targetInfo.url ?? tab.url;
        tab.title = targetInfo.title ?? tab.title;
      }
    });
    this.#logger?.info?.(`dsh-iab: CDP connected (${info.Browser ?? 'chromium'})`);
  }

  #dropTarget(targetId) {
    const tabId = this.#byTarget.get(targetId);
    if (!tabId) return;
    this.#byTarget.delete(targetId);
    this.#tabs.delete(tabId);
  }

  #slug() {
    this.#seq += 1;
    return `tab${this.#seq}`;
  }

  async #attach(targetId, info = {}) {
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new TabSession(this, targetId, sessionId, info);
    await tab.send('Runtime.enable').catch(() => {});
    await tab.send('Page.enable').catch(() => {});
    await tab.refreshIdentity();
    const tabId = this.#slug();
    this.#tabs.set(tabId, tab);
    this.#byTarget.set(targetId, tabId);
    return { tabId, tab };
  }

  /** Import every existing page target so a restarted DSH adopts the open tabs. */
  async adoptExisting() {
    const { targetInfos } = await this.connection.send('Target.getTargets');
    for (const info of targetInfos ?? []) {
      if (info.type !== 'page') continue;
      if (this.#byTarget.has(info.targetId)) continue;
      try {
        await this.#attach(info.targetId, info);
      } catch {
        /* an unresponsive page must not break adoption */
      }
    }
    return this.list();
  }

  list() {
    // `active` mirrors `latest()` so a client can open the tab the Host considers
    // current instead of guessing with `tabs[0]` (which is usually the blank tab
    // Chromium opens for itself).
    const activeId = this.activeTabId;
    return [...this.#tabs.entries()].map(([tabId, tab]) => ({
      tabId,
      url: tab.url,
      title: tab.title,
      active: tabId === activeId,
    }));
  }

  /** The most recently used tab's id, or `undefined` when nothing is open. */
  get activeTabId() {
    let best = null;
    for (const [tabId, tab] of this.#tabs) {
      if (!best || tab.lastUsedAt > best.tab.lastUsedAt) best = { tabId, tab };
    }
    return best?.tabId;
  }

  get(tabId) {
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error(`dsh-iab: unknown tab "${tabId}" (have: ${[...this.#tabs.keys()].join(', ') || 'none'})`);
    return tab;
  }

  async open(url) {
    const { targetId } = await this.connection.send('Target.createTarget', { url: 'about:blank' });
    const { tabId, tab } = await this.#attach(targetId, { url: 'about:blank' });
    if (url) await tab.navigate(url);
    return { tabId, url: tab.url, title: tab.title };
  }

  async close(tabId) {
    const tab = this.get(tabId);
    await this.connection.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    this.#dropTarget(tab.targetId);
  }

  /** The most recently used tab, used when the caller omits `tabId`. */
  latest() {
    let best = null;
    for (const [tabId, tab] of this.#tabs) {
      if (!best || tab.lastUsedAt > best.tab.lastUsedAt) best = { tabId, tab };
    }
    if (!best) throw new Error('dsh-iab: no tabs open; call dsh_iab_open first');
    return best.tab;
  }

  detach() {
    this.#connection?.close();
    this.#connection = null;
    this.#tabs.clear();
    this.#byTarget.clear();
  }
}
