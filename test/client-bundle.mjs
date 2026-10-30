/**
 * Client-half test: evaluate `client/client.js` the way the browser module
 * loader does, then run `apply()` against a mock React-root ctx.
 *
 * The mock reproduces the Cordis behaviour that broke DSH 0.2.1-rc.3: reading an
 * *undeclared* service THROWS instead of returning undefined. A test that only
 * checks "the bundle downloads" cannot catch that; this one actually executes it.
 *
 *   node test/client-bundle.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'client', 'client.js');
const PKG_NAME = 'dsh-iab';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── Minimal React stand-in ──────────────────────────────────────────────────
// Components are never rendered; only createElement/useState/useEffect are
// touched while `apply` wires registrations.
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
};

// ── Browser-ish globals the bundle expects ──────────────────────────────────
const head = { children: [], appendChild(node) { this.children.push(node); } };
/** Every EventSource the bundle opened, so tests can push events into it. */
const sources = [];
const sandbox = {
  React,
  console,
  window: {},
  document: {
    head,
    getElementById: () => null,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
  },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  EventSource: class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onmessage = null;
      this.onerror = null;
      sources.push(this);
    }
    /** Test hook: deliver one SSE message. */
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
    close() {
      this.closed = true;
    }
  },
  setTimeout,
  clearTimeout,
  URL,
};
sandbox.window.__ModuleLoader__ = {
  load({ id, factory }) {
    sandbox.__registered = { id, factory };
  },
};
sandbox.globalThis = sandbox;

const source = readFileSync(BUNDLE, 'utf8');
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: 'client.js' });

// ── Loader contract ─────────────────────────────────────────────────────────
check('bundle registers exactly one factory', Boolean(sandbox.__registered));
const registered = sandbox.__registered;
check('factory id equals the package name', registered?.id === PKG_NAME, String(registered?.id));

const requireShim = (name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement };
  throw new Error(`unexpected require("${name}") — must be listed in dsh.client.external`);
};
const plugin = registered.factory(requireShim);
check('factory returns a plugin object', Boolean(plugin && typeof plugin.apply === 'function'));
check('plugin declares a name', typeof plugin.name === 'string', plugin.name);
check('plugin declares inject', Array.isArray(plugin.inject), JSON.stringify(plugin.inject));

// ── Cordis-faithful ctx ─────────────────────────────────────────────────────
/**
 * Build a host context whose undeclared-service reads throw, exactly like
 * Cordis's fiber scope. `available` names the services this fake host ships;
 * `declared` is the plugin's static `inject` list.
 *
 * @returns {{ ctx: object, state: { slots: object[], tabs: object[], injected: string[] }, warnings: string[] }}
 */
function makeHost(declared, available) {
  const state = { slots: [], tabs: [], injected: [], revealed: [] };
  const warnings = [];
  const record = (name) => {
    if (available.has(name)) return true;
    // Cordis: "cannot get property X without inject"
    throw new Error(`cannot get property "${name}" without inject`);
  };

  const services = {
    slots: {
      inject: (name, cb) => { state.injected.push(name); return cb(); },
      register: (options, Component) => { state.slots.push({ options, Component }); return () => {}; },
    },
    locale: { register: () => () => {} },
    sidebarRightTabs: {
      register: (definition) => { state.tabs.push(definition); return () => {}; },
    },
    sidebarRight: {
      // The real controller opens a tab of `kind`; recording the call is enough
      // to prove the reveal channel reached the right service.
      openTab: (kind, options) => { state.revealed.push({ kind, options }); },
    },
  };

  const base = {
    effect: (fn) => fn(),
    inject: (names, cb) => {
      // Dynamic injection: the scope carries only what the host actually ships.
      const scope = {};
      for (const name of names) {
        if (available.has(name)) scope[name] = services[name];
      }
      if (Object.keys(scope).length > 0) cb(scope);
    },
  };

  const ctx = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      // A declared service resolves through the scope; anything else throws.
      if (available.has(key)) return services[key];
      void record(key);
      return undefined;
    },
  });

  // Route warnings into a buffer so a noisy-but-correct degrade is visible.
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  const restore = () => { console.warn = originalWarn; };

  return { ctx, state, warnings, restore };
}

/** Run `apply` and report whether it threw. */
function run(host) {
  let error = null;
  try {
    plugin.apply(host.ctx);
  } catch (e) {
    error = e;
  } finally {
    host.restore();
  }
  return error;
}

const expectServices = (...names) => new Set(names);

