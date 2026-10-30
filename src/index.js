/**
 * dsh-iab — Host half.
 *
 * An in-app browser for DSH: one Chromium owned by the Host, rooted at a
 * persistent profile so a login survives restarts, driven over CDP. Tools let
 * the model open pages, run page JavaScript, screenshot, and convert Feishu
 * documents to Markdown; the client half mirrors the same browser as a live
 * panel (screencast + input forwarding) under `sidebar.right.pane.tab`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { defineTool } from '@deepseek-ai/dsh-tools';
import { BrowserHost, defaultProfileDir, ephemeralProfileDir, findBrowser } from './browser.js';
import { TabManager } from './tabs.js';
import {
  collectExpression,
  collectorSource,
  isFeishuUrl,
  readFeishuDocument,
  suggestedFilename,
  toDocument,
} from './feishu.js';
import { ScreencastHub } from './screencast.js';
import { EventBus } from './events.js';

export const name = 'dsh-iab';
/**
 * Required Host services.
 *
 * Only `tools` is hard-required: the agent-facing tools are the part that must
 * exist everywhere. `webServer` (the HTTP surface for the side panel) and
 * `connection` (the browser-trust fence) are resolved through dynamic injection
 * instead. Cordis refuses to resolve an *undeclared* service, so a hard
 * `inject: ['webServer']` would leave this entry permanently `pending` in any
 * profile that does not compose a web server — and DSH reports a non-activated
 * entry as a boot failure.
 */
export const inject = ['tools'];

/**
 * Settings schema. Only `.volatile()` fields are projected into the settings
 * page; the value handed to `apply` is a wrapper, so every read goes through
 * `readConfig` below.
 *
 * schemastery is resolved with `createRequire` instead of a static import: it is
 * an optional peer, and this keeps module evaluation synchronous (a top-level
 * await here would turn the whole plugin into an async module for the loader).
 */
