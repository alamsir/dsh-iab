/**
 * EventBus test: the Host→client reveal channel.
 *
 * Verifies that a tool-driven browser start can pull the panel in front of the
 * user, that a late subscriber learns the current state, and that shutdown
 * closes every listener. No network, no Chromium.
 *
 *   node test/events.mjs
 */
import { EventBus } from '../src/events.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A response stand-in that records SSE frames. */
function fakeResponse() {
  const state = { statusCode: 0, headers: {}, frames: [], ended: false, listeners: {} };
  return {
    ...state,
    get frames() { return state.frames; },
    get statusCode() { return state.statusCode; },
    get ended() { return state.ended; },
    writeHead(code, headers) {
      state.statusCode = code;
      Object.assign(state.headers, headers ?? {});
    },
    write(chunk) {
      state.frames.push(String(chunk));
    },
    end() {
      state.ended = true;
    },
    on(event, handler) {
      (state.listeners[event] ??= []).push(handler);
    },
  };
}

/** Parse `data: {...}` frames out of a response's recorded writes. */
function events(res) {
  return res.frames
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

const logger = { info: () => {}, error: () => {} };

// ── Late subscriber learns the state ────────────────────────────────────────
{
  const bus = new EventBus({ logger });
  bus.setState({ running: true, endpoint: 'http://127.0.0.1:1234' });
  const res = fakeResponse();
  bus.subscribe(res);
  const first = events(res)[0];
  check('subscribe answers with an SSE content type', res.statusCode === 200 && /text\/event-stream/.test(res.headers['content-type'] ?? ''));
  check('a late subscriber immediately receives the state',
    first?.type === 'hello' && first.running === true && first.endpoint === 'http://127.0.0.1:1234',
    JSON.stringify(first ?? null));
  bus.dispose();
}

// ── Reveal reaches every listener ───────────────────────────────────────────
{
  const bus = new EventBus({ logger });
  const a = fakeResponse();
  const b = fakeResponse();
  bus.subscribe(a);
  bus.subscribe(b);
  check('both listeners are counted', bus.clientCount === 2, String(bus.clientCount));
  bus.reveal({ reason: 'tool', url: 'https://example.com' });
  const gotA = events(a).at(-1);
  const gotB = events(b).at(-1);
  check('a reveal carries the reason', gotA?.type === 'reveal' && gotA.reason === 'tool', JSON.stringify(gotA ?? null));
  check('a reveal carries the url', gotA?.url === 'https://example.com');
  check('every listener receives the reveal', gotB?.type === 'reveal');
  bus.dispose();
}

// ── Capacity is bounded ─────────────────────────────────────────────────────
{
  const bus = new EventBus({ logger });
  const accepted = [];
  for (let i = 0; i < 10; i += 1) {
    const res = fakeResponse();
    bus.subscribe(res);
    accepted.push(res);
  }
  const rejected = accepted.filter((res) => res.statusCode === 429);
  check('extra listeners are refused with 429', rejected.length > 0, `${rejected.length} rejected`);
  check('the accepted count stays bounded', bus.clientCount <= 8, String(bus.clientCount));
  bus.dispose();
}

// ── A dead listener must not break the broadcast ────────────────────────────
{
  const bus = new EventBus({ logger });
  const broken = fakeResponse();
  broken.write = () => { throw new Error('socket closed'); };
  const healthy = fakeResponse();
  bus.subscribe(broken);
  bus.subscribe(healthy);
  let threw = null;
  try {
    bus.reveal({ reason: 'tool' });
  } catch (error) {
    threw = error;
  }
  check('a broken listener does not throw out of publish', threw === null, threw?.message ?? '');
  check('a broken listener is dropped', bus.clientCount === 1, String(bus.clientCount));
  check('the healthy listener still gets the event', events(healthy).at(-1)?.type === 'reveal');
  bus.dispose();
}

// ── Dispose closes everyone ─────────────────────────────────────────────────
{
  const bus = new EventBus({ logger });
  const res = fakeResponse();
  bus.subscribe(res);
  bus.dispose();
  check('dispose ends open streams', res.ended === true);
  check('dispose clears the client set', bus.clientCount === 0, String(bus.clientCount));
  check('publishing after dispose is harmless', (() => {
    try { bus.reveal({ reason: 'tool' }); return true; } catch { return false; }
  })());
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
