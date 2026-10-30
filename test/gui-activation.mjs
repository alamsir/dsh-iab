/**
 * Real-browser verification: load the DSH GUI in the plugin's own Chromium and
 * check that the client bundle ACTIVATES inside the page.
 *
 * This is the check that was missing when dsh-iab first broke boot: a bundle can
 * download fine and still throw the moment it is evaluated, which DSH reports as
 * "web boot: N entry did not activate" and treats as fatal.
 *
 *   node test/gui-activation.mjs <guiUrlWithToken>
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserHost, findBrowser } from '../src/browser.js';
import { TabManager } from '../src/tabs.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node test/gui-activation.mjs <guiUrlWithToken>');
  process.exit(2);
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const found = findBrowser();
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-iab-gui-'));
const browser = new BrowserHost({ binary: found.path, dedicated: found.dedicated, profileDir, headed: false });
const tabs = new TabManager({});

try {
  const endpoint = await browser.ensureStarted();
  await tabs.connect(endpoint);
  const opened = await tabs.open('about:blank');
  const tab = tabs.get(opened.tabId);

  // Collect page errors and console errors before navigating, so nothing is
  // missed during boot.
  const errors = [];
  const consoleErrors = [];
  tab.manager.connection.on('Runtime.exceptionThrown', (params, sessionId) => {
    if (sessionId !== tab.sessionId) return;
    const d = params.exceptionDetails ?? {};
    errors.push(d.exception?.description ?? d.text ?? 'exception');
  });
  tab.manager.connection.on('Runtime.consoleAPICalled', (params, sessionId) => {
    if (sessionId !== tab.sessionId) return;
    if (params.type !== 'error') return;
    consoleErrors.push((params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  });
  await tab.send('Runtime.enable').catch(() => {});
  await tab.send('Page.enable').catch(() => {});
  await tab.send('Log.enable').catch(() => {});

  await tab.navigate(target);
  // The GUI boots asynchronously (module graph, remote, session); give it room.
  await sleep(9000);

  const probe = JSON.parse(await tab.evaluate(`(function(){
    var boot = window.__DSH_BOOT__;
    var rows = [];
    try {
      var graph = boot && (boot.entries || boot.rows || boot);
      if (Array.isArray(graph)) rows = graph.map(function(r){ return r.id; });
      else if (graph && typeof graph === 'object') rows = Object.keys(graph);
    } catch (e) {}
    var mod = window.__ModuleLoader__;
    var loaded = [];
    try { loaded = Object.keys(mod && mod.registry ? mod.registry : {}); } catch (e) {}
    return JSON.stringify({
      title: document.title,
      hasBoot: !!boot,
      bootIds: rows,
      hasModuleLoader: !!mod,
      loadedCount: loaded.length,
      bodyText: (document.body && document.body.innerText || '').slice(0, 400)
    });
  })()`));

  check('GUI page loaded', probe.title.length > 0, probe.title);
  check('boot graph present', probe.hasBoot === true);
  check('module loader present', probe.hasModuleLoader === true);

  const fatal = [...errors, ...consoleErrors].filter((line) => /did not activate|failed to activate|dsh-iab: failed/i.test(line));
  check('no "entry did not activate" error', fatal.length === 0, fatal.slice(0, 2).join(' | '));

  const iabErrors = [...errors, ...consoleErrors].filter((line) => /dsh-iab/i.test(line));
  check('client bundle produced no dsh-iab error', iabErrors.length === 0, iabErrors.slice(0, 3).join(' | '));

  // The boot row for this plugin must exist, otherwise the bundle never loads.
  const hasRow = (probe.bootIds ?? []).includes('dsh-iab');
  check('boot graph lists the dsh-iab row', hasRow, (probe.bootIds ?? []).join(','));

  // The settings section is the surface that must appear even without a sidebar.
  const settingsOk = await tab.evaluate(`(function(){
    var text = (document.body.innerText || '');
    return JSON.stringify({ hasIabLabel: text.indexOf('内置浏览器') >= 0 || text.indexOf('In-app browser') >= 0 });
  })()`).then(JSON.parse);
  check('plugin label reachable in the UI text (informational)', true,
    settingsOk.hasIabLabel ? 'label present on the page' : 'label not on the current view (settings not open)');

  console.log('\n--- page errors captured ---');
  console.log(errors.slice(0, 5).join('\n') || '(none)');
  console.log('--- console errors captured ---');
  console.log(consoleErrors.slice(0, 5).join('\n') || '(none)');

  const connection = tabs.connection;
  tabs.detach();
  await browser.stop(connection);
} finally {
  tabs.detach();
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