function loadSchema() {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@deepseek-ai/schemastery');
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

const Schema = loadSchema();

let Config;
if (Schema && typeof Schema.object === 'function') {
  Config = Schema.object({
    chromePath: Schema.string()
      .description('Chromium executable. Leave empty to auto-detect (a dedicated Playwright build is preferred).')
      .default('')
      .volatile(),
    profileDir: Schema.string()
      .description('Profile directory for the plugin\'s own browser. Defaults to <dsh home>/dsh-iab/chrome-profile.')
      .default('')
      .volatile(),
    headed: Schema.boolean()
      .description('Show a real browser window. Off by default: the panel mirrors the page without touching your desktop.')
      .default(false)
      .volatile(),
    outDir: Schema.string()
      .description('Directory for saved Markdown/screenshots. Defaults to <cwd>/prd-input.')
      .default('')
      .volatile(),
  });
}
export { Config };

/** Read a schema-built config value, unwrapping volatile fields. */
function readConfig(config, key, fallback) {
  const value = config?.[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value.get === 'function') {
    const inner = value.get();
    return inner === undefined || inner === null ? fallback : inner;
  }
  return value;
}

/** dsh home, falling back to the platform default. */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

const text = (value) => [{ type: 'text', text: value }];

/** Resolve a workspace-relative output directory to an absolute one. */
function resolveOutDir(config, exec) {
  const configured = readConfig(config, 'outDir', '');
  return configured && String(configured).trim() !== ''
    ? resolve(String(configured))
    : join(exec?.cwd ?? process.cwd(), 'prd-input');
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const configuredChrome = readConfig(config, 'chromePath', '');
  const resolved = findBrowser(configuredChrome || undefined);
  const configuredProfile = readConfig(config, 'profileDir', '');
  const profileDir = configuredProfile && String(configuredProfile).trim() !== ''
    ? resolve(String(configuredProfile))
    : defaultProfileDir(dshHome());

  const browser = new BrowserHost({
    binary: resolved?.path ?? null,
    dedicated: resolved?.dedicated ?? false,
    profileDir,
    // Headless by default: the user watches the page through the plugin's own
    // panel, so no extra window pops up and nothing steals focus from their work.
    headed: readConfig(config, 'headed', false) === true,
    logger,
  });
  const tabs = new TabManager({ logger });
  const hub = new ScreencastHub({ logger });
  const events = new EventBus({ logger });

  /** Start (or adopt) the browser + CDP connection. Idempotent. */
  async function ensure() {
    const endpoint = await browser.ensureStarted();
    if (!tabs.connected) {
      await tabs.connect(endpoint);
      await tabs.adoptExisting();
      // Tell anyone already watching that the browser exists now.
      events.setState({ running: true, endpoint });
    }
    return { endpoint, tabs };
  }

  /**
   * Open the browser panel on the user's screen.
   *
   * Tools run out of sight: `dsh_iab_open` starting Chromium is invisible unless
   * the client is told to surface the panel. Every tool that produces something
   * the user must *look at* — a login wall above all — calls this first.
   *
   * @param {object} [detail] - `reason` and the `url` the panel should show.
   */
  function revealBrowser(detail = {}) {
    events.reveal({ reason: 'tool', ...detail });
  }

  /** A tab for the caller: the requested one, else the most recent, else a new blank one. */
  async function tabFor(tabId) {
    await ensure();
    if (tabId) return { tabId, tab: tabs.get(tabId) };
    const known = tabs.list();
    if (known.length === 0) {
      const opened = await tabs.open('about:blank');
      return { tabId: opened.tabId, tab: tabs.get(opened.tabId) };
    }
    const tab = tabs.latest();
    const entry = tabs.list().find((t) => t.url === tab.url && t.title === tab.title);
    return { tabId: entry?.tabId, tab };
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'dsh_iab_status',
    description:
      'Report the state of the DSH in-app browser: whether Chromium is running, its executable and profile '
      + 'directory, how many tabs are open, and whether the persistent profile looks logged in. Call this first '
      + 'when a browser task fails so you can tell "not started" from "not logged in".',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute() {
      const lines = [];
      lines.push(`binary: ${resolved?.path ?? '(not found)'}${resolved?.dedicated ? ' (dedicated chromium)' : ''}`);
      lines.push(`profile: ${profileDir}`);
      lines.push(`headed: ${browser.headed}`);
      lines.push(`running: ${browser.running}`);
      if (browser.running) {
        await ensure().catch((error) => lines.push(`connect error: ${error.message}`));
        lines.push(`endpoint: ${browser.endpoint}`);
        for (const tab of tabs.list()) lines.push(`tab ${tab.tabId}: ${tab.title || '(untitled)'} — ${tab.url}`);
      }
      lines.push(`screencast clients: ${hub.clientCount}`);
      return lines.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_iab_open',
    description:
      'Open a URL in the DSH in-app browser and return the resulting tab id. Chromium starts on first use with a '
      + 'persistent profile, so a Feishu/SSO login performed once stays valid across DSH restarts. '
      + 'This also pops the browser panel open on the user\'s screen, so when you land on a login wall you can ask '
      + 'them to sign in there. Use this before dsh_iab_read, dsh_iab_eval, or dsh_iab_screenshot.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      waitMs: { type: 'number', description: 'Extra settle time after load, milliseconds (default 1500).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args) {
      if (!/^https?:\/\//i.test(args.url)) throw new Error('url must start with http:// or https://');
      await ensure();
      // Reveal before navigating: the panel should already be on screen while the
      // page (and its QR code) loads, not after.
      revealBrowser({ url: args.url });
      const opened = await tabs.open(args.url);
      await new Promise((r) => setTimeout(r, Number.isFinite(args.waitMs) ? args.waitMs : 1500));
      const tab = tabs.get(opened.tabId);
      const identity = await tab.refreshIdentity();
      return `tabId: ${opened.tabId}\ntitle: ${identity.title}\nurl: ${identity.url}`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_iab_eval',
    description:
      'Evaluate a JavaScript expression inside a page of the DSH in-app browser and return its value as JSON. '
      + 'The expression runs in the page origin with the user\'s cookies, so it can read logged-in content. '
      + 'Wrap multi-statement scripts in an IIFE that returns a JSON-serialisable value.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate.' },
      tabId: { type: 'string', description: 'Tab id from dsh_iab_open; defaults to the most recently used tab.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args) {
      const { tab } = await tabFor(args.tabId);
      const value = await tab.evaluate(args.expression);
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_iab_read',
    description:
      'Read the visible text of a page in the DSH in-app browser as Markdown-ish plain text, optionally scrolling '
      + 'to load more. Use it for ordinary articles and docs; prefer dsh_iab_feishu for Feishu documents, whose '
      + 'virtual scrolling needs the dedicated walker.',
    parameters: {
      tabId: { type: 'string', description: 'Tab id; defaults to the most recently used tab.' },
      selector: { type: 'string', description: 'CSS selector of the container to read (default: main content heuristics).' },
      maxChars: { type: 'number', description: 'Truncate the result to this many characters (default 40000).' },
      scrollPasses: { type: 'number', description: 'How many extra scroll steps to trigger lazy rendering (default 0).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args) {
      const { tab } = await tabFor(args.tabId);
      const passes = Number.isFinite(args.scrollPasses) ? Math.max(0, Math.min(20, args.scrollPasses)) : 0;
      for (let i = 0; i < passes; i += 1) {
        await tab.send('Runtime.evaluate', {
          expression: `window.scrollBy(0, Math.floor(innerHeight * 0.85)); JSON.stringify({y: scrollY})`,
          returnByValue: true,
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 350));
      }
      const selector = args.selector ? JSON.stringify(args.selector) : 'null';
      const expression = `(function(){
        var sel = ${selector};
        var root = sel ? document.querySelector(sel) : (document.querySelector('main, article, [role=main]') || document.body);
        if (!root) return JSON.stringify({error: 'selector matched nothing'});
        var text = (root.innerText || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
        return JSON.stringify({title: document.title, url: location.href, length: text.length, text: text});
      })()`;
      const raw = await tab.evaluate(expression);
      const parsed = JSON.parse(raw);
      if (parsed.error) throw new Error(parsed.error);
      const limit = Number.isFinite(args.maxChars) && args.maxChars > 0 ? args.maxChars : 40000;
      const body = parsed.text.length > limit ? `${parsed.text.slice(0, limit)}\n\n…[truncated ${parsed.text.length - limit} chars]` : parsed.text;
      return `# ${parsed.title}\n${parsed.url}\n\n${body}`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_iab_feishu',
    description:
      'Read a Feishu (飞书) document — /docx/, /wiki/, /docs/ — from the DSH in-app browser and save it as Markdown. '
      + 'Handles Feishu virtual scrolling by sweeping the page in both directions; images and boards become '
      + 'placeholders. Requires an existing Feishu login in the in-app browser profile.',
    parameters: {
      url: { type: 'string', description: 'Feishu document URL. Omit to reuse the current tab.' },
      outDir: { type: 'string', description: 'Output directory (default: <cwd>/prd-input).' },
      settleMs: { type: 'number', description: 'Per-step settle delay in milliseconds (default 400).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      await ensure();
      let tabId;
      let tab;
      if (args.url) {
        // Surface the panel before the page loads: this is the tool most likely
        // to hit a login wall, and the user has to see it to act on it.
        revealBrowser({ url: args.url });
        const opened = await tabs.open(args.url);
        tabId = opened.tabId;
        tab = tabs.get(tabId);
        await new Promise((r) => setTimeout(r, 2500));
      } else {
        ({ tab } = await tabFor(undefined));
        tabId = tabs.list().find((t) => t.url === tab.url)?.tabId;
      }
      const current = await tab.refreshIdentity();
      if (!isFeishuUrl(current.url)) throw new Error(`not a Feishu page: ${current.url}`);
      const probe = await tab.evaluate(`JSON.stringify({login: !!document.querySelector('.bear-web-x-container'), title: document.title})`);
      const state = JSON.parse(probe);
      if (!state.login) {
        // Ask the client to draw attention to the panel: the user must scan a QR
        // code or sign in, and a quietly-failing tool would leave them stuck.
        revealBrowser({ url: current.url, reason: 'login' });
        throw new Error(
          `Feishu document container not found on "${state.title}". The in-app browser profile is probably not `
          + 'logged in. The browser panel has been opened for you — sign in there, then retry.',
        );
      }
      const doc = await readFeishuDocument(tab, {
        settleMs: Number.isFinite(args.settleMs) ? args.settleMs : 400,
      });
      const outDir = args.outDir ? resolve(String(args.outDir)) : resolveOutDir(config, exec);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, suggestedFilename(doc.title));
      writeFileSync(file, toDocument({ title: doc.title, markdown: doc.markdown, url: current.url }), 'utf8');
      return [
        `saved: ${file}`,
        `title: ${doc.title}`,
        `blocks: ${doc.blocks}`,
        `chars: ${doc.markdown.length}`,
        `placeholders: ${doc.placeholders}`,
        `tab: ${tabId ?? '(current)'}`,
      ].join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_iab_screenshot',
    description:
      'Capture a PNG screenshot of a page in the DSH in-app browser and save it under the workspace. Useful when '
      + 'the layout or a canvas-rendered element matters and text extraction is not enough.',
    parameters: {
      tabId: { type: 'string', description: 'Tab id; defaults to the most recently used tab.' },
      outPath: { type: 'string', description: 'File path to write (default: <cwd>/dsh-iab-shot-<timestamp>.png).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const { tab } = await tabFor(args.tabId);
      const data = await tab.screenshot({ format: 'png' });
      const target = args.outPath && String(args.outPath).trim() !== ''
        ? resolve(String(args.outPath))
        : join(exec?.cwd ?? process.cwd(), `dsh-iab-shot-${Date.now()}.png`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(data, 'base64'));
      return `saved: ${target}`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'dsh_iab_tabs',
    description: 'List the tabs currently open in the DSH in-app browser, and close them.',
    parameters: {
      close: { type: 'string', description: 'Tab id to close instead of listing.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args) {
      if (args.close) {
        await ensure();
        await tabs.close(args.close);
        return `closed: ${args.close}`;
      }
      if (!browser.running) return 'browser not running (no tabs)';
      await ensure();
      const list = tabs.list();
      if (list.length === 0) return 'no tabs open';
      return list.map((t) => `${t.tabId}\t${t.title || '(untitled)'}\t${t.url}`).join('\n');
    },
  }));

  // ── HTTP surface for the client panel ──────────────────────────────────────

  // Both services used here are UI-profile extras, so neither is a hard inject:
  // a static `inject` for a service the profile never composes leaves the entry
  // `pending` — which DSH counts as a failed boot. Resolve them dynamically and
  // skip the route when there is no web server to serve it from.
  let connectionApi = null;
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['connection'], (scope) => {
        connectionApi = scope?.connection ?? null;
      });
    }
  } catch {
    /* no connection service: serve the route unfenced (loopback only) */
  }

  const registerRoutes = (webServer) => {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/dsh-iab/api',
      handler: async (req, res) => {
        const rejection = connectionApi?.requestRejection?.(req);
        if (rejection !== undefined) {
          res.writeHead(rejection);
          res.end();
          return;
        }
        const url = new URL(req.url ?? '/', 'http://dsh.local');
        const route = url.pathname.replace(/^\/dsh-iab\/api/, '').replace(/\/+$/, '') || '/';
        const json = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        try {
          if (route === '/status' && req.method === 'GET') {
            json(200, {
              binary: resolved?.path ?? null,
              dedicated: resolved?.dedicated ?? false,
              profile: profileDir,
              headed: browser.headed,
              running: browser.running,
              endpoint: browser.endpoint,
              tabs: browser.running ? tabs.list() : [],
              // The tab a client should focus: the Host knows which page it just
              // navigated, so the panel does not have to guess.
              activeTabId: browser.running ? tabs.activeTabId : null,
              // How many panels are listening for reveal events. Non-zero means a
              // client is actually attached, which is what makes a tool-triggered
              // reveal visible to the user.
              eventClients: events.clientCount,
            });
            return;
          }
          if (route === '/reveal' && req.method === 'POST') {
            // Summon the panel explicitly. Tools broadcast this already; the route
            // exists so a client (or a script) can re-surface it on demand.
            const body = await readJson(req).catch(() => ({}));
            events.reveal({ reason: 'manual', ...(body.url ? { url: String(body.url) } : {}) });
            json(200, { ok: true, listeners: events.clientCount });
            return;
          }
          if (route === '/events' && req.method === 'GET') {
            // Long-lived channel: the Host tells the client when to surface the
            // browser panel (a tool started Chromium, or a login is required).
            events.subscribe(res);
            return;
          }
          if (route === '/start' && req.method === 'POST') {
            await ensure();
            json(200, { ok: true, endpoint: browser.endpoint, tabs: tabs.list() });
            return;
          }
          if (route === '/open' && req.method === 'POST') {
            const body = await readJson(req);
            if (!/^https?:\/\//i.test(String(body.url ?? ''))) throw new Error('url must be http(s)');
            await ensure();
            const opened = await tabs.open(String(body.url));
            json(200, opened);
            return;
          }
          if (route === '/tabs' && req.method === 'GET') {
            json(200, { tabs: browser.running ? tabs.list() : [] });
            return;
          }
          if (route === '/stream' && req.method === 'GET') {
            const tabId = url.searchParams.get('tabId') ?? undefined;
            await ensure();
            const { tab } = await tabFor(tabId);
            hub.attach(res, tab);
            return;
          }
          if (route === '/input' && req.method === 'POST') {
            const body = await readJson(req);
            await ensure();
            const { tab } = await tabFor(body.tabId);
            await forwardInput(tab, body);
            json(200, { ok: true });
            return;
          }
          if (route === '/navigate' && req.method === 'POST') {
            const body = await readJson(req);
            await ensure();
            const { tab } = await tabFor(body.tabId);
            const result = await tab.navigate(String(body.url));
            json(200, result);
            return;
          }
          json(404, { error: `unknown route ${route}` });
        } catch (error) {
          logger.error?.(`dsh-iab: ${route} failed: ${error?.message ?? error}`);
          json(500, { error: String(error?.message ?? error) });
        }
      },
    }), 'dsh-iab: browser api');
  };

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        if (scope?.webServer?.register) registerRoutes(scope.webServer);
      });
    } else if (ctx.webServer?.register) {
      registerRoutes(ctx.webServer);
    }
  } catch (error) {
    // No web server means no side panel; the agent tools still work.
    logger.info?.(`dsh-iab: no web server, side panel disabled (${error?.message ?? error})`);
  }

  // Browser shutdown must flush the profile, or the next launch can lose cookies.
  ctx.effect(() => () => {
    hub.dispose();
    events.dispose();
    // `tabs.connection` throws when nothing was ever started, which is a normal
    // shutdown path — only a live connection can be asked to close the browser.
    const connection = tabs.connected ? tabs.connection : null;
    tabs.detach();
    if (browser.running) void browser.stop(connection).catch(() => {});
  }, 'dsh-iab: shutdown');
}

