// tests/renderer/rich-dom.test.mjs —— P1-T06 真实 DOM 断言套件（headless Chrome + 真实 UI 源）
// 检验对象：app/ui/rich-text.js（经 <script src> 加载真文件）+ vendor markdown-it/DOMPurify
// + 真实 capture-mini.html 预览页 + tauri.conf.json 的 CSP 字串语义（meta CSP 复现页）。
// 覆盖：Matrix B Markdown 结构语义、S02 内嵌 HTML 逃逸、S03 敌意 fixture 清洗
// （零执行/零外部资源请求/零 on* 属性）、S04 投影确定性黄金值、S05 链接窄域出口、
// 回退开关与 vendor 缺失 kill-switch、预览/详情恒等。
// 用法：node tests/renderer/rich-dom.test.mjs [--out DIR]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoldens, richMarkdownCases, hostileHtmlCases, structuredHtmlCases, synthEnvelope, REPO, UI_DIR } from './fixtures.mjs';
import { startChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-rich-dom-'));
fs.mkdirSync(outDir, { recursive: true });

// 与 app/src-tauri/tauri.conf.json 的 security.csp 保持逐字一致（漂移即测试失败）
const TAURI_CONF = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const CSP_STRING = TAURI_CONF.app.security.csp;

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`);
}

const mdCases = richMarkdownCases();
const goldens = loadGoldens();
const mdGoldens = goldens.filter((g) => g.format === 'markdown');

// ---------- 本地 HTTP 服务（真实 UI 文件 + 三个 harness 变体页） ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (url === '/__mdcases') return send(200, 'application/json', JSON.stringify(mdCases));
  if (url === '/__mdgoldens') return send(200, 'application/json', JSON.stringify(mdGoldens.map((g) => ({ name: g.name, envelope: g.envelope, canonical: g.canonical }))));
  if (url === '/__hostile') return send(200, 'application/json', JSON.stringify(hostileHtmlCases()));
  if (url === '/__structured') return send(200, 'application/json', JSON.stringify(structuredHtmlCases()));
  if (url === '/__harness' || url === '/__novendor' || url === '/__cspmeta') {
    const withVendor = url !== '/__novendor';
    const cspMeta = url === '/__cspmeta' ? `<meta http-equiv="Content-Security-Policy" content="${CSP_STRING.replace(/"/g, '&quot;')}">` : '';
    const vendorTags = withVendor
      ? '<script src="/vendor/markdown-it.umd.min.js"></script>\n<script src="/vendor/purify.min.js"></script>' : '';
    // 注意：CSP 变体页不放任何内联 script（meta CSP 无 unsafe-inline，内联必被挡——这正是要验证的）
    const html = `<!doctype html><meta charset="utf-8">${cspMeta}<style>
      body{margin:0;padding:16px;font-family:-apple-system,'PingFang SC',sans-serif;background:#fff;}
      .stage{width:480px;}
      .aibody{ padding:12px 15px 13px; font-size:13px; line-height:1.7; white-space:pre-wrap;
        overflow-wrap:normal; word-break:normal; overflow-x:auto; }
      .aibody.rich{ white-space:normal; }
      .aibody.rich pre{ margin:0 0 10px; padding:8px 10px; overflow-x:auto; }
    </style>
    ${vendorTags}
    <script src="/rich-text.js"></script>
    <div class="stage"><div class="aibody" id="body-el"></div></div>
    <div class="stage"><div class="aibody" id="body-el2"></div></div>`;
    return send(200, 'text/html; charset=utf-8', html);
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

