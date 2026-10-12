// tests/renderer/real-app-rich.test.mjs —— P1-T06 真实 App 详情/预览端到端 rich 断言
// 真实 Rust App（测试档案+测试端口+HTTP 桥）+ 真实 index.html / capture-mini.html：
// 声明 markdown/html 行开详情 → 受限 rich 渲染、结构语义、敌意信封惰性、
// 源码/排版回退开关、复制按钮仍复制存储 quote 原文、DB 原表示不动。
// 用法：node tests/renderer/real-app-rich.test.mjs [--out DIR]
// 前提：app/src-tauri/target/debug/nayan 已构建（cargo build --offline）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { synthEnvelope, hostileHtmlCases, REPO, UI_DIR, APP_BIN } from './fixtures.mjs';
import { startChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-real-app-rich-'));
fs.mkdirSync(outDir, { recursive: true });

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`);
}

if (!fs.existsSync(APP_BIN)) {
  console.error('找不到 App debug 二进制：' + APP_BIN + '（先 cd app/src-tauri && cargo build --offline）');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-p1b06-rich-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const RUN = 'p1b06-rich-' + Date.now();
const appLog = path.join(outDir, 'rich-realapp-app.log');
const app = spawn(APP_BIN, [], {
  cwd: os.tmpdir(),
  env: { ...process.env, NAYAN_TEST_PROFILE: root, NAYAN_TEST_UI_DIR: UI_DIR, NAYAN_TEST_PORT: String(port), NAYAN_TEST_RUN_ID: RUN },
  stdio: ['ignore', fs.openSync(appLog, 'a'), fs.openSync(appLog, 'a')],
});
const base = `http://127.0.0.1:${port}`;

async function apiPost(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${t}`);
  return JSON.parse(t);
}

const chromeProc = await startChrome();
let cdp;
const cleanup = () => {
  try { cdp && cdp.close(); } catch (_) {}
  try { chromeProc.child.kill(); } catch (_) {}
  try { app.kill(); } catch (_) {}
};
process.on('exit', cleanup);

// fixture：markdown 全矩阵源 + 敌意混合 html + legacy 疑似 md
const MD_SRC = '# 真实端到端标题\n\n- 一级\n  - 二级\n\n7. 第七\n8. 第八\n\n```rust\nfn real() {\n    "围栏内文"\n}\n```\n\n> 引用行\n\n---\n\n尾段 [外链](https://ok.example/real)。';
const MD_CANONICAL = MD_SRC; // 已是 LF
const HTML_SRC = '<h3>结构标题</h3><p>段落 <b>粗</b></p><ol start="9"><li>nine</li></ol>'
  + '<script>window.__REAL_PWN__=1</script><img src="https://evil.example/real.png" onerror="window.__REAL_PWN__=2">'
  + '<a href="javascript:window.__REAL_PWN__=3">js链</a><a href="https://ok.example/h">好链</a><p>结尾</p>';
const LEGACY_LOOKS_MD = '# 不是标题\n- 不是列表';

try {
  let up = false;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/api/suggestions'); if (r.ok) { up = true; break; } } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error('App HTTP 未就绪（见 ' + appLog + '）');
  check('Y0-app', '真实 App 启动（隔离档案 ' + path.basename(root) + '，端口 ' + port + '）', true);

  const mdEnv = synthEnvelope(MD_SRC, 'p1b06-real-md', 'markdown');
  const htmlEnv = synthEnvelope(HTML_SRC, 'p1b06-real-html', 'html');
  const rowMd = await apiPost('/api/suggestions', { title: 'B06 REAL markdown 行', request_id: 'p1b06-real-md', content: mdEnv });
  const rowHtml = await apiPost('/api/suggestions', { title: 'B06 REAL html 行', request_id: 'p1b06-real-html', content: htmlEnv });
  const rowLegacy = await apiPost('/api/suggestions', { title: 'B06 REAL legacy 行', quote: LEGACY_LOOKS_MD, source_tool: 'other', kind: 'suggestion' });
  check('Y1-seed', '三行入库（md #' + rowMd.id + ' / html #' + rowHtml.id + ' / legacy #' + rowLegacy.id + '）', rowMd.id > 0 && rowHtml.id > 0 && rowLegacy.id > 0);

  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.send('Page.enable'); // addScriptToEvaluateOnNewDocument 生效的前提（Page 域需先启用）
  // 注入两 vendor（页面脚本前执行）：测试桥静态白名单（index/attachments/rich-text，
  // B02 冻结）不含 vendor/*.js——404 会让 reader 走 kill-switch 回退（该路径已由
  // rich-dom M9 断言）。此处注入使真实 index.html 的 rich 路径可被端到端检验，
  // 全局暴露与 <script src> 加载恒等（rich-dom X0 已证 src 加载语义）。
  const vendorMi = fs.readFileSync(path.join(UI_DIR, 'vendor', 'markdown-it.umd.min.js'), 'utf8');
  const vendorDp = fs.readFileSync(path.join(UI_DIR, 'vendor', 'purify.min.js'), 'utf8');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: vendorMi });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: vendorDp });
  // 注入复制 sink（与 scenarios.mjs 同口径：写隔离档案 copy-sink.jsonl）
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__NAYAN_TEST_CLIP_SINK__ = function(s){
      fetch('/__test/sink',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({label:'rich',text:s})});
    };` });
  await cdp.go(base + '/');

  async function openDetail(title) {
    return cdp.eval(`(async () => {
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes(${JSON.stringify(title)}));
      if (!card) return { err: 'card not found' };
      card.click();
      const t0 = performance.now();
      while (performance.now() - t0 < 5000) {
        const b = document.getElementById('aibody');
        if (b && (b.childElementCount > 0 || b.textContent.length > 0)) {
          const sig = (root) => [...root.querySelectorAll('*')].map(n => n.tagName).join(',');
          return { html: b.innerHTML, cls: b.className, sig: sig(b), text: b.textContent,
                   rich: b.classList.contains('rich'),
                   tglVisible: (function(){ const t = document.getElementById('togglerich'); return t ? t.style.display !== 'none' : false; })() };
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return { err: 'aibody 未在 5s 内出现内容' };
    })()`);
  }

  // ---- Y2：markdown 行详情（受限 rich 渲染 + 结构语义） ----
  const y2 = await openDetail('B06 REAL markdown 行');
  const y2struct = await cdp.eval(`(() => {
    const b = document.getElementById('aibody');
    return {
      h1: [...b.querySelectorAll('h1')].map(h => h.textContent),
      pre: [...b.querySelectorAll('pre')].map(p => p.textContent),
      liDepths: [...b.querySelectorAll('li')].map(li => { let d=0,n=li.parentElement; while(n){ if(n.tagName==='UL'||n.tagName==='OL') d++; n=n.parentElement; } return d-1; }),
      olStart: b.querySelector('ol') ? b.querySelector('ol').getAttribute('start') : null,
      quote: b.querySelector('blockquote') ? b.querySelector('blockquote').textContent.trim() : null,
      hr: b.querySelectorAll('hr').length,
      link: b.querySelector('a') ? b.querySelector('a').getAttribute('href') : null,
      proj: plainProjection(b),
    };
  })()`);
  check('Y2-md-dom', 'markdown 行：rich 类挂载 + h1=标题', !y2.err && y2.rich && JSON.stringify(y2struct.h1) === JSON.stringify(['真实端到端标题']), JSON.stringify({ err: y2.err, h1: y2struct.h1 }));
  check('Y2-md-dom', '围栏内文逐字符精确（4 空格缩进保留）', y2struct.pre.length === 1 && y2struct.pre[0] === 'fn real() {\n    "围栏内文"\n}\n', JSON.stringify(y2struct.pre));
  check('Y2-md-dom', '嵌套列表深度 [0,1] + 有序 start=7', JSON.stringify(y2struct.liDepths.slice(0, 2)) === JSON.stringify([0, 1]) && y2struct.olStart === '7', JSON.stringify({ d: y2struct.liDepths, s: y2struct.olStart }));
  check('Y2-md-dom', '引用/分隔线/外链窄域', y2struct.quote === '引用行' && y2struct.hr === 1 && y2struct.link === 'https://ok.example/real', JSON.stringify({ q: y2struct.quote, hr: y2struct.hr, link: y2struct.link }));
  const y2projStable = await cdp.eval(`(() => {
    const b = document.getElementById('aibody');
    const d = b.__nayanDecision;
    const out1 = renderReaderBody(b, d, null);
    const p1 = out1.rendered ? out1.projection : null;
    const out2 = renderReaderBody(b, d, null);
    return { stable: p1 !== null && p1 === out2.projection };
  })()`);
  check('Y2-md-proj', '详情内重渲投影稳定（确定性）', y2projStable.stable, JSON.stringify(y2projStable));
  check('Y2-md-toggle', '回退开关按钮可见（rich 行）', y2.tglVisible, JSON.stringify({ visible: y2.tglVisible }));
  await cdp.screenshot(path.join(outDir, 'rich-realapp-detail-md.png'));

  // ---- Y3：源码/排版切换 ----
  const y3 = await cdp.eval(`(async () => {
    const tgl = document.getElementById('togglerich');
    if (!tgl) return { err: 'no toggle' };
    tgl.click();
    await new Promise(r => setTimeout(r, 120));
    const b1 = document.getElementById('aibody');
    const srcMode = { text: b1.textContent, rich: b1.classList.contains('rich') };
    tgl.click();
    await new Promise(r => setTimeout(r, 120));
    const b2 = document.getElementById('aibody');
    const richMode = { h1: b2.querySelector('h1') ? b2.querySelector('h1').textContent : null, rich: b2.classList.contains('rich') };
    return { srcMode, richMode, storage: localStorage.getItem('nayan-rich-disable') };
  })()`);
  check('Y3-toggle', '切「源码」→ 存储源文本原样（文本节点、非 rich）；切回「排版」→ 结构恢复',
    y3.srcMode.text === MD_CANONICAL && !y3.srcMode.rich && y3.richMode.rich && y3.richMode.h1 === '真实端到端标题', JSON.stringify(y3).slice(0, 300));

  // ---- Y4：复制按钮 = 存储 quote 原文（P1-T06 不动复制出口） ----
  const y4clicked = await cdp.eval(`(() => {
    const btn = document.querySelector('[data-act="copyquote"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  let sinkLine = null;
  for (let i = 0; i < 20 && !sinkLine; i++) {
    try {
      const lines = fs.readFileSync(path.join(root, 'copy-sink.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      sinkLine = lines[lines.length - 1];
    } catch (_) { /* retry */ }
    if (!sinkLine) await new Promise((r) => setTimeout(r, 150));
  }
  check('Y4-copy', '复制按钮写存储 quote（=canonical 源，P1-T07 前出口不变）', y4clicked && sinkLine && sinkLine.text === MD_CANONICAL, JSON.stringify(sinkLine && sinkLine.text && sinkLine.text.slice(0, 40)));

  // ---- Y5：html 行详情（白名单清洗 + 敌意惰性） ----
  const y5 = await openDetail('B06 REAL html 行');
  if (y5.err) throw new Error('html 行详情未打开：' + y5.err);
  const y5struct = await cdp.eval(`(() => {
    const b = document.getElementById('aibody');
    return {
      dangerous: b.querySelectorAll('script,img,iframe,object,embed,svg,form,style,meta,link').length,
      onAttrs: [...b.querySelectorAll('*')].filter(n => [...n.attributes].some(a => /^on/i.test(a.name) || a.name === 'style')).length,
      h3: [...b.querySelectorAll('h3')].map(h => h.textContent),
      liText: [...b.querySelectorAll('li')].map(l => l.textContent),
      olStart: b.querySelector('ol') ? b.querySelector('ol').getAttribute('start') : null,
      hrefs: [...b.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(Boolean),
      pwned: typeof window.__REAL_PWN__ !== 'undefined',
      proj: plainProjection(b),
    };
  })()`);
  check('Y5-html-dom', 'html 行：rich 渲染 + h3/ol start=9 结构保留', !y5.err && y5.rich && JSON.stringify(y5struct.h3) === JSON.stringify(['结构标题']) && y5struct.olStart === '9', JSON.stringify({ h3: y5struct.h3, s: y5struct.olStart }));
  check('Y5-html-hostile', '敌意载荷：零危险标签/零 on*+style 属性/零执行/存活 href 仅窄域',
    y5struct.dangerous === 0 && y5struct.onAttrs === 0 && !y5struct.pwned
    && JSON.stringify(y5struct.hrefs) === JSON.stringify(['https://ok.example/h']), JSON.stringify(y5struct));
  await cdp.screenshot(path.join(outDir, 'rich-realapp-detail-html.png'));

  // ---- Y6：legacy 行绝不结构化 ----
  const y6 = await openDetail('B06 REAL legacy 行');
  check('Y6-legacy', 'legacy 疑似 md 行：无 rich、#/- 原样文本（不自动解释）',
    !y6.err && !y6.rich && y6.text === LEGACY_LOOKS_MD && y6.sig.indexOf('H1') < 0, JSON.stringify({ rich: y6.rich, text: y6.text }));
  check('Y6-legacy', 'legacy 行回退开关隐藏', !y6.tglVisible, JSON.stringify({ visible: y6.tglVisible }));

  // ---- Y7：A(md)→B(legacy) 快速切换，迟到回填不污染 ----
  const y7 = await cdp.eval(`(async () => {
    const cards = [...document.querySelectorAll('.card')];
    const a = cards.find(c => c.textContent.includes('B06 REAL markdown 行'));
    const b = cards.find(c => c.textContent.includes('B06 REAL legacy 行'));
    a.click(); b.click();
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      const el = document.getElementById('aibody');
      if (el && el.textContent.startsWith('# 不是标题')) return { ok: true };
      await new Promise(r => setTimeout(r, 50));
    }
    return { ok: false };
  })()`);
  check('Y7-race', 'md→legacy 快速切换：B 正文正确（迟到 rich 不盖 legacy）', y7.ok, JSON.stringify(y7));

  // ---- Y8：DB 原表示不动 + quote=canonical ----
  const db = new DatabaseSync(path.join(root, 'inbox.db'), { readOnly: true });
  const qMd = db.prepare('SELECT quote, content_envelope FROM suggestions WHERE id=?').get(rowMd.id);
  const qHtml = db.prepare('SELECT quote, content_envelope FROM suggestions WHERE id=?').get(rowHtml.id);
  db.close();
  check('Y8-db-raw', 'md 行：quote=canonical；信封原文逐字符（显示层从未回写）',
    qMd.quote === MD_CANONICAL && JSON.parse(qMd.content_envelope).original.text === MD_SRC);
  check('Y8-db-raw', 'html 行：quote=空兼容视图（B03 冻结契约：投影 Unavailable→空串）；信封原文逐字符（敌意原文独立保留）',
    qHtml.quote === '' && JSON.parse(qHtml.content_envelope).original.text === HTML_SRC);

  cleanup();
} catch (e) {
  cleanup();
  console.error('real-app-rich.test.mjs 异常:', e);
  process.exit(1);
}

const summary = { suite: 'real-app-rich', total: results.length, pass: results.length - fail, fail, at: new Date().toISOString(), profile: root, port };
fs.writeFileSync(path.join(outDir, 'rich-realapp-results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\nreal-app-rich.test.mjs: ${summary.pass}/${summary.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