// Case 1: full desktop-like host — the real DSH 0.2.1-rc.3 shape.
{
  sources.length = 0;
  const host = makeHost(plugin.inject, expectServices('slots', 'locale', 'sidebarRightTabs', 'sidebarRight'));
  const error = run(host);
  check('apply() succeeds on a full host', error === null, error?.message ?? '');
  check('registers the sidebar tab type', host.state.tabs.length === 1, `${host.state.tabs.length} tabs`);
  check('registers the browser body and title slots', host.state.injected.includes('sidebar.right.pane.tab'), host.state.injected.join(', '));
  check('registers the settings section', host.state.slots.some((s) => s.options.name === 'settings.section'));
  check('tab type carries a guide entry', Array.isArray(host.state.tabs[0]?.guide) && host.state.tabs[0].guide.length === 1);

  // The reveal channel: a tool that starts Chromium out of sight must be able to
  // pull the panel in front of the user. Without this the login wall is invisible.
  check('opens the host event channel', sources.length === 1, `${sources.length} listeners`);
  check('event channel points at the plugin route', sources[0]?.url === '/dsh-iab/api/events', String(sources[0]?.url));

  sources[0]?.emit({ type: 'reveal', reason: 'tool', url: 'https://example.com' });
  check('a reveal event opens the browser tab type',
    host.state.revealed.length === 1 && host.state.revealed[0].kind === 'dsh-iab',
    JSON.stringify(host.state.revealed[0] ?? null));

  // Unrelated events must not yank the panel open on every state tick.
  const before = host.state.revealed.length;
  sources[0]?.emit({ type: 'state', running: true });
  sources[0]?.emit({ type: 'hello', running: true });
  check('state events do not open the panel', host.state.revealed.length === before);
}

// Case 2: the regression that broke DSH. The plugin must never *read* an
// undeclared service; this host ships only slots + locale.
{
  const host = makeHost(plugin.inject, expectServices('slots', 'locale'));
  const error = run(host);
  check('apply() succeeds when sidebarRightTabs is absent', error === null, error?.message ?? '');
  check('missing sidebar does not prevent the settings section',
    host.state.slots.some((s) => s.options.name === 'settings.section'),
    `${host.state.slots.length} slots registered`);
  check('no static inject of a missing service', !plugin.inject.includes('sidebarRightTabs'));
}

// Case 2b: tab registry present but no navigation controller — the panel can be
// registered, yet nothing can reveal it. Must not throw.
{
  sources.length = 0;
  const host = makeHost(plugin.inject, expectServices('slots', 'locale', 'sidebarRightTabs'));
  const error = run(host);
  check('apply() succeeds without the sidebarRight controller', error === null, error?.message ?? '');
  check('no event channel is opened without a controller', sources.length === 0, `${sources.length} listeners`);
}

// Case 3: a host whose slots service throws must still not fail the entry.
{
  const host = makeHost(plugin.inject, expectServices('slots', 'locale', 'sidebarRightTabs'));
  host.ctx.slots.inject = () => { throw new Error('slot registry exploded'); };
  const error = run(host);
  check('a broken slots service does not fail the entry', error === null, error?.message ?? '');
}

// Case 4: sidebarRightTabs exists but has no register() — degrade quietly.
{
  const host = makeHost(plugin.inject, expectServices('slots', 'locale', 'sidebarRightTabs'));
  host.ctx.sidebarRightTabs.register = undefined;
  const error = run(host);
  check('a sidebar registry without register() is ignored', error === null, error?.message ?? '');
  check('settings section still registers without the sidebar', host.state.slots.length >= 1);
}

// Case 4b: the controller exists but cannot open (no session surface mounted).
// The channel must survive a throwing openTab rather than killing the entry.
{
  sources.length = 0;
  const host = makeHost(plugin.inject, expectServices('slots', 'locale', 'sidebarRightTabs', 'sidebarRight'));
  host.ctx.sidebarRight.openTab = () => { throw new Error('sidebarRight: no session surface is mounted'); };
  const error = run(host);
  check('apply() succeeds when openTab throws on mount', error === null, error?.message ?? '');
  let threw = null;
  // The bundle warns (with the underlying error) when a reveal cannot land; that
  // is the intended degrade, so silence it rather than letting it look like a
  // test failure in the output.
  const savedWarn = console.warn;
  console.warn = () => {};
  try {
    sources[0]?.emit({ type: 'reveal', reason: 'tool' });
  } catch (e) {
    threw = e;
  } finally {
    console.warn = savedWarn;
  }
  check('a reveal that cannot open is swallowed', threw === null, threw?.message ?? '');
}

// Case 5: no slots service at all (a very partial core). `inject` is declared,
// so Cordis would not deliver the entry — but apply() itself must not explode
// on a ctx whose side surfaces are missing.
{
  const host = makeHost(plugin.inject, expectServices('locale'));
  const error = run(host);
  check('apply() tolerates a host with no slots service', error === null, error?.message ?? '');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