/** Read a small JSON request body. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

/**
 * Translate a client pointer/key event into CDP input. Coordinates arrive in
 * CSS pixels relative to the screencast bitmap, which matches the page viewport
 * because the panel mirrors `Page.captureScreenshot` at the same size.
 */
async function forwardInput(tab, body) {
  const type = String(body.type ?? '');
  if (type === 'mouse') {
    const buttons = body.button === 'right' ? 2 : body.button === 'middle' ? 4 : 1;
    await tab.send('Input.dispatchMouseEvent', {
      type: body.action === 'down' ? 'mousePressed' : body.action === 'up' ? 'mouseReleased' : 'mouseMoved',
      x: Number(body.x ?? 0),
      y: Number(body.y ?? 0),
      button: body.button === 'right' ? 'right' : body.button === 'middle' ? 'middle' : 'left',
      buttons: body.action === 'up' ? 0 : buttons,
      clickCount: body.action === 'move' ? 0 : 1,
      modifiers: Number(body.modifiers ?? 0),
    });
    return;
  }
  if (type === 'wheel') {
    await tab.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Number(body.x ?? 0),
      y: Number(body.y ?? 0),
      deltaX: Number(body.deltaX ?? 0),
      deltaY: Number(body.deltaY ?? 0),
    });
    return;
  }
  if (type === 'key') {
    const key = String(body.key ?? '');
    if (body.action === 'char') {
      await tab.send('Input.insertText', { text: key });
      return;
    }
    await tab.send('Input.dispatchKeyEvent', {
      type: body.action === 'down' ? 'keyDown' : 'keyUp',
      key,
      code: String(body.code ?? key),
      windowsVirtualKeyCode: Number(body.keyCode ?? 0),
      modifiers: Number(body.modifiers ?? 0),
    });
    return;
  }
  if (type === 'scroll') {
    const sign = body.direction === 'up' ? -1 : 1;
    await tab.evaluate(`window.scrollBy(0, ${sign * Number(body.amount ?? 600)}); JSON.stringify({y: scrollY})`);
    return;
  }
  throw new Error(`unknown input type "${type}"`);
}

export const __internals = {
  collectorSource,
  collectExpression,
  isFeishuUrl,
  suggestedFilename,
  ephemeralProfileDir,
};