const chromeProc = await startChrome();
let cdp;
const netRequests = [];
const cleanup = () => { try { cdp && cdp.close(); } catch (_) {} try { chromeProc.child.kill(); } catch (_) {} server.close(); };
process.on('exit', cleanup);
try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (p) => { if (p.request && p.request.url) netRequests.push(p.request.url); });
  const remoteUrls = () => netRequests.filter((u) => !u.startsWith(`http://127.0.0.1:${port}`) && u !== 'about:blank');

  await cdp.go(base + '/__harness');

  // ---- X0：vendor 加载 + 版本锁定（DOMPurify 运行时可读版本；markdown-it 以文件哈希锁） ----
  const x0 = await cdp.eval(`(() => ({
    markdownit: typeof markdownit, dompurify: typeof DOMPurify,
    dpVersion: (typeof DOMPurify==='function'&&DOMPurify.version)?String(DOMPurify.version):null,
    dpSupported: DOMPurify.isSupported === true,
    rt: richRuntime(),
  }))()`);
  check('X0-vendor', 'vendor 两库经 script src 加载：markdownit/DOMPurify 全局就绪', x0.markdownit === 'function' && x0.dompurify === 'function', JSON.stringify(x0));
  check('X0-vendor', 'DOMPurify 版本 = 3.4.16（锁定）', x0.dpVersion === '3.4.16', x0.dpVersion);
  check('X0-vendor', 'richRuntime()：双可用 + 版本串', x0.rt.markdownit && x0.rt.dompurify && !x0.rt.disabled && x0.rt.dompurifyVersion === '3.4.16', JSON.stringify(x0.rt));

  // ---- M1：Matrix B Markdown 结构语义（真实 DOM） ----
  const m1 = await cdp.eval(`(async () => {
    const cases = await (await fetch('/__mdcases')).json();
    const el = document.getElementById('body-el');
    const out = [];
    for (const c of cases) {
      const dec = readerBody({ format:'markdown', format_provenance:'declared', canonical:c.src, original:{kind:'text',text:c.src} }, '');
      const r = renderReaderBody(el, dec, null);
      const exp = c.expect;
      const res = { name: c.name, rendered: r.rendered, rich: el.classList.contains('rich'), facts: {} };
      if (c.name === 'md-full-matrix') {
        res.facts = {
          h1: [...el.querySelectorAll('h1')].map(h => h.textContent),
          ulDepthPath: [...el.querySelectorAll('ul li')].map(li => { let d=0,n=li.parentElement; while(n){ if(n.tagName==='UL'||n.tagName==='OL') d++; n=n.parentElement; } return d-1; }),
          olStart: el.querySelector('ol') && el.querySelector('ol').getAttribute('start'),
          olItems: [...el.querySelectorAll('ol>li')].map(li => li.textContent),
          fence: [...el.querySelectorAll('pre')].map(p => p.textContent),
          quote: [...el.querySelectorAll('blockquote')].map(b => b.textContent),
          hr: el.querySelectorAll('hr').length,
          linkHref: el.querySelector('a') && el.querySelector('a').getAttribute('href'),
          linkText: el.querySelector('a') && el.querySelector('a').textContent,
          strong: el.querySelector('strong') && el.querySelector('strong').textContent,
          em: el.querySelector('em') && el.querySelector('em').textContent,
          codeSpan: el.querySelector('p code, li code') && (el.querySelector('p code')||el.querySelector('li code')).textContent,
          lastPara: [...el.querySelectorAll('p')].pop() && [...el.querySelectorAll('p')].pop().textContent,
        };
      } else if (c.name === 'md-blank-lines-semantic') {
        res.facts = { pCount: el.querySelectorAll('p').length, text: el.textContent };
      } else if (c.name === 'md-indented-code') {
        res.facts = { preText: el.querySelector('pre') ? el.querySelector('pre').textContent : null };
      } else if (c.name === 'md-long-code-line') {
        const pre = el.querySelector('pre');
        res.facts = { exactChars: pre.textContent.length, overflow: pre.scrollWidth > pre.clientWidth + 1 };
      } else if (c.name === 'md-inline-html-escaped') {
        res.facts = {
          scriptEls: el.querySelectorAll('script,img,b').length,
          visible: el.textContent.includes('<script>') && el.textContent.includes('onerror=') && el.textContent.includes('<b>真粗？</b>'),
          pwned: typeof window.__MD_PWN__ !== 'undefined',
        };
      } else if (c.name === 'md-hostile-links') {
        res.facts = { hrefs: [...el.querySelectorAll('a')].map(a => a.getAttribute('href')) };
      }
      out.push(res);
    }
    return out;
  })()`);
  {
    const full = m1.find((r) => r.name === 'md-full-matrix');
    const f = full.facts, e = mdCases.find((c) => c.name === 'md-full-matrix').expect;
    check('M1-structure', '渲染成功且挂 rich 类', full.rendered && full.rich, JSON.stringify(full));
    check('M1-structure', 'B06/标题：h1 文本 =「大标题」（围栏内 # 不成标题）', JSON.stringify(f.h1) === JSON.stringify([e.h1Text]), JSON.stringify(f.h1));
    check('M1-structure', 'B07/嵌套列表：li 深度路径 [0,1,2,0]', JSON.stringify(f.ulDepthPath) === JSON.stringify(e.ulDepths), JSON.stringify(f.ulDepthPath));
    check('M1-structure', 'B08/有序列表：start=5 + 顺序正确', String(f.olStart) === String(e.olStart) && JSON.stringify(f.olItems) === JSON.stringify(e.olItems), JSON.stringify({ start: f.olStart, items: f.olItems }));
    check('M1-structure', 'B06/围栏：pre 文本逐字符精确（空格/tab/结尾换行不动）', JSON.stringify(f.fence) === JSON.stringify([e.fenceExact]), JSON.stringify(f.fence));
    check('M1-structure', '引用：blockquote 含引用文本', f.quote.length === 1 && f.quote[0].includes(e.quoteText), JSON.stringify(f.quote));
    check('M1-structure', 'B09/分隔线：恰一条 hr（不裂成列表）', f.hr === e.hrCount, String(f.hr));
    check('M1-structure', '链接/行内标记：href 原样、strong/em/code 文本', f.linkHref === e.linkHref && f.linkText === e.linkText && f.strong === e.strong && f.em === e.em && f.codeSpan === e.codeSpan, JSON.stringify(f));
    const blank = m1.find((r) => r.name === 'md-blank-lines-semantic');
    check('M1-structure', 'B02/多空行：显示语义分段（两段）；源文本未被改写（decision.text 见 M6）', blank.facts.pCount === 2 && blank.rendered, JSON.stringify(blank.facts));
    const indented = m1.find((r) => r.name === 'md-indented-code');
    check('M1-structure', 'B05/缩进代码块：4 空格块保留内部空白', indented.facts.preText === mdCases.find((c) => c.name === 'md-indented-code').expect.preText, JSON.stringify(indented.facts.preText));
    const long = m1.find((r) => r.name === 'md-long-code-line');
    check('M1-structure', 'B12/长码行：字符零丢失（短\\n+4000X+\\n=4003）+ pre 横向滚动', long.facts.exactChars === 4003 && long.facts.overflow, JSON.stringify(long.facts));
    const escaped = m1.find((r) => r.name === 'md-inline-html-escaped');
    check('M1-s02', 'S02：Markdown 内嵌 HTML 字面可见、不成元素、不执行', escaped.facts.scriptEls === 0 && escaped.facts.visible && !escaped.facts.pwned, JSON.stringify(escaped.facts));
    const links = m1.find((r) => r.name === 'md-hostile-links');
    check('M1-s05', 'S05（DOM 层）：存活 href 恰为窄域 https 集', JSON.stringify(links.facts.hrefs.filter(Boolean)) === JSON.stringify(mdCases.find((c) => c.name === 'md-hostile-links').expect.safeHrefs), JSON.stringify(links.facts.hrefs));
  }

  // ---- M2：golden markdown 信封（Rust 产物）经产品入口渲染 ----
  const m2 = await cdp.eval(`(async () => {
    const gs = await (await fetch('/__mdgoldens')).json();
    const el = document.getElementById('body-el');
    return gs.map(g => {
      const dec = readerBody(g.envelope, '');
      const r = renderReaderBody(el, dec, null);
      return { name: g.name, mode: dec.mode, text: dec.text, rendered: r.rendered,
        h1: [...el.querySelectorAll('h1,h2,h3')].map(h => h.textContent),
        pre: [...el.querySelectorAll('pre')].map(p => p.textContent),
        liDepths: [...el.querySelectorAll('ul li')].map(li => { let d=0,n=li.parentElement; while(n){ if(n.tagName==='UL'||n.tagName==='OL') d++; n=n.parentElement; } return d-1; }),
        olStart: el.querySelector('ol') ? el.querySelector('ol').getAttribute('start') : null,
        hr: el.querySelectorAll('hr').length };
    });
  })()`);
  {
    const b07 = m2.find((r) => r.name === 'b07-fenced-code.md');
    check('M2-golden', 'b07：源 text=canonical；h1=标题；围栏内文精确（# 不再成标题）',
      b07.mode === 'markdown' && b07.text === goldens.find((g) => g.name === 'b07-fenced-code.md').canonical
      && JSON.stringify(b07.h1) === JSON.stringify(['标题'])
      && b07.pre.length === 1 && b07.pre[0] === 'fn main() {\n    let s = "围栏内 # 不是标题";\n}\n',
      JSON.stringify(b07));
    const b08 = m2.find((r) => r.name === 'b08-nested-lists.md');
    check('M2-golden', 'b08：三级嵌套深度 [0,1,2,0]', JSON.stringify(b08.liDepths) === JSON.stringify([0, 1, 2, 0]), JSON.stringify(b08.liDepths));
    const b09 = m2.find((r) => r.name === 'b09-ordered-non1.md');
    check('M2-golden', 'b09：有序非 1 起始 start=3', b09.olStart === '3', JSON.stringify(b09));
    const b10 = m2.find((r) => r.name === 'b10-separator.md');
    check('M2-golden', 'b10：分隔线语义（hr=1，无列表）', b10.hr === 1 && b10.liDepths.length === 0, JSON.stringify(b10));
  }

  // ---- M3：敌意 HTML fixture（S03 清洗 + 零执行/零外联/零 on* 属性） ----
  // 用独立容器 body-el2：链接出口绑定在元素上（首次绑定即固定 opener），须未被前段污染
  const m3 = await cdp.eval(`(async () => {
    const hs = await (await fetch('/__hostile')).json();
    const el = document.getElementById('body-el2');
    const openerCalls = [];
    window.__OPENER_SPY__ = openerCalls;
    const out = [];
    for (const h of hs) {
      const dec = readerBody({ format:'html', format_provenance:'declared', canonical:h.src, original:{kind:'text',text:h.src} }, '');
      const r = renderReaderBody(el, dec, (u) => window.__OPENER_SPY__.push(u));
      const bad = {
        scripts: el.querySelectorAll('script').length,
        imgs: el.querySelectorAll('img,picture,video,audio,source,iframe,object,embed,svg,math').length,
        forms: el.querySelectorAll('form,input,button,textarea,select,meta,link,base,style').length,
        onAttrs: [...el.querySelectorAll('*')].filter(n => [...n.attributes].some(a => /^on/i.test(a.name) || a.name==='style' || a.name==='src' || a.name==='srcset')).length,
        badHrefs: [...el.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(Boolean).filter(u => !/^https:\\/\\//.test(u)),
      };
      // 敌意链接点击：清洗后的 a 全部 preventDefault + 仅窄域进 opener
      [...el.querySelectorAll('a')].forEach(a => a.click());
      out.push({ name: h.name, rendered: r.rendered, bad, textLen: [...el.textContent].length });
    }
    return { out, openerCalls: window.__OPENER_SPY__.slice() };
  })()`);
  {
    const EMPTY_OK = new Set(['h13-noscript-bypass']); // 整条输入即攻击载荷，无良性文本可保留：空渲染=诚实
    const bads = m3.out.filter((r) => r.bad.scripts || r.bad.imgs || r.bad.forms || r.bad.onAttrs || r.bad.badHrefs.length || !r.rendered || (r.textLen === 0 && !EMPTY_OK.has(r.name)));
    check('M3-hostile', `敌意 fixture ×${m3.out.length}：零 script/媒体/表单/样式标签、零 on*/style/src 属性、零非 https href、剥壳留文本可读（纯攻击载荷空渲染）`,
      bads.length === 0, JSON.stringify(bads.map((b) => ({ name: b.name, bad: b.bad, textLen: b.textLen }))));
    const pw = await cdp.eval(`(function(){ const m=[]; for (var k in window) if (/^__H\\d+__$/.test(k)) m.push(k); return m; })()`);
    check('M3-hostile', '全部 window.__H*__ 执行标记未定义（零脚本执行）', Array.isArray(pw) && pw.length === 0, JSON.stringify(pw));
    check('M3-hostile', 'opener 仅收到窄域 https（https://ok.example/n 与带空格版被清洗层剥 href 后不触发）',
      m3.openerCalls.every((u) => /^https:\/\/ok\.example\//.test(u)) && m3.openerCalls.length >= 1, JSON.stringify(m3.openerCalls));
    const remotes = remoteUrls();
    check('M3-network', `网络拦截：渲染全程零外部资源请求（requestWillBeSent 共 ${netRequests.length} 条全为本源）`, remotes.length === 0, JSON.stringify(remotes.slice(0, 5)));
    // 对照组：证明拦截手段有效（无 CSP 页面直接造 <img src=evil> 确实产生请求）
    await cdp.eval(`(() => { const i=document.createElement('img'); i.src='https://evil.example/control.png'; document.body.appendChild(i); })()`);
    await new Promise((r) => setTimeout(r, 400));
    check('M3-network', '对照组：未清洗 <img evil> 确实产生外部请求（拦截非盲区）', remoteUrls().some((u) => u.includes('evil.example/control.png')), JSON.stringify(remoteUrls().slice(-3)));
    await cdp.eval(`(() => { document.body.querySelectorAll('img').forEach(i=>i.remove()); })()`);
    netRequests.length = 0; // 后续段落重新累计
  }

  // ---- M4：mXSS 稳定性（清洗产物再解析等值） ----
  const m4 = await cdp.eval(`(async () => {
    const hs = await (await fetch('/__hostile')).json();
    const el = document.getElementById('body-el');
    const unstable = [];
    for (const h of hs) {
      const clean1 = sanitizeRichHtml(h.src);
      el.textContent=''; el.innerHTML = clean1;
      const roundTrip = el.innerHTML;
      const clean2 = sanitizeRichHtml(roundTrip);
      el.textContent=''; el.innerHTML = clean2;
      if (el.innerHTML !== clean1 || clean2 !== clean1) unstable.push({ name: h.name, clean1: clean1.slice(0,80), round: roundTrip.slice(0,80), clean2: clean2.slice(0,80) });
    }
    return unstable;
  })()`);
  check('M4-mxss', 'mXSS：清洗产物 innerHTML 往返再清洗逐字节稳定（×' + hostileHtmlCases().length + '）', m4.length === 0, JSON.stringify(m4.slice(0, 3)));

  // ---- M5：S04 plainProjection 确定性 + 黄金值 ----
  const m5 = await cdp.eval(`(async () => {
    const st = await (await fetch('/__structured')).json();
    const el = document.getElementById('body-el'), el2 = document.getElementById('body-el2');
    const out = [];
    for (const c of st) {
      const dec = readerBody({ format:'html', format_provenance:'declared', canonical:c.src, original:{kind:'text',text:c.src} }, '');
      renderReaderBody(el, dec, null);
      renderReaderBody(el2, dec, null);
      out.push({ name: c.name, proj1: plainProjection(el), proj2: plainProjection(el2),
                 projTwiceSame: plainProjection(el) === plainProjection(el2),
                 domSame: el.innerHTML === el2.innerHTML });
    }
    // markdown 投影确定性
    const mds = await (await fetch('/__mdcases')).json();
    const mdProj = [];
    for (const c of mds) {
      const dec = readerBody({ format:'markdown', format_provenance:'declared', canonical:c.src, original:{kind:'text',text:c.src} }, '');
      renderReaderBody(el, dec, null); const p1 = plainProjection(el);
      renderReaderBody(el2, dec, null); const p2 = plainProjection(el2);
      mdProj.push({ name: c.name, stable: p1 === p2, p1 });
    }
    return { out, mdProj };
  })()`);
  {
    const s = structuredHtmlCases()[0];
    const got = m5.out[0];
    check('M5-projection', '结构 HTML 投影黄金值（标题/列表 start/引用/表格/尾链）逐字符一致',
      got.proj1 === s.expectProjection, JSON.stringify({ got: got.proj1, want: s.expectProjection }));
    check('M5-projection', '同源双容器渲染 → DOM 与投影均恒等（确定性）', got.domSame && got.projTwiceSame);
    const unstable = m5.mdProj.filter((r) => !r.stable);
    check('M5-projection', `markdown 投影确定性 ×${m5.mdProj.length}`, unstable.length === 0, JSON.stringify(unstable.map((u) => u.name)));
    const fullProj = m5.mdProj.find((r) => r.name === 'md-full-matrix').p1;
    check('M5-projection', 'markdown 投影结构：嵌套缩进、计数从 5 起、围栏原文、引用前缀、hr、链接取文本',
      fullProj.includes('- 一级甲\n  - 二级甲\n    - 三级甲\n- 另一个一级')
      && fullProj.includes('5. 第五条\n6. 第六条') && fullProj.includes('const s = "  内部空格  ";') && fullProj.includes('> 引用一句') && fullProj.includes('---') && fullProj.includes('尾段 链接 与 粗 斜 码。'), JSON.stringify(fullProj));
  }

  // ---- M6：源保真（可复制原文）与 hash ----
  const m6 = await cdp.eval(`(async () => {
    const gs = await (await fetch('/__mdgoldens')).json();
    return gs.map(g => {
      const dec = readerBody(g.envelope, '');
      return { name: g.name, sourcePreserved: dec.text === g.canonical };
    });
  })()`);
  check('M6-source', 'decision.text = canonical 源（复制原文数据面不动，P1-T07 接线）', m6.every((r) => r.sourcePreserved), JSON.stringify(m6));

  // ---- M7：S05 链接点击矩阵（真实 click 事件；新造元素避免旧绑定污染） ----
  const m7 = await cdp.eval(`(() => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const calls = [];
    const results = {};
    function clickHref(href) {
      el.innerHTML = '<p><a href="' + href.replace(/"/g,'%22').replace(/&/g,'&amp;') + '">x</a></p>';
      el.classList.add('rich');
      wireRichLinks(el, (u) => calls.push(u));
      el.querySelector('a').click();
    }
    results.before = location.href;
    clickHref('https://ok.example/click1'); results.okCall = calls.slice();
    clickHref('javascript:window.__CLICK_PWN__=1'); results.jsCall = calls.slice();
    clickHref('HTTPS://OK.EXAMPLE/UPPER'); results.upper = calls.slice();
    results.after = location.href;
    results.pwned = typeof window.__CLICK_PWN__ !== 'undefined';
    el.remove();
    return results;
  })()`);
  check('M7-links', 'https 链接点击 → opener 收窄域 URL；javascript: 链接零新增调用零执行；页面不导航（大小写不敏感放行）',
    m7.okCall.length === 1 && m7.okCall[0] === 'https://ok.example/click1'
    && m7.jsCall.length === m7.okCall.length && !m7.pwned && m7.before === m7.after
    && m7.upper.length === m7.jsCall.length + 1 && m7.upper[m7.upper.length - 1] === 'HTTPS://OK.EXAMPLE/UPPER', JSON.stringify(m7));

  // ---- M8：回退开关（localStorage 全局停用） ----
  const m8 = await cdp.eval(`(() => {
    localStorage.setItem('nayan-rich-disable','1');
    const el = document.getElementById('body-el');
    const dec = readerBody({ format:'markdown', format_provenance:'declared', canonical:'# 源码态', original:{kind:'text',text:'# 源码态'} }, '');
    const r = renderReaderBody(el, dec, null);
    const out1 = { rendered: r.rendered, reason: r.fallbackReason, text: el.textContent, rich: el.classList.contains('rich') };
    localStorage.setItem('nayan-rich-disable','0');
    const r2 = renderReaderBody(el, dec, null);
    const out2 = { rendered: r2.rendered, rich: el.classList.contains('rich'), h1: el.querySelector('h1') ? el.querySelector('h1').textContent : null };
    localStorage.removeItem('nayan-rich-disable');
    return { out1, out2 };
  })()`);
  check('M8-killswitch', '停用位=1 → 回退 plain 源文本 + 原因；置 0 → rich 恢复（就地重渲）',
    m8.out1.rendered === false && m8.out1.reason === 'rich 渲染已停用（回退开关）' && m8.out1.text === '# 源码态' && !m8.out1.rich
    && m8.out2.rendered && m8.out2.rich && m8.out2.h1 === '源码态', JSON.stringify(m8));

  // ---- M9：vendor 缺失 kill-switch（无 vendor 变体页） ----
  await cdp.go(base + '/__novendor');
  const m9 = await cdp.eval(`(() => {
    const el = document.getElementById('body-el');
    const rt = richRuntime();
    const decMd = readerBody({ format:'markdown', format_provenance:'declared', canonical:'# 无解析器', original:{kind:'text',text:'# 无解析器'} }, '');
    const rMd = renderReaderBody(el, decMd, null);
    const mdOut = { rendered: rMd.rendered, reason: rMd.fallbackReason, text: el.textContent, rich: el.classList.contains('rich') };
    const decHtml = readerBody({ format:'html', format_provenance:'declared', canonical:'<p>html 无清洗器</p>', original:{kind:'text',text:'<p>html 无清洗器</p>'} }, '');
    const rHtml = renderReaderBody(el, decHtml, null);
    const htmlOut = { rendered: rHtml.rendered, reason: rHtml.fallbackReason, text: el.textContent, rich: el.classList.contains('rich') };
    return { rt: { markdownit: rt.markdownit, dompurify: rt.dompurify }, mdOut, htmlOut };
  })()`);
  check('M9-novendor', 'vendor 缺失：markdownit/DOMPurify 均未定义（页面其余功能不受影响）', m9.rt.markdownit === false && m9.rt.dompurify === false, JSON.stringify(m9.rt));
  check('M9-novendor', 'markdown 行 → 显式回退源文本 + 原因（不抛错不装成功）', m9.mdOut.rendered === false && m9.mdOut.reason === 'markdown 解析器未加载，回退纯文本' && m9.mdOut.text === '# 无解析器' && !m9.mdOut.rich, JSON.stringify(m9.mdOut));
  check('M9-novendor', 'html 行 → 显式回退源文本 + 原因', m9.htmlOut.rendered === false && m9.htmlOut.reason === 'HTML 清洗器不可用，回退纯文本' && m9.htmlOut.text === '<p>html 无清洗器</p>' && !m9.htmlOut.rich, JSON.stringify(m9.htmlOut));

  // ---- M10：CSP 字串语义（meta CSP 复现页 = tauri.conf 同串） ----
  netRequests.length = 0;
  await cdp.go(base + '/__cspmeta');
  const CSP_MD_SRC = '# CSP 下渲染\n\n- 项';
  const m10 = await cdp.eval(`(async () => {
    const out = { markdownit: typeof markdownit, dompurify: typeof DOMPurify, dp: DOMPurify.isSupported === true };
    // 远程脚本：必须被 script-src 拦（动态 script 加载 rejected）
    out.remoteScriptBlocked = await new Promise(res => {
      const s = document.createElement('script'); s.src = 'https://evil.example/r.js';
      s.onerror = () => res(true); s.onload = () => res(false);
      document.head.appendChild(s);
    });
    // 远程 fetch：connect-src 只放 ipc:/本源 → TypeError
    try { await fetch('https://evil.example/f'); out.remoteFetchBlocked = false; }
    catch (e) { out.remoteFetchBlocked = true; }
    // 远程 img：img-src 不含 evil → 加载失败
    out.remoteImgBlocked = await new Promise(res => {
      const i = new Image(); i.onload = () => res(false); i.onerror = () => res(true);
      i.src = 'https://evil.example/i.png';
    });
    // 本源渲染仍完整工作（在 CSP 下）
    const el = document.getElementById('body-el');
    const dec = readerBody({ format:'markdown', format_provenance:'declared', canonical: ${JSON.stringify(CSP_MD_SRC)}, original:{kind:'text',text:'x'} }, '');
    const r = renderReaderBody(el, dec, null);
    out.renderUnderCsp = r.rendered && el.querySelector('h1') && el.querySelector('li');
    return out;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  check('M10-csp', `CSP 串（tauri.conf 同串）：本源 vendor+renderer 可用`, m10.markdownit === 'function' && m10.dompurify && m10.renderUnderCsp, JSON.stringify(m10));
  check('M10-csp', 'CSP 串：远程 script/fetch/img 全被拦（零外部资源请求）', m10.remoteScriptBlocked && m10.remoteFetchBlocked && m10.remoteImgBlocked, JSON.stringify(m10));
  const ev = remoteUrls().filter((u) => u.includes('evil.example'));
    check('M10-csp', 'CSP 页外联仅两条主动探针（r.js/i.png，均被拦失败）；无其他任何外部请求（requestWillBeSent 可见被拦发起，失败证据在前一断言）',
      ev.length === 2 && remoteUrls().length === 2, JSON.stringify(remoteUrls()));

  // ---- M11：真实 capture-mini.html 预览 = 详情同源渲染（预览/详情对照） ----
  await cdp.go(base + '/capture-mini.html');
  const m11 = await cdp.eval(`(async () => {
    const mdSrc = ${JSON.stringify(mdCases.find(c => c.name === 'md-full-matrix').src)};
    const env = { format:'markdown', format_provenance:'declared', canonical: mdSrc, original:{kind:'text',text: mdSrc} };
    applyCapture({ request_id:'req-rich-prev', text: mdSrc, app:'T', ws:'', sr:'', wid:0, channel:'ax', content: env });
    const b = document.getElementById('bubble');
    const sig = (root) => [...root.querySelectorAll('*')].map(n => n.tagName).join(',');
    return { cls: b.className, sig: sig(b), proj: plainProjection(b), preText: b.querySelector('pre') ? b.querySelector('pre').textContent : null,
             links: [...b.querySelectorAll('a')].length };
  })()`);
  // 详情侧同源渲染取签名
  await cdp.go(base + '/__harness');
  const m11b = await cdp.eval(`(() => {
    const mdSrc = ${JSON.stringify(mdCases.find(c => c.name === 'md-full-matrix').src)};
    const el = document.getElementById('body-el');
    const dec = readerBody({ format:'markdown', format_provenance:'declared', canonical: mdSrc, original:{kind:'text',text: mdSrc} }, '');
    renderReaderBody(el, dec, null);
    const sig = (root) => [...root.querySelectorAll('*')].map(n => n.tagName).join(',');
    return { cls: el.className, sig: sig(el), proj: plainProjection(el), preText: el.querySelector('pre') ? el.querySelector('pre').textContent : null };
  })()`);
  check('M11-parity', '预览/详情对照：同一 markdown 源 → 标签路径签名恒等', m11.sig === m11b.sig, JSON.stringify({ preview: m11.sig.slice(0, 80), detail: m11b.sig.slice(0, 80) }));
  check('M11-parity', '预览/详情对照：plainProjection 恒等', m11.proj === m11b.proj);
  check('M11-parity', '预览/详情对照：围栏内文恒等（代码字符不变）', m11.preText === m11b.preText && m11.preText === mdCases.find((c) => c.name === 'md-full-matrix').expect.fenceExact);
  check('M11-parity', '预览端 rich 类挂载；链接存在但惰性（无 opener 注入）', /\brich\b/.test(m11.cls) && m11.links >= 1, JSON.stringify(m11.cls));
  await cdp.screenshot(path.join(outDir, 'rich-dom-full-matrix.png'));

  // 敌意信封在真实预览页
  await cdp.go(base + '/capture-mini.html');
  const m11c = await cdp.eval(`(() => {
    const src = ${JSON.stringify(hostileHtmlCases().map(h => h.src).join('\n'))};
    const env = { format:'html', format_provenance:'declared', canonical: src, original:{kind:'text',text: src} };
    applyCapture({ request_id:'req-rich-hostile', text: src, app:'T', content: env });
    const b = document.getElementById('bubble');
    return { dangerous: b.querySelectorAll('script,img,iframe,object,embed,svg,form,style,meta,link').length,
             onAttrs: [...b.querySelectorAll('*')].filter(n => [...n.attributes].some(a => /^on/i.test(a.name) || a.name==='style')).length,
             pwned: (function(){ for (var k in window) if (/^__H\\d+__$/.test(k)) return k; return null; })(),
             readable: b.textContent.includes('ok') };
  })()`);
  check('M11-hostile', '真实预览页敌意信封：零危险标签/零 on*/style、零执行、可读', m11c.dangerous === 0 && m11c.onAttrs === 0 && m11c.pwned === null && m11c.readable, JSON.stringify(m11c));
  await cdp.screenshot(path.join(outDir, 'rich-dom-capturemini-hostile.png'));

  cleanup();
} catch (e) {
  cleanup();
  console.error('rich-dom.test.mjs 异常:', e);
  process.exit(1);
}

const summary = { suite: 'rich-dom', total: results.length, pass: results.length - fail, fail, at: new Date().toISOString(), chrome: (await (await fetch(`http://127.0.0.1:${chromeProc.cdpPort}/json/version`).catch(() => ({ json: async () => ({}) }))).json()).Browser };
fs.writeFileSync(path.join(outDir, 'rich-dom-results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\nrich-dom.test.mjs: ${summary.pass}/${summary.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
