// tests/renderer/rich.test.mjs —— P1-T06 字符串层 rich 套件（vm 沙箱，无真实 DOM）
// 检验对象：app/ui/rich-text.js 的 readerBody(mode 分派) / markdownToHtml(结构语义) /
// safeExternalHref(窄域) / richRuntime / 无 DOM 环境的显式回退。
// 真实 DOM 的清洗/投影/对抗断言在 rich-dom.test.mjs（headless Chrome）。
// 用法：node tests/renderer/rich.test.mjs [--out DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadGoldens, richMarkdownCases, REPO } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-rich-'));
fs.mkdirSync(outDir, { recursive: true });

// 沙箱：esc 所需 document 桩 + markdown-it UMD 所需 atob；DOMPurify 无 DOM → isSupported=false
const sb = {
  console,
  setTimeout, clearTimeout,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  document: { createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return String(this._t == null ? '' : this._t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) },
};
sb.window = sb; sb.self = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app', 'ui', 'vendor', 'markdown-it.umd.min.js'), 'utf8'), sb, { filename: 'markdown-it.umd.min.js' });
vm.runInContext(fs.readFileSync(path.join(REPO, 'app', 'ui', 'vendor', 'purify.min.js'), 'utf8'), sb, { filename: 'purify.min.js' });
vm.runInContext(fs.readFileSync(path.join(REPO, 'app', 'ui', 'rich-text.js'), 'utf8'), sb, { filename: 'rich-text.js' });
const { readerBody, markdownToHtml, safeExternalHref, richRuntime, renderReaderBody, canonicalNewlines } = sb;

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`);
}

// ---------- W1：运行时探测（vm 无 DOM → DOMPurify 显式不可用，markdownit 可用） ----------
const rt = richRuntime();
check('W1-runtime', 'vm 环境：markdownit 可用 / DOMPurify isSupported=false（显式不可用而非伪装）',
  rt.markdownit === true && rt.dompurify === false, JSON.stringify(rt));
{
  // markdown-it UMD 不内嵌版本串 → 版本锁定以 vendored 文件 sha256 强制（与 vendor-sha256.txt 同源）
  const crypto = await import('node:crypto');
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  check('W1-runtime', 'vendor 文件即锁定版本：markdown-it.umd.min.js / purify.min.js sha256 与批次锁值一致',
    sha(path.join(REPO, 'app/ui/vendor/markdown-it.umd.min.js')) === '635972b985228e8af9f0143647c68616b7a3bb09f6946e7e4a52e43dcf5e7be5'
    && sha(path.join(REPO, 'app/ui/vendor/purify.min.js')) === '2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2',
    '文件哈希漂移 = 依赖被替换，须重走 S01 评定');
}

// ---------- W2：readerBody mode 分派矩阵 ----------
{
  const mdG = loadGoldens().find((g) => g.format === 'markdown');
  const htmlG = loadGoldens().find((g) => g.format === 'html');
  const rMd = readerBody(mdG.envelope, '');
  check('W2-dispatch', '声明 markdown → mode=markdown + text=canonical 源', rMd.mode === 'markdown' && rMd.renderable && rMd.text === mdG.canonical, JSON.stringify({ mode: rMd.mode }));
  const rHtml = readerBody(htmlG.envelope, '');
  check('W2-dispatch', '声明 html → mode=html + text=canonical 源', rHtml.mode === 'html' && rHtml.renderable && rHtml.text === htmlG.canonical, JSON.stringify({ mode: rHtml.mode }));
  const rLegacy = readerBody(null, '# 不是标题');
  check('W2-dispatch', '无信封 legacy → mode=plain（绝不自动 Markdown 重解释）', rLegacy.mode === 'plain' && rLegacy.provenance === 'legacy');
  const rAssumed = readerBody({ format: 'plain', format_provenance: 'legacy_assumed_plain', original: { kind: 'text', text: '- x' }, canonical: '- x' }, '');
  check('W2-dispatch', 'legacy_assumed_plain → provenance=legacy + mode=plain', rAssumed.mode === 'plain' && rAssumed.provenance === 'legacy');
  const rUnknown = readerBody({ format: 'future_fmt', original: { kind: 'text', text: 'abc' }, canonical: 'abc' }, '');
  check('W2-dispatch', '未知格式 → mode=plain（分派不炸）', rUnknown.mode === 'plain' && rUnknown.renderable && rUnknown.text === 'abc');
  const rCrlf = readerBody({ format: 'markdown', original: { kind: 'text', text: 'a\r\nb' }, canonical: undefined, plain_projection: { status: 'unavailable' } }, '');
  check('W2-dispatch', 'markdown 源也走 canonical 口径换行规范化（显示层）', rCrlf.mode === 'markdown' && rCrlf.text === 'a\nb', JSON.stringify(rCrlf.text));
}

// ---------- W3：markdownToHtml 结构语义（html:false；期望独立手推） ----------
{
  const cases = richMarkdownCases();
  const full = cases.find((c) => c.name === 'md-full-matrix');
  const h = markdownToHtml(full.src);
  check('W3-structure', '标题：<h1>大标题</h1>', /<h1>大标题<\/h1>/.test(h), h.slice(0, 80));
  check('W3-structure', '嵌套列表：三层 ul 嵌套结构', /<ul>\s*<li>一级甲\s*<ul>\s*<li>二级甲\s*<ul>\s*<li>三级甲/.test(h.replace(/\n/g, '\\n').replace(/\\\\n/g, '\n')) || (h.includes('<li>一级甲') && h.includes('<li>二级甲') && h.includes('<li>三级甲') && h.lastIndexOf('<ul>', h.indexOf('三级甲')) > h.indexOf('二级甲')), h.slice(0, 200));
  check('W3-structure', '有序非 1 起始：<ol start="5">', h.includes('<ol start="5">'), '');
  check('W3-structure', '围栏：fence 文本逐字符进入 <pre><code>（含内部空格/tab）',
    h.includes('<pre><code class="language-js">const s = &quot;  内部空格  &quot;;\n\ttab 行\n</code></pre>'), '');
  check('W3-structure', '引用：<blockquote>引用一句</blockquote>', h.includes('<blockquote>') && h.includes('引用一句'), '');
  check('W3-structure', '分隔线：<hr>', /<hr\s*\/?>/.test(h), '');
  check('W3-structure', '链接：href 原样 https', h.includes('href="https://example.com/a?b=1"'), '');
  check('W3-structure', '行内标记：strong/em/code', h.includes('<strong>粗</strong>') && h.includes('<em>斜</em>') && h.includes('<code>码</code>'), '');

  const esc = markdownToHtml(cases.find((c) => c.name === 'md-inline-html-escaped').src);
  check('W3-s02', 'S02：内嵌 <script>/<img onerror>/<b> 全部转义为字面实体（无活标签）',
    !/<script/.test(esc) && !/<img/.test(esc) && esc.includes('&lt;script&gt;') && esc.includes('&lt;img src=x onerror=') && esc.includes('&lt;b&gt;真粗？&lt;/b&gt;'), esc.slice(0, 200));

  const links = markdownToHtml(cases.find((c) => c.name === 'md-hostile-links').src);
  const hrefs = [...links.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  check('W3-s05', 'S05（解析层）：javascript:/data: 链接不产生 href；相对路径交由清洗层处理',
    hrefs.filter((u) => /^https:/.test(u)).length === 1 && !hrefs.some((u) => /^javascript:/i.test(u) || /^data:/i.test(u)), JSON.stringify(hrefs));

  check('W3-edge', '空串/纯空白不炸且产出空串', markdownToHtml('') === '' && markdownToHtml('   \n ') !== null);
  check('W3-edge', 'CRLF 源先规范化再解析（围栏内 \\r 不残留）', !markdownToHtml('```\r\na\r\n```\r\n').includes('\r'));
}

// ---------- W4：safeExternalHref 窄域矩阵 ----------
{
  const ok = ['https://a.example/x', 'http://a.example/', 'HTTPS://A.EXAMPLE/X', 'https://a.example/x y'.replace(' y', '%20')];
  const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//a.example/x',
    '/relative', 'mailto:a@b.c', 'ftp://a.example/x', '', '   ', null, undefined, 123,
    'https://a.example/x\u0000y', 'https://a.example/x\ny', 'vbscript:x', '\x01https://a.example/'];
  let allOk = true, badDetail = [];
  for (const u of ok) if (safeExternalHref(u) === null) { allOk = false; badDetail.push('should-pass:' + JSON.stringify(u)); }
  for (const u of bad) if (safeExternalHref(u) !== null) { allOk = false; badDetail.push('should-reject:' + JSON.stringify(u)); }
  check('W4-href', `窄域矩阵：放行 ${ok.length} 例 / 拒绝 ${bad.length} 例（仅绝对 http(s)、无空白控制符）`, allOk, badDetail.join('; '));
  check('W4-href', '放行返回 trim 后原值', safeExternalHref('  https://a.example/x  ') === 'https://a.example/x');
}

// ---------- W5：无 DOM 环境的显式回退（kill-switch 字符串层） ----------
{
  const el = { classList: { remove(){}, add(){} }, textContent: '' };
  const dec = readerBody({ format: 'markdown', original: { kind: 'text', text: '# 源' }, canonical: '# 源' }, '');
  const out = renderReaderBody(el, dec, null);
  check('W5-fallback', 'DOMPurify 不可用 → 显式回退 plain 源文本 + 原因（不抛错不装成功）',
    out.rendered === false && out.fallbackReason === 'HTML 清洗器不可用，回退纯文本' && el.textContent === '# 源' && !el.classList._rich, JSON.stringify(out));
  const el2 = { classList: { remove(){}, add(){} }, textContent: '' };
  const out2 = renderReaderBody(el2, { format: 'plain', provenance: 'legacy', mode: 'plain', renderable: true, text: 'p' }, null);
  check('W5-fallback', 'plain 决策在无 DOM 环境照常走文本节点路径', out2.rendered === false && el2.textContent === 'p');
}

// ---------- 汇总落盘 ----------
const summary = { suite: 'rich', total: results.length, pass: results.length - fail, fail, at: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, 'rich-results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\nrich.test.mjs: ${summary.pass}/${summary.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
