/**
 * Capture the scratch GUI so a human can see what it looks like.
 * Opens <guiUrl>, waits for boot, screenshots, and also opens the settings
 * section labelled 内置浏览器 if it can find it.
 *
 *   node test/shot-gui.mjs <guiUrlWithToken> <outPng>
 */
import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserHost, findBrowser } from '../src/browser.js';
import { TabManager } from '../src/tabs.js';

const [guiUrl, outPng] = process.argv.slice(2);
if (!guiUrl) {
  console.error('usage: node test/shot-gui.mjs <guiUrlWithToken> [outPng]');
  process.exit(2);
}
const target = outPng ?? 'gui.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const found = findBrowser();
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-iab-shot-'));
const browser = new BrowserHost({ binary: found.path, dedicated: found.dedicated, profileDir, headed: false });
const tabs = new TabManager({});

try {
  await tabs.connect(await browser.ensureStarted());
  const opened = await tabs.open(guiUrl);
  const tab = tabs.get(opened.tabId);
  await sleep(9000);

  const shot1 = await tab.screenshot({ format: 'png' });
  writeFileSync(target.replace(/\.png$/, '-boot.png'), Buffer.from(shot1, 'base64'));
  console.log('boot view ->', target.replace(/\.png$/, '-boot.png'));

  // Try to reach the plugin's settings section.
  const clicked = await tab.evaluate(`(function(){
    var els = Array.prototype.slice.call(document.querySelectorAll('button,[role=tab],[role=button],a,div[class*=nav] *'));
    var hit = els.find(function(e){
      var t = (e.innerText || '').trim();
      return t === '设置' || t === 'Settings';
    });
    if (hit) { hit.click(); return 'settings'; }
    return null;
  })()`);
  await sleep(2500);
  const shot2 = await tab.screenshot({ format: 'png' });
  writeFileSync(target.replace(/\.png$/, '-settings.png'), Buffer.from(shot2, 'base64'));
  console.log('settings clicked:', clicked, '->', target.replace(/\.png$/, '-settings.png'));

  const text = await tab.evaluate('(document.body.innerText || "").slice(0, 1500)');
  console.log('--- visible text ---');
  console.log(text);

  const connection = tabs.connection;
  tabs.detach();
  await browser.stop(connection);
} finally {
  tabs.detach();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
