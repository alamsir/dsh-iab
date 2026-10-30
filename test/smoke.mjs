/**
 * Smoke test: drive the plugin's browser modules against a real Chromium.
 *
 * Runs without dsh — it exercises browser.js + tabs.js + feishu.js, the parts
 * that actually talk to Chromium. Every launch uses a throwaway profile, so the
 * user's own browser and login are never touched.
 *
 *   node test/smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserHost, findBrowser, isForeignProfile } from '../src/browser.js';
import { TabManager } from '../src/tabs.js';
import { isFeishuUrl, collectorSource, collectExpression } from '../src/feishu.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const logger = { info: () => {}, error: (m) => console.error(m) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Isolation guards (no browser needed) ────────────────────────────────────
check('isForeignProfile rejects the user\'s Chrome profile',
  isForeignProfile(join(process.env.LOCALAPPDATA ?? 'C:\\nonexistent', 'Google', 'Chrome', 'User Data')));
check('isForeignProfile rejects a subdirectory of it',
  isForeignProfile(join(process.env.LOCALAPPDATA ?? 'C:\\nonexistent', 'Google', 'Chrome', 'User Data', 'Default')));
check('isForeignProfile accepts a private profile',
  !isForeignProfile(join(tmpdir(), 'dsh-iab-private')));

let refused = false;
try {
  // eslint-disable-next-line no-new
  new BrowserHost({
    binary: 'x', profileDir: join(process.env.LOCALAPPDATA ?? 'C:\\nonexistent', 'Google', 'Chrome', 'User Data'),
  });
} catch {
  refused = true;
}
check('BrowserHost refuses a foreign profile at construction', refused);

// ── Binary discovery ────────────────────────────────────────────────────────
const found = findBrowser(process.env.DSH_IAB_CHROME);
check('findBrowser resolves a Chromium binary', Boolean(found), found?.path ?? 'none found');
if (!found) process.exit(1);
check('a dedicated build is preferred over system Chrome', found.dedicated === true,
  found.dedicated ? 'dedicated chromium' : 'system chrome fallback');

// ── Live browser ────────────────────────────────────────────────────────────
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-iab-test-'));
const browser = new BrowserHost({ binary: found.path, dedicated: found.dedicated, profileDir, headed: false, logger });
const tabs = new TabManager({ logger });

try {
  const endpoint = await browser.ensureStarted();
  check('BrowserHost starts Chromium and exposes an endpoint', /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint), endpoint);

  const again = await browser.ensureStarted();
  check('ensureStarted is idempotent', again === endpoint, again);

  await tabs.connect(endpoint);
  check('TabManager connects over CDP', tabs.connected);

  const opened = await tabs.open('https://example.com/');
  check('tabs.open returns a tab id', typeof opened.tabId === 'string', opened.tabId);

  const tab = tabs.get(opened.tabId);
  let title = null;
  for (let i = 0; i < 40 && !title; i += 1) {
    title = await tab.evaluate('document.title || null');
    if (!title) await sleep(250);
  }
  check('page JS evaluation works', title === 'Example Domain', String(title));

  // The body can still be parsing right after navigation commits, so poll for
  // visible text instead of assuming one evaluate is enough.
  let visibleText = '';
  for (let i = 0; i < 40 && !visibleText; i += 1) {
    visibleText = (await tab.evaluate('(document.body && document.body.innerText) || ""')) ?? '';
    if (!visibleText) await sleep(250);
  }
  check('structured page data round-trips', /example/i.test(visibleText), `${visibleText.length} chars of text`);

  const shot = await tab.screenshot({ format: 'png' });
  check('screenshot returns base64 PNG', typeof shot === 'string' && shot.startsWith('iVBOR'), `${shot?.length ?? 0} chars`);

  const geom = await tab.scroll({ direction: 'down', step: 0.5 });
  check('scroll reports geometry', geom.ok === true && typeof geom.height === 'number', JSON.stringify(geom));

  const listed = tabs.list();
  check('tabs.list includes the opened tab', listed.some((t) => t.tabId === opened.tabId), `${listed.length} tabs`);

  const second = await tabs.open('https://example.org/');
  const adopted = await tabs.adoptExisting();
  check('adoptExisting keeps both tabs', adopted.length >= 2, `${adopted.length} tabs`);

  await tabs.close(second.tabId);
  check('tabs.close drops the tab', tabs.list().every((t) => t.tabId !== second.tabId));

  // Error paths must fail loudly rather than silently returning nothing.
  let unknownThrew = false;
  try {
    tabs.get('tab-does-not-exist');
  } catch {
    unknownThrew = true;
  }
  check('unknown tab id throws', unknownThrew);

  let scriptThrew = false;
  try {
    await tab.evaluate('(() => { throw new Error("boom") })()');
  } catch (error) {
    scriptThrew = String(error.message).includes('boom');
  }
  check('page script errors surface', scriptThrew);

  const connection = tabs.connection;
  tabs.detach();
  await browser.stop(connection);
  check('BrowserHost.stop closes the browser', !browser.running);
} finally {
  tabs.detach();
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file briefly; the temp dir is disposable */
  }
}

// ── Feishu helpers ──────────────────────────────────────────────────────────
check('isFeishuUrl accepts a wiki URL', isFeishuUrl('https://x.feishu.cn/wiki/AbCdEf'));
check('isFeishuUrl accepts a docx URL', isFeishuUrl('https://x.feishu.cn/docx/AbCdEf'));
check('isFeishuUrl rejects other hosts', !isFeishuUrl('https://example.com/wiki/AbCdEf'));
check('collectorSource extracts the function expression', collectorSource().startsWith('(function'));
check('collectExpression is directly evaluable', collectExpression({ dir: 'down' }).includes('{"dir":"down"}'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
