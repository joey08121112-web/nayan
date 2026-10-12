// tests/roundtrip/copy-helpers.test.mjs — P1-T07 / Step 2 语义层（独立期望=先于实现冻结的
// batches/P1-B07/COPY-CONTRACT.md；不从待测输出生成 golden）。
// VM 载入真实 rich-text.js（非副本），断言 copyResponsePayload / copyOriginalPayload
// 的逐格式语义、边界与拒绝。用法: node tests/roundtrip/copy-helpers.test.mjs --out DIR
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseArgs, preflightOut } from '../renderer/nayan-reader-view/preflight-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { '--out': outDir } = parseArgs(process.argv.slice(2), { '--out': 'value' });
preflightOut(outDir, REPO);
fs.mkdirSync(outDir, { recursive: true });

// rich-text.js 是无导出全局脚本：vm 沙箱求值后取函数绑定（markdown-it UMD 经 require 注入，
// 与既有 renderer 套件同法）。本测试只触 helpers+plainProjection，不需要 DOM。
const sandbox = {
  window: {}, document: null, console,
  require: (m) => { if (m && m.includes && m.includes('markdown-it')) return require(path.join(REPO, 'app/ui/vendor/markdown-it.umd.min.js')); if (m && m.includes && m.includes('purify')) return { sanitize: (x) => x }; throw new Error('unexpected require ' + m); },
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout, clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(REPO, 'app/ui/rich-text.js'), 'utf8');
vm.runInContext(src, sandbox);
const { copyResponsePayload, copyOriginalPayload } = sandbox;
if (typeof copyResponsePayload !== 'function' || typeof copyOriginalPayload !== 'function') throw new Error('helpers not defined after vm load');

const results = []; let fail = 0;
function check(name, ok, detail = '') { results.push({ name, ok, detail }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`); }
const eq = (a, b) => a === b;

// ---- 独立期望（与 COPY-CONTRACT 语义表逐行对应） ----
const CANON = '# 标题\n\n段落 中文 e\u0301  尾随空格  \n- 列表\n';
const ORIG_CRLF = '# 标题\r\n\r\n段落 中文 e\u0301  尾随空格  \r\n- 列表\r\n'; // original 保留 CRLF；canonical 已归一

// Copy Response：plain/legacy → canonical（一次换行归一，其余原样）
{
  const r = copyResponsePayload({ format: 'plain', provenance: 'legacy', mode: 'plain', renderable: true, text: CANON }, null);
  check('resp-plain-legacy-canonical', r.ok === true && eq(r.payload, CANON), JSON.stringify(r).slice(0, 120));
}
// Copy Response：declared markdown → canonical 源码（非 DOM innerText；不依赖容器）
{
  const r = copyResponsePayload({ format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: CANON }, null);
  check('resp-markdown-canonical-source', r.ok === true && eq(r.payload, CANON), JSON.stringify(r).slice(0, 120));
}
// Copy Response：declared html → 仅完成态 rich 容器的确定性投影
{
  // R1-SR-F02 修复后语义：载荷=完成时点投影缓存（__nayanHtmlProjection），控件文字永不入载荷
  const cacheEl = { classList: { contains: (c) => c === 'rich' }, childNodes: [], tagName: 'DIV', __nayanHtmlProjection: '小标题\n\n正文段\n\n- 项一' };
  const rCached = copyResponsePayload({ format: 'html', provenance: 'declared', mode: 'html', renderable: true, text: '<x>' }, cacheEl);
  check('resp-html-cached-projection', rCached.ok === true && rCached.payload === '小标题\n\n正文段\n\n- 项一', JSON.stringify(rCached).slice(0, 120));
  const noCache = { classList: { contains: (c) => c === 'rich' }, childNodes: [], tagName: 'DIV' };
  const rNoCache = copyResponsePayload({ format: 'html', provenance: 'declared', mode: 'html', renderable: true, text: '<x>' }, noCache);
  check('resp-html-no-cache-rejected（未完成=拒绝）', rNoCache.ok === false && /投影不可用/.test(rNoCache.reason), JSON.stringify(rNoCache));
  const wrongCache = { classList: { contains: () => false }, childNodes: [], tagName: 'DIV', __nayanHtmlProjection: 'p' };
  const rWrong = copyResponsePayload({ format: 'html', provenance: 'declared', mode: 'html', renderable: true, text: '<x>' }, wrongCache);
  check('resp-html-fallback-state-rejected（非 rich 态=拒绝）', rWrong.ok === false, JSON.stringify(rWrong));
}
// Copy Response：bytes → 显式不可文本复制
{
  const r = copyResponsePayload({ format: 'bytes', provenance: 'declared', mode: 'plain', renderable: false, reason: '二进制内容' }, null);
  check('resp-bytes-rejected', r.ok === false && /二进制/.test(r.reason), JSON.stringify(r));
}
// Copy Response：不可渲染/加载失败 → 显式原因，不产出载荷
{
  const r = copyResponsePayload({ format: 'plain', provenance: 'legacy', mode: 'plain', renderable: false, reason: '正文读取失败：X' }, null);
  check('resp-unavailable-reason', r.ok === false && eq(r.reason, '正文读取失败：X'), JSON.stringify(r));
  const r2 = copyResponsePayload(null, null);
  check('resp-missing-context', r2.ok === false, JSON.stringify(r2));
}

// Copy Original：text → original.text 逐字符（CRLF 保留；canonical 不冒充 original）
{
  const r = copyOriginalPayload({ kind: 'text', text: ORIG_CRLF }, CANON, true);
  check('orig-text-verbatim-CRLF', r.ok === true && eq(r.payload, ORIG_CRLF) && !eq(r.payload, CANON), JSON.stringify(r).slice(0, 120));
}
// Copy Original：html 信封 → 原始 HTML 源码逐字符
{
  const html = '<h3>标题</h3>\r\n<p>正文</p>';
  const r = copyOriginalPayload({ kind: 'html', text: html }, '', true);
  check('orig-html-source-verbatim', r.ok === true && eq(r.payload, html), JSON.stringify(r).slice(0, 120));
}
// Copy Original：bytes → 二进制语义拒绝（不写文本/不猜 charset）
{
  const r = copyOriginalPayload({ kind: 'bytes' }, 'x', true);
  check('orig-bytes-rejected', r.ok === false && /二进制/.test(r.reason), JSON.stringify(r));
}
// Copy Original：无信封 legacy → 保存的原 quote（空字符串是合法原文）
{
  const r = copyOriginalPayload(null, ORIG_CRLF, false);
  check('orig-legacy-quote', r.ok === true && eq(r.payload, ORIG_CRLF), JSON.stringify(r).slice(0, 120));
  const rEmpty = copyOriginalPayload(null, '', false);
  check('orig-legacy-empty-string-legal', rEmpty.ok === true && eq(rEmpty.payload, ''), JSON.stringify(rEmpty));
}
// Copy Original：信封行缺 original / 未知 kind → 显式拒绝（兼容 quote 不冒充原文）
{
  const r = copyOriginalPayload(null, 'compat-quote', true);
  check('orig-envelope-missing-original-rejected', r.ok === false && /信封原文缺失/.test(r.reason), JSON.stringify(r));
  const r2 = copyOriginalPayload({ kind: 'weird' }, '', true);
  check('orig-envelope-unknown-kind-rejected', r2.ok === false, JSON.stringify(r2));
}

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at_utc: new Date().toISOString(), total: results.length, fail, results }, null, 1));
console.log(`\ncopy-helpers: ${results.length - fail}/${results.length} PASS`);
process.exit(fail ? 1 : 0);
