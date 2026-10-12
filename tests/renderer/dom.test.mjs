// tests/renderer/dom.test.mjs —— P1-T05 真实 DOM 断言套件（headless Chrome + 真实 UI 源）
// 检验对象：app/ui/rich-text.js（真实文件经 <script src> 加载）+ 从 index.html /
// capture-mini.html 现场提取的 .aibody/.bubble CSS 规则 + 真实 capture-mini.html 预览页。
// 期望值来源：tests/content/golden（Rust canonical）+ 文档化规则边界。
// 用法：node tests/renderer/dom.test.mjs [--out DIR]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoldens, rendererExtras, synthEnvelope, synthBody, REPO, UI_DIR } from './fixtures.mjs';
import { startChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-dom-'));
fs.mkdirSync(outDir, { recursive: true });

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`);
}

// ---------- 从真实 UI 源提取 CSS 规则（漂移即报警：必须恰一条） ----------
function extractRule(file, re, label) {
  const src = fs.readFileSync(path.join(UI_DIR, file), 'utf8');
  const m = src.match(re);
  if (!m || m.length !== 1) throw new Error(`${file} 中 ${label} 规则提取数=${m ? m.length : 0}（期望恰 1）——CSS 漂移`);
  return m[0];
}
const aibodyRule = extractRule('index.html', /\.aibody\{[^}]*\}/g, '.aibody');
const bubbleRule = extractRule('capture-mini.html', /\.bubble \{[^}]*\}/g, '.bubble');

// ---------- fixture 集（golden 文本用例 + 渲染器边界） ----------
const cases = [];
for (const g of loadGoldens()) {
  if (g.binary || g.canonical == null) continue;
  cases.push({ name: g.name, expected: g.canonical, original: g.originalText, envelope: g.envelope });
}
for (const ex of rendererExtras()) {
  cases.push({ name: ex.name, expected: ex.canonical, original: ex.original, envelope: synthEnvelope(ex.original, 'req-' + ex.name) });
}

// ---------- 本地 HTTP 服务（真实 UI 文件 + 生成的 harness 页 + fixtures） ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (url === '/__harness') {
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:16px;font-family:-apple-system,'PingFang SC',sans-serif;background:#fff;}
      .stage{width:480px;}
      ${aibodyRule}
      ${bubbleRule.replace('max-height:132px', 'max-height:none')}
      .aibody{background:#fafafa;border:1px solid #ddd;}
    </style><div class="stage"><div class="aibody" id="body-el"></div><div class="bubble" id="bubble-el"></div></div>
    <div class="stage" style="margin-top:24px"><div class="aibody" id="perfbody"></div></div>
    <script src="/rich-text.js"></script>`;
    return send(200, 'text/html; charset=utf-8', html);
  }
  if (url === '/__fixtures') {
    return send(200, 'application/json', JSON.stringify(cases));
  }
  const file = path.normalize(path.join(UI_DIR, url));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(404, 'text/plain', 'not found');
  }
  const mime = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain';
  return send(200, mime, fs.readFileSync(file));
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// ---------- Chrome ----------
const chromeProc = await startChrome();
let cdp;
const cleanup = () => { try { cdp && cdp.close(); } catch (_) {} try { chromeProc.child.kill(); } catch (_) {} server.close(); };
process.on('exit', cleanup);
try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.go(base + '/__harness');

  // ---- D1：真实 DOM textContent 与 canonical 逐 codepoint 一致（.aibody 与 .bubble 双容器） ----
  const d1 = await cdp.eval(`(async () => {
    const cases = await (await fetch('/__fixtures')).json();
    const bodyEl = document.getElementById('body-el'), bubbleEl = document.getElementById('bubble-el');
    const out = [];
    for (const c of cases) {
      renderPlain(bodyEl, readerBody(c.envelope, c.original).text);
      renderPlain(bubbleEl, readerBody(c.envelope, c.original).text);
      const a = [...bodyEl.textContent], b = [...bubbleEl.textContent], e = [...c.expected];
      let diff = -1;
      for (let i = 0; i < Math.max(a.length, e.length); i++) if (a[i] !== e[i]) { diff = i; break; }
      out.push({
        name: c.name,
        textOk: diff < 0 && b.length === e.length && b.join('') === e.join(''),
        len: a.length, expLen: e.length, diffAt: diff,
        noElements: bodyEl.childElementCount === 0 && bubbleEl.childElementCount === 0
          && [...bodyEl.childNodes, ...bubbleEl.childNodes].every(n => n.nodeType === 3),
        noCR: bodyEl.textContent.indexOf('\\r') < 0 && bubbleEl.textContent.indexOf('\\r') < 0,
        previewEqualsDetail: bodyEl.textContent === bubbleEl.textContent,
      });
    }
    return out;
  })()`);
  for (const r of d1) {
    check('D1-canonical', `${r.name}: DOM textContent===canonical（双容器，逐 codepoint）`, r.textOk,
      `len ${r.len} vs ${r.expLen}, diffAt ${r.diffAt}`);
    check('D1-nodes', `${r.name}: 只含文本节点（无元素、无字面 <br> 变标签）`, r.noElements);
    check('D1-newlines', `${r.name}: 规范换行后无 CR 残留`, r.noCR);
    check('D1-parity', `${r.name}: .aibody 与 .bubble 输出恒等`, r.previewEqualsDetail);
  }

  // ---- D2：敌意标记不执行 ----
  const d2 = await cdp.eval(`(() => {
    const bodyEl = document.getElementById('body-el');
    bodyEl.textContent = '';
    const r = readerBody(${JSON.stringify(cases.find(c => c.name === 'x01-literal-br-and-tags.txt').envelope)}, '');
    renderPlain(bodyEl, r.text);
    return {
      pwned: typeof window.__PWNED__ !== 'undefined',
      scripts: document.querySelectorAll('#body-el script, #body-el img, #body-el br').length,
      visible: bodyEl.textContent.includes('<script>') && bodyEl.textContent.includes('<br>'),
    };
  })()`);
  check('D2-hostile', '敌意 <script>/<img onerror>/字面 <br>：不执行、不成元素、按文本可见', !d2.pwned && d2.scripts === 0 && d2.visible, JSON.stringify(d2));

  // ---- D3：长行横向滚动 / 可断行文本不横向溢出 ----
  const d3 = await cdp.eval(`(() => {
    const el = document.getElementById('body-el');
    const x06 = ${JSON.stringify(cases.find(c => c.name === 'x06-unbroken-long-line.txt').expected)};
    renderPlain(el, x06);
    const longOverflow = el.scrollWidth > el.clientWidth + 1;
    const x07 = ${JSON.stringify(cases.find(c => c.name === 'x07-wrappable-cjk-long.txt').expected)};
    renderPlain(el, x07);
    const cjkFit = el.scrollWidth <= el.clientWidth + 1 && el.clientHeight > 20; // 换成了多行
    renderPlain(el, x06);
    const longRects = el.getClientRects().length;
    return { longOverflow, cjkFit, longScrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  })()`);
  check('D3-scroll', '4000 字符不可断行 → 横向滚动（scrollWidth>clientWidth）', d3.longOverflow, JSON.stringify(d3));
  check('D3-wrap', '可断行 CJK 长行 → 正常换行不横向溢出', d3.cjkFit, JSON.stringify(d3));

  await cdp.screenshot(path.join(outDir, 'dom-harness-x06-longline.png'));

  // ---- D4：真实 capture-mini.html 预览页 = 同一 plain renderer 输出 ----
  await cdp.go(base + '/capture-mini.html');
  for (const pick of ['b03-crlf.txt', 'b11-middle-dot.txt', 'x01-literal-br-and-tags.txt', 'legacy-looks-md.txt']) {
    const c = cases.find((x) => x.name === pick);
    const got = await cdp.eval(`(() => {
      applyCapture({ request_id: 'req-dom', text: ${JSON.stringify(c.original)}, app: 'T', ws: '', sr: '', wid: 0, channel: 'ax', content: ${JSON.stringify(c.envelope)} });
      const b = document.getElementById('bubble');
      return { text: b.textContent, elements: b.childElementCount, cls: b.className };
    })()`);
    const legacy = await cdp.eval(`(() => {
      applyCapture({ request_id: 'req-dom2', text: ${JSON.stringify(c.original)}, app: 'T' });
      return document.getElementById('bubble').textContent;
    })()`);
    check('D4-preview', `${pick}: 真实预览页 textContent===canonical（信封路径）`, got.text === c.expected && got.elements === 0 && !/\brich\b/.test(got.cls),
      `len ${[...got.text].length} vs ${[...c.expected].length}`);
    check('D4-preview-legacy', `${pick}: 无信封 legacy 通路输出恒等`, legacy === c.expected);
  }
  // bytes 信封 → 预览显式不可渲染说明（不伪装文本）
  const rtfGolden = loadGoldens().find((g) => g.binary);
  const bytesPrev = await cdp.eval(`(() => {
    applyCapture({ request_id: 'req-bytes', text: '', app: 'T', content: ${JSON.stringify(rtfGolden.envelope)} });
    return document.getElementById('bubble').textContent;
  })()`);
  check('D4-bytes', 'rtf bytes 信封 → 预览显式「不可按文本渲染」而非伪文本', bytesPrev.includes('二进制原文'), JSON.stringify(bytesPrev.slice(0, 40)));
  await cdp.screenshot(path.join(outDir, 'dom-capturemini-preview.png'));

  // ---- D5：性能（100KB / 1MB）——真实 renderer + 提取 CSS ----
  await cdp.go(base + '/__harness');
  const hw = { cpus: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 1024 / 1024 / 1024), node: process.version };
  const perf = await cdp.eval(`(async () => {
    async function perfCase(text) {
      const el = document.getElementById('perfbody');
      const t0 = performance.now();
      el.textContent = text;                       // = renderPlain 的唯一写法
      const t1 = performance.now();
      const h = el.offsetHeight;                   // 强制 layout
      const t2 = performance.now();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t3 = performance.now();
      return { setMs: t1 - t0, layoutMs: t2 - t1, paintMs: t3 - t2, heightPx: h };
    }
    function responsiveness(ms) {
      return new Promise(res => { const deadline = performance.now() + ms; let max = 0, last = performance.now();
        (function tick(){ const n = performance.now(); max = Math.max(max, n - last); last = n;
          if (performance.now() < deadline) setTimeout(tick, 5); else res(max); })(); });
    }
    const mk = (n) => ${synthBody.toString()}(n);
    const idle = await responsiveness(600);
    const s100 = mk(100 * 1024), s1m = mk(1024 * 1024);
    const [r100, p100] = await Promise.all([responsiveness(900), perfCase(s100)]);
    const [r1m, p1m] = await Promise.all([responsiveness(1200), perfCase(s1m)]);
    const cps = (s) => [...s].length;
    return { idleMaxMs: idle, c100: { codepoints: cps(s100), ...p100, maxTimerDriftMs: r100 },
             c1m: { codepoints: cps(s1m), ...p1m, maxTimerDriftMs: r1m } };
  })()`);
  const version = await (await fetch(`http://127.0.0.1:${chromeProc.cdpPort}/json/version`)).json();
  const perfRecord = { hardware: hw, chrome: version.Browser, ...perf };
  fs.writeFileSync(path.join(outDir, 'perf-100k-1m.json'), JSON.stringify(perfRecord, null, 2));
  check('D5-perf-recorded', '100KB/1MB 渲染记录已产出（set/layout/paint/响应性）',
    perf.c100.codepoints === 100 * 1024 && perf.c1m.codepoints === 1024 * 1024 && perf.c100.setMs >= 0 && perf.c1m.setMs >= 0,
    JSON.stringify({ c100: perf.c100, c1m: perf.c1m }).slice(0, 200));

  cleanup();
} catch (e) {
  cleanup();
  console.error('dom.test.mjs 异常:', e);
  process.exit(1);
}

const summary = { suite: 'dom', total: results.length, pass: results.length - fail, fail, at: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, 'dom-results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\ndom.test.mjs: ${summary.pass}/${summary.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
