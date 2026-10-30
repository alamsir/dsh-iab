/**
 * dsh-iab — Feishu document reader helpers.
 *
 * The page-side collector is the same virtual-scroll walker used by the
 * `feishu-iab-reader` skill: Feishu renders only the blocks near the viewport,
 * so the text has to be harvested while scrolling in both directions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let cachedSource = null;

/** The raw `(function ...)` expression text, read once. */
export function collectorSource() {
  if (cachedSource === null) {
    const text = readFileSync(join(HERE, 'feishu_collect.js'), 'utf8');
    const start = text.indexOf('(function');
    if (start < 0) throw new Error('dsh-iab: feishu_collect.js has no function expression');
    cachedSource = text.slice(start);
  }
  return cachedSource;
}

/** Build the `(fn)(opts)` expression the page evaluates for one scroll step. */
export function collectExpression(options) {
  return `(${collectorSource()})(${JSON.stringify(options ?? {})})`;
}

const FEISHU_HOST = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/i;

/** Whether a URL belongs to Feishu (doc, wiki, sheets, base, …). */
export function isFeishuUrl(url) {
  try {
    return FEISHU_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const sanitize = (name) => String(name || 'feishu-doc').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

/**
 * Walk a Feishu document and return its Markdown.
 *
 * Mirrors the proven two-phase sweep: reload to reset virtual scroll, then
 * alternate down/up passes until a whole pass adds nothing. Every step needs a
 * short settle delay, otherwise blocks that render late are never captured.
 */
export async function readFeishuDocument(tab, { settleMs = 400, step = 0.85, maxSteps = 150, passes = 4, onProgress } = {}) {
  const run = (options) => tab.evaluate(collectExpression(options)).then((raw) => {
    if (typeof raw === 'string') return JSON.parse(raw);
    return raw;
  });

  await tab.send('Page.reload', { ignoreCache: false }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  await new Promise((r) => setTimeout(r, 200));

  let previous = -1;
  let final = null;
  const directions = Array.from({ length: passes }, (_, i) => (i % 2 === 0 ? 'down' : 'up'));

  for (const dir of directions) {
    const reset = await run({ reset: true, dir });
    if (reset?.error) throw new Error(reset.error);
    await new Promise((r) => setTimeout(r, dir === 'down' ? 1000 : 800));

    let lastCount = -1;
    let stable = 0;
    let status = null;
    for (let i = 0; i < maxSteps; i += 1) {
      status = await run({ dir, step });
      if (status?.error) throw new Error(status.error);
      stable = status.n === lastCount ? stable + 1 : 0;
      lastCount = status.n;
      onProgress?.({ dir, blocks: status.n, step: i });
      if (status.done && stable >= 2) break;
      await new Promise((r) => setTimeout(r, settleMs));
    }
    final = await run({ dir, step, dump: true });
    if (status && status.n === previous) break;
    previous = status?.n ?? previous;
  }

  if (!final || typeof final.markdown !== 'string') {
    throw new Error('dsh-iab: collector did not return Markdown (is this a Feishu document page?)');
  }
  return {
    title: final.title || 'feishu-doc',
    markdown: final.markdown,
    blocks: final.n ?? 0,
    placeholders: (final.markdown.match(/^> \[/gm) ?? []).length,
  };
}

/** The `# title` + source banner form used on disk. */
export function toDocument({ title, markdown, url }) {
  return `# ${title}\n\n> 来源：${url}\n> 读取方式：dsh-iab（DSH 内置浏览器插件）\n\n${markdown}\n`;
}

export function suggestedFilename(title) {
  return `${sanitize(title)}.md`;
}
