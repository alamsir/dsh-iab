// feishu-iab-reader 页面侧采集脚本（v2）：在 ZCode 内置浏览器的飞书云文档/知识库页面中执行。
// 用法（见 SKILL.md）：读本文件文本 → tab.playwright.evaluate(`(${src})(opts)`) 循环调用，直到返回 done=true。
// 飞书正文为虚拟滚动：每次只渲染可视区附近的块，需"下扫 → 到底等待 → 上扫回补"两阶段，按 data-record-id 去重。
// 修复记录：空块不落永久标记（渲染晚的文本块仍可回补）；表格跨屏渲染不全时每次重采、保留行数更多者。
(function feishuCollect(opts) {
  opts = opts || {};
  const dir = opts.dir === "up" ? -1 : 1;
  const ZW = /[\u200b-\u200f\u2060-\u2064\ufeff]/g;
  const clean = s => (s || "").replace(ZW, "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  const sc = document.querySelector(".bear-web-x-container")
    || [...document.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 200
      && /auto|scroll/.test(getComputedStyle(e).overflowY));
  if (!sc) return { error: "未找到正文滚动容器：页面可能未登录、未加载完成，或不是飞书云文档页面" };

  if (opts.reset || !window.__fx) {
    window.__fx = { order: [], map: {}, trow: {}, pos: {}, started: false, seq: {} };
    sc.scrollTop = dir === -1 ? sc.scrollHeight : 0;
    return { reset: true, n: 0, done: false };
  }
  const S = window.__fx;
  // reset 后首轮只定位、不滚动，等渲染稳定
  const nearEdge = dir === 1 ? sc.scrollTop <= 5 : sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5;
  if (!S.started) {
    if (dir === 1 && sc.scrollTop > 5) { sc.scrollTop = 0; return { n: S.order.length, done: false, top: 0 }; }
    S.started = true;
  }

  const H = { heading1: "# ", heading2: "## ", heading3: "### ", heading4: "#### ",
              heading5: "##### ", heading6: "###### ", heading7: "###### ", heading8: "###### ", heading9: "###### " };
  const PH = { whiteboard: "画板", image: "图片", diagram: "流程图", mindnote: "思维笔记",
               iframe: "内嵌页面", file: "附件", sheet: "内嵌表格", bitable: "内嵌多维表格", isv: "第三方组件" };

  const tableMd = el => {
    let rows = [...el.querySelectorAll("tr")].map(tr =>
      [...tr.querySelectorAll("td,th")].map(td => clean(td.innerText).replace(/\n+/g, "<br>").replace(/\|/g, "\\|")));
    rows = rows.filter(r => r.some(c => c));
    if (!rows.length) return { md: "", rows: 0 };
    const w = Math.max(...rows.map(r => r.length));
    rows = rows.map(r => r.concat(Array(w - r.length).fill("")));
    return { md: ["| " + rows[0].join(" | ") + " |", "|" + rows[0].map(() => "---").join("|") + "|",
                  ...rows.slice(1).map(r => "| " + r.join(" | ") + " |")].join("\n"), rows: rows.length };
  };

  const pos0 = sc.scrollTop;
  for (const el of document.querySelectorAll("[data-block-type][data-record-id]")) {
    const id = el.getAttribute("data-record-id"), type = el.getAttribute("data-block-type");
    if (type === "page" || type === "table_cell") continue;
    if (el.parentElement && el.parentElement.closest("[data-block-type='table']")) continue;
    const r = el.getBoundingClientRect();
    const pos = r.height > 0 ? Math.round(r.top + pos0) : null;
    if (type === "table") {
      const { md, rows } = tableMd(el);
      if (rows >= (S.trow[id] || 0) && md) {           // 行数不减才更新（跨屏渐进渲染取最全版本）
        if (!(id in S.map)) { S.order.push(id); S.seq[id] = S.order.length; }
        S.map[id] = md; S.trow[id] = rows;
        if (pos !== null && (S.pos[id] === undefined || dir === 1)) S.pos[id] = pos;
      }
      continue;
    }
    if (S.map[id]) continue;                            // 非表格块：已有内容即跳过；空块不标记，留待回补
    let md = "";
    if (PH[type]) {
      const img = type === "image" && el.querySelector("img");
      const alt = img && clean(img.getAttribute("alt") || "");
      md = `> [${PH[type]}${alt ? "：" + alt : ""}：浏览器文本提取无法获取内容，请在原文档查看]`;
    } else {
      if (el.querySelector("[data-block-type][data-record-id]")) continue;
      const t = clean(el.innerText);
      if (!t) continue;
      const pre = H[type] || ({ bullet: "- ", ordered: "1. ", todo: "- [ ] ", quote: "> " })[type] || "";
      if (type === "code") md = "```\n" + t + "\n```";
      else if (pre.startsWith("#")) md = pre + t.replace(/\n+/g, " ");
      else md = pre + t.replace(/\n+/g, "\n" + (pre === "> " ? "> " : ""));
      const links = [...el.querySelectorAll("a[href]")].map(a => a.href)
        .filter(h => /^https?:/.test(h) && !t.includes(h));
      if (links.length) md += "\n" + [...new Set(links)].map(h => `  - 链接：${h}`).join("\n");
    }
    if (md) {
      S.map[id] = md; S.order.push(id); S.seq[id] = S.order.length;
      if (pos !== null) S.pos[id] = pos;
    }
  }

  // 前进：上扫阶段从底部向上；到底/到顶后停止滚动，等待对端内容渲染
  const atEnd = dir === 1
    ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5
    : sc.scrollTop <= 0;
  if (!atEnd) sc.scrollTop += dir * Math.floor(sc.clientHeight * (opts.step || 0.85));
  const done = atEnd;
  const out = { n: S.order.length, done, top: sc.scrollTop, height: sc.scrollHeight, dir };
  if (done || opts.dump) {
    out.title = clean(document.title).replace(/[\u202a-\u202e\u200b-\u200f\ufeff]/g, "")
      .replace(/\s*-\s*飞书云文档\s*$/, "");
    // 按文档纵向位置排序（pos 缺失者按采集顺序垫底），保证上扫回补的块回到正确位置
    const items = S.order.map((id, idx) => ({ id, md: S.map[id], pos: S.pos[id] ?? (1e9 + idx) }));
    items.sort((a, b) => a.pos - b.pos || a.id.localeCompare(b.id));
    out.markdown = items.map(i => i.md).filter(m => !/^本文暂未被其它文档引用$/.test(m))
      .join("\n\n").replace(/\n{3,}/g, "\n\n");
  }
  return out;
})
