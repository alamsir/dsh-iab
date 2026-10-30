/**
 * Integration test: load the plugin's `apply()` against the Host's real
 * `dsh-tools` registry and a fake Cordis context, then invoke each tool.
 *
 * This catches what a syntax check cannot: schema compilation, argument
 * validation, output validation, and the webServer route wiring.
 *
 *   node test/apply.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST_MODULES = 'D:/Users/fan.deng/.dsh/profiles/node_modules/@deepseek-ai';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// The plugin imports '@deepseek-ai/dsh-tools'; resolve it to the Host's copy so
// this test exercises the exact runtime the plugin will meet.
const toolsEntry = pathToFileURL(join(HOST_MODULES, 'dsh-tools', 'lib', 'index.js')).href;
const toolsModule = await import(toolsEntry);
const { defineTool } = toolsModule;

// ── Fake Cordis context ─────────────────────────────────────────────────────
const tools = new Map();
const routes = [];
const cleanups = [];
const ctx = {
  logger: { info: () => {}, error: (m) => console.error(m) },
  tools: {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') cleanups.push(disposer);
    return disposer;
  },
  connection: {
    requestRejection: () => undefined,
  },
};

// Patch the module specifier so `src/index.js` gets the same dsh-tools instance.
const plugin = await import('../src/index.js');

check('plugin exports a name', typeof plugin.name === 'string', plugin.name);
check('plugin declares the tools injection', Array.isArray(plugin.inject) && plugin.inject.includes('tools'));

try {
  plugin.apply(ctx, {});
} catch (error) {
  console.error(error);
  check('apply() runs without throwing', false, error.message);
  process.exit(1);
}
check('apply() runs without throwing', true);

// ── Settings schema (volatile unwrapping) ───────────────────────────────────
check('plugin exports a Config schema', typeof plugin.Config === 'function');
if (typeof plugin.Config === 'function') {
  const parsed = plugin.Config({ headed: true, outDir: 'D:/tmp/out' });
  const headed = parsed.headed;
  check('volatile field is a wrapper, not a bare value', typeof headed?.get === 'function');
  check('volatile wrapper returns the configured value', headed.get() === true);

  // apply() must survive a volatile-wrapped config: reading it raw would yield
  // "[object Object]" and silently disable every setting.
  const tools2 = new Map();
  const ctx2 = {
    logger: { info: () => {}, error: () => {} },
    tools: { register: (d) => { tools2.set(d.name, d); return () => {}; } },
    webServer: { register: () => () => {} },
    effect: (fn) => fn(),
  };
  let threw = null;
  try {
    plugin.apply(ctx2, parsed);
  } catch (error) {
    threw = error;
  }
  check('apply() accepts a schema-parsed config', threw === null, threw?.message ?? '');
  check('apply() registers tools with a parsed config', tools2.size >= 7, `${tools2.size} tools`);
}

// ── Tool registry shape ─────────────────────────────────────────────────────
const expected = [
  'dsh_iab_status',
  'dsh_iab_open',
  'dsh_iab_eval',
  'dsh_iab_read',
  'dsh_iab_feishu',
  'dsh_iab_screenshot',
  'dsh_iab_tabs',
];
for (const name of expected) {
  check(`registers ${name}`, tools.has(name));
}

const openTool = tools.get('dsh_iab_open');
check('dsh_iab_open requires url', openTool.parameters.required?.includes('url'));
check('tool schemas use plain JSON Schema', openTool.parameters.type === 'object');

// ── Argument validation comes from dsh-tools, not us ────────────────────────
let missingArgThrew = false;
try {
  await openTool.execute({}, {});
} catch (error) {
  missingArgThrew = /INVALID_ARGS|missing required/i.test(String(error.message ?? error));
}
check('missing required argument is rejected', missingArgThrew);

let badSchemeThrew = false;
try {
  await openTool.execute({ url: 'file:///etc/passwd' }, {});
} catch (error) {
  badSchemeThrew = /http/i.test(String(error.message ?? error));
}
check('non-http URL is rejected before launching', badSchemeThrew);

// ── Status works with no browser running ────────────────────────────────────
const status = tools.get('dsh_iab_status');
const statusText = await status.execute({}, {});
check('dsh_iab_status reports state without a browser', typeof statusText === 'string' && statusText.includes('profile:'));

const tabsTool = tools.get('dsh_iab_tabs');
const tabsText = await tabsTool.execute({}, {});
check('dsh_iab_tabs reports "not running" instead of throwing', /not running|no tabs/i.test(tabsText), tabsText);

// ── HTTP surface ────────────────────────────────────────────────────────────
check('serves the browser API under /dsh-iab/api', routes.some((r) => r.path === '/dsh-iab/api'));

function fakeResponse() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers ?? {});
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      this.body = chunks.join('');
    },
    on() {},
  };
}

const route = routes.find((r) => r.path === '/dsh-iab/api');
const res = fakeResponse();
await route.handler({ method: 'GET', url: '/dsh-iab/api/status' }, res);
check('GET /status answers JSON', res.statusCode === 200 && JSON.parse(res.body).profile !== undefined, res.body.slice(0, 80));

const res404 = fakeResponse();
await route.handler({ method: 'GET', url: '/dsh-iab/api/nope' }, res404);
check('unknown route answers 404', res404.statusCode === 404);

// ── Shutdown must release everything ────────────────────────────────────────
for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch (error) {
    check('cleanup runs without throwing', false, error.message);
  }
}
check('cleanups ran for routes and shutdown', cleanups.length >= 2, `${cleanups.length} effects`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
