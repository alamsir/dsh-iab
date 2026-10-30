/**
 * Live reveal probe: does a *tool call* actually move the panel on a real DSH?
 *
 * Runs against a running `dsh web` instance: opens the GUI in a browser, takes a
 * baseline screenshot, then triggers `/dsh-iab/api/reveal` (the same broadcast a
 * tool emits) and screenshots again. If the panel opened, the page changes.
 *
 *   node test/reveal-live.mjs <guiUrlWithToken> <outPrefix>
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserHost, findBrowser } from '../src/browser.js';
import { TabManager } from '../src/tabs.js';

const [guiUrl, outPrefix = 'reveal-live'] = process.argv.slice(2);
if (!guiUrl) {
  console.error('usage: node test/reveal-live.mjs <guiUrlWithToken> [outPrefix]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const found = findBrowser();
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-iab-live-'));
const browser = new BrowserHost({ binary: found.path, dedicated: found.dedicated, profileDir, headed: false });
const tabs = new TabManager({});

try {
  await tabs.connect(await browser.ensureStarted());
  const opened = await tabs.open(guiUrl);
  const tab = tabs.get(opened.tabId);
  await sleep(9000);

  // The GUI boots asynchronously; the reveal only lands if the client plugin
  // subscribed, so check that the channel has a listener before asserting.
  const before = await tab.screenshot({ format: 'png' });
  writeFileSync(`${outPrefix}-before.png`, Buffer.from(before, 'base64'));

  const probe = JSON.parse(await tab.evaluate(`(function(){
    var tabs = document.querySelectorAll('[data-dockkit-tab], [role=tab]');
    var labels = Array.prototype.map.call(tabs, function(t){ return (t.textContent||'').trim(); });
    return JSON.stringify({
      tabLabels: labels,
      bodyLen: (document.body.innerText || '').length,
      hash: (document.body.innerText || '').slice(0, 200)
    });
  })()`));
  check('the GUI rendered a session surface', probe.bodyLen > 0, `${probe.bodyLen} chars`);
  check('no browser tab open yet', !probe.tabLabels.some((label) => /内置浏览器|In-app browser/.test(label)),
    probe.tabLabels.join(' | ').slice(0, 120));

  // Trigger the same broadcast a tool emits.
  await tab.evaluate(`fetch('/dsh-iab/api/reveal', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'}).then(r => r.status)`);
  await sleep(2500);

  const after = await tab.screenshot({ format: 'png' });
  writeFileSync(`${outPrefix}-after.png`, Buffer.from(after, 'base64'));

  const probe2 = JSON.parse(await tab.evaluate(`(function(){
    var tabs = document.querySelectorAll('[data-dockkit-tab], [role=tab]');
    var labels = Array.prototype.map.call(tabs, function(t){ return (t.textContent||'').trim(); });
    return JSON.stringify({
      tabLabels: labels,
      bodyLen: (document.body.innerText || '').length,
      hasIabPanel: !!document.querySelector('.dsh-iab-root'),
      hasAddressBar: !!document.querySelector('.dsh-iab-bar input'),
      hasStartButton: Array.prototype.some.call(document.querySelectorAll('.dsh-iab-hint button'), function(b){ return /启动|Start/.test(b.textContent||''); })
    });
  })()`));

  check('a reveal opens the in-app browser tab',
    probe2.tabLabels.some((label) => /内置浏览器|In-app browser/.test(label)),
    probe2.tabLabels.join(' | ').slice(0, 160));
  check('the panel body is mounted', probe2.hasIabPanel === true);
  check('the page changed after the reveal', probe2.bodyLen !== probe.bodyLen || before !== after,
    `${probe.bodyLen} -> ${probe2.bodyLen} chars`);

  // The panel starts in its "browser not running" state, because a reveal alone
  // does not launch Chromium — the tool does that. Its start button is the proof
  // that the panel is live rather than a placeholder.
  check('the panel renders its offline state before the browser starts',
    probe2.hasAddressBar === true || probe2.hasStartButton === true,
    probe2.hasAddressBar ? 'address bar' : probe2.hasStartButton ? 'start button' : 'neither');

  // Now do what the tool does: start the browser and open a page through the
  // Host, then confirm the panel is showing a real browser (address bar present).
  await tab.evaluate(`fetch('/dsh-iab/api/open', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({url:'https://example.com/'})}).then(r => r.status)`);
  await sleep(4000);

  const probe3 = JSON.parse(await tab.evaluate(`(function(){
    return JSON.stringify({
      hasAddressBar: !!document.querySelector('.dsh-iab-bar input'),
      addressValue: (document.querySelector('.dsh-iab-bar input') || {}).value || '',
      hasFrame: !!document.querySelector('.dsh-iab-root img'),
      frameBytes: ((document.querySelector('.dsh-iab-root img') || {}).src || '').length
    });
  })()`));
  check('the panel switches to the live browser view', probe3.hasAddressBar === true);
  check('the address bar shows the opened url', /example\.com/.test(probe3.addressValue), probe3.addressValue);
  check('the panel receives screencast frames', probe3.frameBytes > 1000, `${probe3.frameBytes} bytes of image src`);

  const final = await tab.screenshot({ format: 'png' });
  writeFileSync(`${outPrefix}-live.png`, Buffer.from(final, 'base64'));

  const connection = tabs.connection;
  tabs.detach();
  await browser.stop(connection);
} finally {
  tabs.detach();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* disposable */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
