/**
 * Reveal test: a tool must be able to pull the browser panel in front of the user.
 *
 * This is the end-to-end path the user asked for: a tool call starts Chromium out
 * of sight, so the Host broadcasts a `reveal` event on `/dsh-iab/api/events`, and
 * the client opens the panel — which is the only way a login wall becomes viable.
 *
 * Runs against a real Chromium but a throwaway profile, so the user's login is
 * never touched.
 *
 *   node test/reveal.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST_MODULES = 'D:/Users/fan.deng/.dsh/profiles/node_modules/@deepseek-ai';
await import(pathToFileURL(join(HOST_MODULES, 'dsh-tools', 'lib', 'index.js')).href);

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── Fake Cordis context (same shape test/apply.mjs uses) ────────────────────
const tools = new Map();
const routes = [];
const cleanups = [];
const ctx = {
  logger: { info: () => {}, error: (m) => console.error(m) },
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') cleanups.push(disposer);
    return disposer;
  },
};

/** An SSE response stand-in that records frames. */
function sseResponse() {
  const state = { statusCode: 0, headers: {}, frames: [], ended: false };
  return {
    get statusCode() { return state.statusCode; },
    get headers() { return state.headers; },
    get ended() { return state.ended; },
    get frames() { return state.frames; },
    writeHead(code, headers) { state.statusCode = code; Object.assign(state.headers, headers ?? {}); },
    write(chunk) { state.frames.push(String(chunk)); },
    end() { state.ended = true; },
    on() {},
  };
}
const eventsOf = (res) => res.frames
  .filter((frame) => frame.startsWith('data: '))
  .map((frame) => JSON.parse(frame.slice(6)));

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-iab-reveal-'));
const plugin = await import('../src/index.js');

try {
  plugin.apply(ctx, { profileDir, headed: false });

  const route = routes.find((r) => r.path === '/dsh-iab/api');
  check('the API route is registered', Boolean(route));

  // Subscribe before any tool runs: this is the user's panel already open.
  const stream = sseResponse();
  await route.handler({ method: 'GET', url: '/dsh-iab/api/events' }, stream);
  check('the event stream opens as SSE',
    stream.statusCode === 200 && /text\/event-stream/.test(stream.headers['content-type'] ?? ''),
    `${stream.statusCode} ${stream.headers['content-type'] ?? ''}`);
  const hello = eventsOf(stream)[0];
  check('a fresh subscriber is told the browser is not running', hello?.type === 'hello' && hello.running === false, JSON.stringify(hello ?? null));

  // The tool the model calls to reach a login wall.
  const open = tools.get('dsh_iab_open');
  check('dsh_iab_open is registered', Boolean(open));

  const output = await open.execute({ url: 'https://example.com/', waitMs: 800 }, {});
  check('dsh_iab_open returns a tab id', /tabId: /.test(output), output.split('\n')[0]);

  const frames = eventsOf(stream);
  const reveal = frames.find((frame) => frame.type === 'reveal');
  check('the tool broadcasts a reveal event', Boolean(reveal), JSON.stringify(reveal ?? null));
  check('the reveal says it came from a tool', reveal?.reason === 'tool', String(reveal?.reason));
  check('the reveal carries the url to show', reveal?.url === 'https://example.com/', String(reveal?.url));

  const state = frames.find((frame) => frame.type === 'state');
  check('starting the browser also broadcasts its state', Boolean(state) && state.running === true, JSON.stringify(state ?? null));

  // Ordering matters: the panel must be asked to open before the page settles,
  // otherwise the user stares at nothing while the login wall is already up.
  const revealAt = frames.findIndex((frame) => frame.type === 'reveal');
  const stateAt = frames.findIndex((frame) => frame.type === 'state');
  check('state is announced before the reveal', stateAt >= 0 && stateAt < revealAt, `state@${stateAt} reveal@${revealAt}`);

  // The panel needs a live frame feed once it is open.
  const tabId = output.match(/tabId: (\S+)/)?.[1];
  const feed = sseResponse();
  await route.handler({ method: 'GET', url: `/dsh-iab/api/stream?tabId=${tabId}` }, feed);
  const started = Date.now();
  while (Date.now() - started < 6000 && !feed.frames.some((frame) => frame.startsWith('data: '))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  check('the panel stream delivers a JPEG frame', feed.frames.some((frame) => frame.startsWith('data: {"data":"/9j/')),
    `${feed.frames.filter((f) => f.startsWith('data: ')).length} frames`);
  feed.end();
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch (error) {
      check('cleanup runs without throwing', false, error.message);
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
