/**
 * End-to-end test of the Feishu read pipeline against a synthetic page.
 *
 * Feishu renders only the blocks near the viewport, so the collector must scroll
 * and harvest incrementally. This test serves a page with the same DOM contract
 * (`[data-block-type][data-record-id]` inside `.bear-web-x-container`, blocks
 * materialised on scroll) and asserts the walker reconstructs the document in
 * order, without duplicates and without dropping late-rendered blocks.
 *
 *   node test/feishu-pipeline.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserHost, findBrowser } from '../src/browser.js';
import { TabManager } from '../src/tabs.js';
import { readFeishuDocument } from '../src/feishu.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const BLOCKS = [
  { id: 'b1', type: 'heading1', text: '需求文档标题' },
  { id: 'b2', type: 'text', text: '第一段正文，含零宽字符\u200b和\u00a0不间断空格。' },
  { id: 'b3', type: 'bullet', text: '要点一' },
  { id: 'b4', type: 'bullet', text: '要点二' },
  { id: 'b5', type: 'heading2', text: '第二节' },
  { id: 't1', type: 'table', rows: [['字段', '说明'], ['name', '名称'], ['age', '年龄']] },
  { id: 'b6', type: 'code', text: 'const x = 1;' },
  { id: 'b7', type: 'quote', text: '引用说明' },
  { id: 'b8', type: 'whiteboard' },
  ...Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, type: 'text', text: `长文段落 ${i}：用于制造滚动。` })),
  { id: 'b9', type: 'heading2', text: '末节（晚渲染）' },
  { id: 'b10', type: 'text', text: '最后一段只在滚到底部后才渲染。' },
];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>测试需求文档 - 飞书云文档</title>
<style>
 html,body{margin:0;height:100%}
 .bear-web-x-container{height:100vh;overflow-y:auto}
 .blk{min-height:34px;padding:6px 12px;border-bottom:1px solid #eee;font:14px/1.6 sans-serif}
 .blk[data-block-type=heading1]{font-size:22px;font-weight:700}
 .blk[data-block-type=heading2]{font-size:18px;font-weight:700}
 table{border-collapse:collapse}td{border:1px solid #ccc;padding:2px 8px}
</style></head><body>
<div class="bear-web-x-container" id="sc"></div>
<script>
 // Virtual scroll: only the blocks within +/- 2 viewports of the cursor exist.
 const BLOCKS = ${JSON.stringify(BLOCKS)};
 const sc = document.getElementById('sc');
 const starts = [];
 let acc = 0;
 for (const b of BLOCKS) { starts.push(acc); acc += (b.type === 'table' ? 30 * b.rows.length : 42); }
 sc.innerHTML = '<div style="height:' + acc + 'px;position:relative" id="spacer"></div>';
 const spacer = document.getElementById('spacer');
 const rendered = new Map();
 function render() {
   const top = sc.scrollTop, bottom = top + sc.clientHeight;
   BLOCKS.forEach((b, i) => {
     const y = starts[i], h = (b.type === 'table' ? 30 * b.rows.length : 42);
     const visible = y + h > top - sc.clientHeight * 2 && y < bottom + sc.clientHeight * 2;
     if (!visible) { const el = rendered.get(b.id); if (el) { el.remove(); rendered.delete(b.id); } return; }
     if (rendered.has(b.id)) return;
     const el = document.createElement('div');
     el.className = 'blk';
     el.dataset.blockType = b.type;
     el.dataset.recordId = b.id;
     el.style.position = 'absolute'; el.style.top = y + 'px'; el.style.left = '0'; el.style.right = '0';
     if (b.type === 'table') {
       el.innerHTML = '<table>' + b.rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</table>';
     } else if (b.type === 'whiteboard') {
       el.innerHTML = '<canvas width="200" height="20"></canvas>';
     } else {
       el.textContent = b.text;
     }
     spacer.appendChild(el);
     rendered.set(b.id, el);
   });
 }
 sc.addEventListener('scroll', () => requestAnimationFrame(render));
 render();
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/doc') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const found = findBrowser();
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-iab-e2e-'));
const browser = new BrowserHost({ binary: found.path, dedicated: found.dedicated, profileDir, headed: false });
const tabs = new TabManager({});

try {
  const endpoint = await browser.ensureStarted();
  await tabs.connect(endpoint);
  const opened = await tabs.open(`${base}/doc`);
  const tab = tabs.get(opened.tabId);
  await new Promise((r) => setTimeout(r, 1200));

  const doc = await readFeishuDocument(tab, { settleMs: 120, maxSteps: 200, passes: 6 });

  check('title is extracted and cleaned', doc.title.includes('测试需求文档') && !doc.title.includes('飞书云文档'), doc.title);
  check('collected a meaningful number of blocks', doc.blocks >= 45, `${doc.blocks} blocks`);
  check('markdown is non-trivial', doc.markdown.length > 500, `${doc.markdown.length} chars`);

  const order = ['需求文档标题', '第一段正文', '要点一', '要点二', '第二节', 'name', '末节（晚渲染）', '最后一段'];
  let cursor = -1;
  let ordered = true;
  for (const needle of order) {
    const at = doc.markdown.indexOf(needle);
    if (at < 0 || at < cursor) {
      ordered = false;
      console.log(`   [order] "${needle}" at ${at} (cursor ${cursor})`);
      break;
    }
    cursor = at;
  }
  check('blocks are in document order', ordered);

  check('headings become markdown headings', /^# 需求文档标题/m.test(doc.markdown) && /^## 第二节/m.test(doc.markdown));
  check('bullets become list items', /^- 要点一/m.test(doc.markdown));
  check('code becomes a fenced block', /```[\s\S]*const x = 1;[\s\S]*```/.test(doc.markdown));
  check('quote is prefixed', /^> 引用说明/m.test(doc.markdown));
  check('table becomes a markdown table', /\| 字段 \| 说明 \|/.test(doc.markdown) && /\| name \| 名称 \|/.test(doc.markdown));
  check('canvas-only block becomes a placeholder', /画板/.test(doc.markdown));
  check('zero-width characters are stripped', !doc.markdown.includes('\u200b'));
  check('non-breaking spaces are normalised', !doc.markdown.includes('\u00a0'));
  check('late-rendered tail blocks are captured', doc.markdown.includes('最后一段只在滚到底部后才渲染'));

  // No duplicate lines: dedupe is by record id, so a re-render must not double a paragraph.
  const paragraphs = doc.markdown.split('\n').filter((l) => l.startsWith('长文段落 '));
  check('no duplicated blocks after multi-pass sweeping', paragraphs.length === 40, `${paragraphs.length}/40`);

  const connection = tabs.connection;
  tabs.detach();
  await browser.stop(connection);
} finally {
  tabs.detach();
  server.close();
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* disposable temp dir */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
