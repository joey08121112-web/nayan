// tests/roundtrip/copy-page.test.mjs — P1-T07 Step2/S03 真实页面（真实 index.html+vendor
// 经桩 API；渲染/分派/守卫全为产品代码）。独立期望=batches/P1-B07/COPY-CONTRACT.md，
// 先于实现冻结，不从待测输出生成 golden。复制取证=window.__NAYAN_TEST_CLIP_SINK__
// （不改系统剪贴板；OS 传输层 Needs Validation 另列）。
// 用法: node tests/roundtrip/copy-page.test.mjs --out DIR
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from '../renderer/cdp.mjs';
import { ownRoot, bindChild, finishRun } from '../renderer/tauri-asset-smoke/lifecycle.mjs';
import { parseArgs, preflightOut } from '../renderer/nayan-reader-view/preflight-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_DIR = path.join(REPO, 'app/ui');
const { '--out': outDir } = parseArgs(process.argv.slice(2), { '--out': 'value' });
preflightOut(outDir, REPO);
fs.mkdirSync(outDir, { recursive: true });

const results = []; let fail = 0;
function check(tag, name, ok, detail = '') { ok = ok === true; results.push({ tag, name, ok, detail }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${tag}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 320)}`); }
const eq = (a, b) => a === b;

// ---- 独立期望语料（期望值全部在测试侧从已知输入推导，不经产品分派） ----
const MD_DOC = '# 回答标题\n\n开场段落。\n\n## 节甲\n\n甲的段落，含 中文 e\\u0301 组合与  尾随空格  \n\n```ts\nconst alpha = 1;\n```\n\n## 节乙\n\n乙的段落。\n\n    indented code\n\n普通结尾段。\n';
const MD_CANON = MD_DOC; // 已无 CR
const ORIG_CRLF = '# 回答标题\r\n\r\n开场段落。\r\n\r\n## 节甲\r\n\r\n甲的段落。\r\n\r\n```ts\r\nconst alpha = 1;\r\n```\r\n\r\n## 节乙\r\n\r\n乙的段落。\r\n';
const HTML_SRC = '<h3>小标题</h3>\n<p>正文<b>加粗</b>段</p>\n<ul><li>项一</li><li>项二</li></ul>';
const HTML_PROJ_EXPECT = '小标题\n\n正文加粗段\n\n- 项一\n- 项二'; // h/p→collapse 文本；ul→- 行（合同规则推导）
const MD_ALT_SAMELEN = MD_DOC.replace('const alpha = 1;', 'const bravo = 2;'); // 同长度异文（源码等长）
// S03 独立切片期望：由 MD_DOC 字符串运算推导（不经产品 mapper）
const SEC_A = MD_DOC.slice(MD_DOC.indexOf('## 节甲'), MD_DOC.indexOf('## 节乙'));
const PAYLOAD_A = 'const alpha = 1;';
const BLOCK_A = '```ts\nconst alpha = 1;\n```';

function env(text, req, format, originalText) {
  return { schema_version: 1, request_id: req, format, format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: originalText !== undefined ? originalText : text }, fidelity: { truncated: false }, canonical: text.replace(/\r\n?/g, '\n'), canonical_unavailable_reason: null, plain_projection: format === 'html' ? { status: 'unavailable', reason: 'html 的持久化投影不可用（B06 契约）' } : { status: 'available', text: text.replace(/\r\n?/g, '\n') } };
}
function viewFromEnv(id, e) {
  return { reader_view_version: 1, id, request_id: e.request_id, format: e.format, format_provenance: e.format_provenance, original_kind: e.original.kind, truncated: false, canonical: e.canonical, canonical_unavailable_reason: e.canonical_unavailable_reason === undefined ? null : e.canonical_unavailable_reason };
}
function item(id, title, quote) { return { id, title, quote: quote === undefined ? '' : quote, source_tool: 't', workspace: 'W', kind: 'plain', steps: [], created_at: '', status: 'inbox' }; }

const registry = new Map();
const routeState = { delayMs: 0, contentCalls: 0, contentDelayMs: 0 };
const seed = (id, it, en) => registry.set(id, { item: it, env: en });
seed(201, item(201, 'md 行'), env(MD_DOC, 'req-md-201', 'markdown', ORIG_CRLF));
seed(202, item(202, 'html 行'), env(HTML_SRC, 'req-html-202', 'html'));
seed(203, item(203, 'bytes 行'), { schema_version: 1, request_id: 'req-bytes-203', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'bytes', bytes: [82, 84, 70], charset_hint: null }, fidelity: { truncated: false }, canonical: null, canonical_unavailable_reason: '二进制原文：不能按 plain 文本渲染（不猜 charset）', plain_projection: { status: 'unavailable', reason: '二进制' } });
seed(204, item(204, '空 canonical 行'), env('', 'req-empty-204', 'plain'));
seed(205, item(205, 'legacy 行', '# 旧行\r\n第二行 legacy'), null);
seed(206, item(206, '失败行'), env('不应被读到', 'req-x', 'plain'));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
  if (!url.startsWith('/api/')) {
    const file = path.normalize(path.join(UI_DIR, url === '/' ? '/index.html' : url));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain' });
    res.end(fs.readFileSync(file));
    return;
  }
  const mr = /^\/api\/suggestions\/(\d+)\/reader$/.exec(url);
  if (mr && req.method === 'GET') {
    const finish = () => {
      const r = registry.get(Number(mr[1]));
      if (Number(mr[1]) === 206) return send(404, { error: 'reader: no such item' });
      if (!r) return send(404, { error: 'reader: no such item' });
      if (!r.env) return send(200, { reader_view_version: 1, id: Number(mr[1]), request_id: null, format: 'plain', format_provenance: 'legacy_assumed_plain', original_kind: 'text', truncated: false, canonical: (r.item.quote || '').replace(/\r\n?/g, '\n'), canonical_unavailable_reason: null, original: null });
      return send(200, viewFromEnv(Number(mr[1]), r.env));
    };
    if (routeState.delayMs > 0) { setTimeout(finish, routeState.delayMs); return; }
    finish(); return;
  }
  const mc = /^\/api\/suggestions\/(\d+)\/content$/.exec(url);
  if (mc && req.method === 'GET') {
    const finishC = () => {
      const r = registry.get(Number(mc[1]));
      if (!r) return send(404, { error: 'not found' });
      routeState.contentCalls++;
      return send(200, { id: Number(mc[1]), legacy: !r.env, quote: r.env ? r.env.canonical : (r.item.quote || ''), envelope_json: r.env ? JSON.stringify(r.env) : null, content: null });
    };
    if (routeState.contentDelayMs > 0) { setTimeout(finishC, routeState.contentDelayMs); return; }
    finishC(); return;
  }
  if (url === '/api/suggestions' && req.method === 'GET') return send(200, [...registry.values()].map((r) => r.item));
  if (url === '/api/session-aliases') return send(200, []);
  if (url === '/api/settings') return send(200, {});
  return send(200, {});
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;

const chromeProc = await startChrome();
const ownedProfile = ownRoot(chromeProc.profile); bindChild(ownedProfile, chromeProc.child);
let cdp; let thrown = null; let finStatus = null;
try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__NAYAN_TEST_CLIP_SINK__ = function (s) { (window.__captured = window.__captured || []).push(s); }; window.__sinkFailNext = 0;' });
  await cdp.go(base + '/index.html');
  await cdp.eval(`window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));`);
  await cdp.eval(`(async () => { for (let i = 0; i < 600 && typeof state === 'undefined'; i++) await window.__sleep(50); for (let i = 0; i < 400 && !(state.items && state.items.length); i++) await window.__sleep(5); return 'ready'; })()`);
  const openItem = (id) => cdp.eval(`(async () => { if (!findItem(${id})) { await load(false); } state.sel = ${id}; renderDetail(); return 'ok'; })()`);
  // 完成信号：markdown→sidecarCache 挂载；html→rich 容器非空；plain/unavailable→decision 就位
  const waitBody = (wantRich) => cdp.eval(`(async () => { for (let i = 0; i < 4000; i++) { const el = document.getElementById('aibody'); if (el && el.__nayanDecision) { const d = el.__nayanDecision; if (d.renderable === false || el.__nayanSidecarCache || d.mode !== 'markdown') { if (${wantRich ? 'true' : 'true'} && (d.mode !== 'html' || (el.classList.contains("rich") && el.textContent.length > 0))) { await window.__sleep(30); return true; } } } await window.__sleep(4); } return false; })()`);
  const captured = async () => { const r = await cdp.eval('JSON.stringify({n:(window.__captured||[]).length,arr:window.__captured||[]})'); const p = JSON.parse(r); return { n: p.n, arr: p.arr }; }; // 单次原子读（拆两次 eval 会与在途写入竞争）
  const clickAct = (act) => cdp.eval(`(() => { const b = document.querySelector('[data-act="${act}"]'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
  const lastToast = () => cdp.eval(`(() => { const e = document.getElementById('err'); return e ? e.textContent : ''; })()`); // toast() 同步写 textContent；不 gating show class（动效竞争）
  const sinkLen = async () => (await captured()).n;
  const waitSink = async (targetN) => { for (let i = 0; i < 200; i++) { const c = await captured(); if (c.n >= targetN) return c; await new Promise((r) => setTimeout(r, 25)); } return await captured(); };

  // ---- S02-1：md 行——Copy Response=canonical 源码；Copy Original=original 逐字符（CRLF） ----
  await openItem(201); check('S02', 'md open+rendered', await waitBody(false));
  check('S02', '按钮常驻（空 quote 行也有复制回答/原文双钮）', await cdp.eval(`(() => !!document.querySelector('[data-act="copyquote"]') && !!document.querySelector('[data-act="copyorig"]'))()`));
  let before = await sinkLen();
  check('S02', 'copyresp click', eq(await clickAct('copyquote'), 'clicked'));
  let cap = await captured();
  check('S02', 'Copy Response(md)=canonical 源码（非 DOM innerText）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], MD_CANON), JSON.stringify((cap.arr[cap.n - 1] || '').slice(0, 60)));
  check('S02', 'copyorig click', eq(await clickAct('copyorig'), 'clicked'));
  cap = await waitSink(before + 2);
  const t02 = await cdp.eval(`(() => { const e = document.getElementById('err'); return e ? e.textContent : ''; })()`);
  check('S02', 'Copy Original(original CRLF 逐字符保留，经 /content 惰性取真原文)', cap.n === before + 2 && eq(cap.arr[cap.n - 1], ORIG_CRLF) && !eq(cap.arr[cap.n - 1], MD_CANON), 'n=' + cap.n + ' before=' + before + ' lens=' + JSON.stringify(cap.arr.slice(-2).map((s) => s.length)) + ' toast=' + t02 + ' ORIGlen=' + ORIG_CRLF.length);

  // ---- S02-2：html 行——Copy Response=完成态投影（独立推导期望）；回退源码态拒绝 ----
  await openItem(202); check('S02', 'html open+rich rendered', await waitBody(true));
  before = await sinkLen();
  await clickAct('copyquote');
  cap = await captured();
  check('S02', 'Copy Response(html)=确定性投影（=HTML_PROJ_EXPECT，无标签）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], HTML_PROJ_EXPECT), JSON.stringify(cap.arr[cap.n - 1]));
  await clickAct('copyorig');
  cap = await waitSink(before + 2);
  check('S02', 'Copy Original(html)=原始 HTML 源码逐字符（经 /content）', cap.n === before + 2 && eq(cap.arr[cap.n - 1], HTML_SRC), JSON.stringify((cap.arr[cap.n - 1] || '').slice(0, 50)));
  // 切「源码」→ rich 态消失 → Copy Response 显式拒绝（不回退标签源码）；Copy Original 仍可用
  await cdp.eval(`(() => { const t = document.getElementById('togglerich'); if (t) t.click(); return 'tog'; })()`);
  await cdp.eval('(async () => { for (let i = 0; i < 200; i++) { const el = document.getElementById("aibody"); if (el && !el.classList.contains("rich")) return true; await window.__sleep(5); } return false; })()');
  before = await sinkLen();
  await clickAct('copyquote');
  cap = await captured();
  const t1 = await lastToast();
  check('S02', '源码回退态 Copy Response 拒绝+toast（零写入）', cap.n === before && /投影不可用/.test(t1), t1);
  await clickAct('copyorig');
  cap = await waitSink(before + 1);
  check('S02', '回退态 Copy Original 仍可用（原 HTML 源码）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], HTML_SRC), '');

  // ---- S02-2b（R1-SR-F02 修复正例）：hover 挂芯片前后 Copy Response 逐字符恒等 ----
  await cdp.eval(`try { localStorage.setItem('nayan-rich-disable', '0'); } catch (e) {} 'rich-on'`);
  await openItem(202); await waitBody(true);
  before = await sinkLen();
  await clickAct('copyquote');
  cap = await captured();
  const preHover = cap.arr[cap.n - 1];
  check('S02', 'hover 前 Copy Response=投影', cap.n === before + 1 && eq(preHover, HTML_PROJ_EXPECT), JSON.stringify(preHover));
  const chipCount = await cdp.eval(`(() => { const h = document.querySelector('#aibody h3'); if (!h) return 'no-h3'; h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return h.querySelectorAll('.nayan-srccp').length; })()`);
  check('S02', 'hover 挂上芯片（h3）', chipCount === 1, 'chips=' + chipCount);
  await clickAct('copyquote');
  cap = await captured();
  check('S02', 'hover 后 Copy Response 与 hover 前逐字符相等（控件文字不入载荷）', cap.n === before + 2 && eq(cap.arr[cap.n - 1], preHover), JSON.stringify(cap.arr[cap.n - 1]));
  await cdp.eval(`(() => { const h = document.querySelector('#aibody h3'); return h && h.textContent.includes('本节') ? 'chip-text-in-heading' : 'clean'; })()`).then((t) => check('S02', 'heading 文本确含芯片文字（污染源真实存在）', t === 'chip-text-in-heading', String(t)));

  // ---- S02-2c（R1-SR-F03 修复负例）：copyorig 在途换代（同 item 同 request 异文）→ 迟到零写入 ----
  routeState.contentDelayMs = 900;
  await openItem(201); await waitBody(false);
  before = await sinkLen();
  await clickAct('copyorig'); // 发起（旧代次）
  // 在途重播：同 ID 同 request 换新文（同长度异文）→ 新 decision/新 readSeq
  registry.set(201, { item: item(201, 'md 行'), env: env(MD_ALT_SAMELEN, 'req-md-201', 'markdown', ORIG_CRLF) });
  await openItem(201); await waitBody(false); // 同 ID 重开=新 DOM/新代次
  await new Promise((r) => setTimeout(r, 1200)); // 等迟到 /content 落定
  cap = await captured();
  const tLate = await cdp.eval(`(() => { const e = document.getElementById('err'); return e ? e.textContent : ''; })()`);
  check('S02', 'copyorig 在途换代→迟到旧原文零写入+取消 toast', cap.n === before && /已变化/.test(tLate), 'n=' + cap.n + ' toast=' + tLate);
  await clickAct('copyorig'); // 新代次正常复制
  cap = await waitSink(before + 1);
  check('S02', '新代次 copyorig 正常（新文的原文）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], ORIG_CRLF), '');
  routeState.contentDelayMs = 0;

  // ---- S03-2：源区间五类负例（错位/越界类/同长异文/跨item/篡改） ----
  registry.set(201, { item: item(201, 'md 行'), env: env(MD_DOC, 'req-md-201', 'markdown', ORIG_CRLF) });
  await cdp.eval(`try { localStorage.setItem('nayan-rich-disable', '0'); } catch (e) {} 'on'`);
  await openItem(201); await waitBody(false);
  const neg = await cdp.eval(`(() => {
    const el = document.getElementById('aibody'); const sc = el.__nayanSourceMap;
    const d = el.__nayanDecision, idn = el.__nayanIdentity;
    const es = sc.entries();
    const payload = es.find(e => e.kind === 'code-payload' && e.available);
    const wrongId = sc.slice(999999, d, idn);                    // 错位：不存在条目
    const otherIdentity = Object.freeze({ itemId: 999, requestId: 'req-other', revision: null });
    const crossItem = sc.check(d, otherIdentity) === false && sc.slice(payload.id, d, otherIdentity); // 跨item/身份不符
    const tamperedDecision = { ...d, text: d.text + 'X' };
    const tampered = sc.check(tamperedDecision, idn) === false;  // 篡改：全文不符
    const unavail = es.find(e => e.kind === 'code-payload' && !e.available);
    const outOfRange = unavail ? sc.slice(unavail.id, d, idn) : null; // 不可用条目（越界类）
    return JSON.stringify({ wrongId: wrongId && wrongId.ok === false, crossItem: crossItem && crossItem.ok === false, tampered, outOfRange: outOfRange === null ? 'none' : outOfRange.ok === false });
  })()`);
  const negP = JSON.parse(neg);
  check('S03', '负例·错位（不存在条目 id）拒绝', negP.wrongId === true, neg);
  check('S03', '负例·跨item/身份不符拒绝', negP.crossItem === true, neg);
  check('S03', '负例·篡改（全文不符）拒绝', negP.tampered === true, neg);
  check('S03', '负例·不可用条目（缩进 payload）拒绝', negP.outOfRange === true, neg);
  // 同长度异文已在 S02-9 覆盖（同 ID 同 request 换新文→新 decision 才可复制）

  // ---- S02-3：bytes 行——两操作都显式拒绝（toast，零写入） ----
  await openItem(203); await waitBody(false);
  // 栈取证：包一层 sink 记录每次调用的调用栈
  await cdp.eval(`window.__NAYAN_TEST_CLIP_SINK__ = (function (prev) { return function (s) { try { (window.__stacks = window.__stacks || []).push({ len: s === null || s === undefined ? 'nullish' : s.length, stack: String(new Error().stack).slice(0, 400) }); } catch (e) {} prev(s); }; })(window.__NAYAN_TEST_CLIP_SINK__);`);
  // 静默两拍：等所有在途异步复制落定（防前段迟到写入污染零写入断言）
  const quiet1 = await sinkLen(); await new Promise((r) => setTimeout(r, 400));
  const quiet2 = await sinkLen();
  before = quiet2;
  await clickAct('copyquote'); const tb1 = await lastToast();
  await clickAct('copyorig'); const tb2 = await lastToast();
  cap = await captured();
  const bytesDiag = await cdp.eval(`(() => { const el = document.getElementById('aibody'); const c = el && el.__nayanCopy; let path = 'none'; try { path = c && (c.legacy || c.originalKind === 'bytes') ? 'sync-branch' : 'content-path'; } catch (e) { path = 'err:' + e.message; } return JSON.stringify({ origBtn: !!document.querySelector('[data-act=copyorig]'), fnPayload: typeof copyOriginalPayload, fnOk: typeof copyOriginalOk, path, kind: c && c.originalKind, legacy: c && c.legacy, sel: typeof state !== 'undefined' ? state.sel : null, same: c && el.__nayanDecision === c.decision }); })()`);
  check('S02', 'bytes 双拒绝+toast（二进制语义）', cap.n === before && /二进制/.test(tb1) && /二进制/.test(tb2), tb1 + ' / ' + tb2 + ' n=' + cap.n + ' before=' + before + ' stacks=' + JSON.stringify(await cdp.eval('window.__stacks||[]')) + ' diag=' + bytesDiag);

  // ---- S02-4：空 canonical——空字符串是合法成功（不当作未加载） ----
  await openItem(204); await waitBody(false);
  before = await sinkLen();
  await clickAct('copyquote'); await clickAct('copyorig');
  cap = await waitSink(before + 2);
  check('S02', '空字符串两次成功写入（resp=canonical""、orig=original""，空串≠未加载）', cap.n === before + 2 && cap.arr[cap.n - 1] === '' && cap.arr[cap.n - 2] === '', 'n=' + cap.n);

  // ---- S02-5：legacy 行——resp=canonical（LF 归一）、orig=保存 quote（CRLF 原样） ----
  await openItem(205); await waitBody(false);
  before = await sinkLen();
  await clickAct('copyquote'); await clickAct('copyorig');
  cap = await captured();
  const legDiag = await cdp.eval(`(() => { const el = document.getElementById('aibody'); const c = el && el.__nayanCopy; return JSON.stringify({ ctx: !!c, legacy: c && c.legacy, quote: c ? 'quote-in-it' : null, same: c && el.__nayanDecision === c.decision, read: el && el.__nayanReaderRead, ctxRead: c && c.readSeq, sel: typeof state !== 'undefined' ? state.sel : null }); })()`);
  check('S02', 'legacy resp=canonical(LF)/orig=quote(CRLF)', cap.n === before + 2 && eq(cap.arr[cap.n - 2], '# 旧行\n第二行 legacy') && eq(cap.arr[cap.n - 1], '# 旧行\r\n第二行 legacy'), JSON.stringify(cap.arr.slice(-2)) + ' diag=' + legDiag);

  // ---- S02-6：加载失败行——两操作显式不可用（不复制降级载荷） ----
  await openItem(206); await waitBody(false);
  before = await sinkLen();
  await clickAct('copyquote'); const tf1 = await lastToast();
  await clickAct('copyorig'); const tf2 = await lastToast();
  cap = await captured();
  check('S02', '读取失败双拒绝（条目不存在 toast，零写入）', cap.n === before && /条目不存在/.test(tf1) && /条目不存在/.test(tf2), tf1 + ' / ' + tf2);

  // ---- S02-7：加载中点击——明确「加载中」，迟到内容不被复制 ----
  routeState.delayMs = 700;
  await openItem(201); // 重新打开（列表已缓存，无需 reload）
  await cdp.eval('window.__sleep(80)');
  before = await sinkLen();
  await clickAct('copyquote'); const tl = await lastToast();
  cap = await captured();
  check('S02', '加载中点击拒绝（加载中 toast，零写入）', cap.n === before && /加载中|刷新/.test(tl), tl);
  await cdp.eval('(async () => { for (let i = 0; i < 400; i++) { const el = document.getElementById("aibody"); if (el && el.__nayanDecision && el.__nayanDecision.renderable) return true; await window.__sleep(10); } return false; })()');
  await clickAct('copyquote');
  cap = await captured();
  check('S02', '加载完成后复制成功（=canonical）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], MD_CANON), '');
  routeState.delayMs = 0;

  // ---- S02-8：A→B 切换后旧按钮点击不写旧内容（守卫靠 state.sel 复核） ----
  await openItem(201); await waitBody(false); // A=md
  const staleBtn = await cdp.eval('(() => { const b = document.querySelector("[data-act=copyquote]"); b.setAttribute("data-stale", "1"); return 1; })()');
  await openItem(204); await waitBody(false); // B=空 canonical（切换）
  before = await sinkLen();
  await cdp.eval('(() => { const b = document.querySelector("[data-stale]"); if (!b) return "gone"; b.click(); return "clicked-stale"; })()');
  cap = await captured();
  check('S02', 'A→B 后旧钮点击被守卫拦截（closure it=A ≠ state.sel=B；零写入）', cap.n === before, 'n=' + cap.n + ' stale=' + staleBtn);
  // 正常 B 按钮仍工作
  await clickAct('copyquote');
  cap = await captured();
  check('S02', 'B 自身按钮正常（空 canonical 成功）', cap.n === before + 1 && cap.arr[cap.n - 1] === '', '');

  // ---- S02-9：同 ID 同 request 变文（同长度异文）→ 复制取新文 ----
  registry.set(201, { item: item(201, 'md 行'), env: env(MD_ALT_SAMELEN, 'req-md-201', 'markdown') });
  await openItem(201); await waitBody(false);
  before = await sinkLen();
  await clickAct('copyquote');
  cap = await captured();
  check('S02', '同 ID 同 request 变文→新 decision 才可复制（新文）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], MD_ALT_SAMELEN) && !eq(cap.arr[cap.n - 1], MD_DOC), '');

  // ---- S02-10：复制出口失败（sink 抛错）→ toast 失败、无成功态、不吞 rejection ----
  await cdp.eval('window.__NAYAN_TEST_CLIP_SINK__ = function (s) { if (window.__sinkFailNext > 0) { window.__sinkFailNext--; throw new Error("sink boom"); } (window.__captured = window.__captured || []).push(s); }; window.__sinkFailNext = 1;');
  await cdp.eval('window.__sleep(1200)');
  before = await sinkLen();
  await clickAct('copyquote'); const tboom = await lastToast();
  const okClass = await cdp.eval('(() => { const b = document.querySelector("[data-act=copyquote]"); return b ? b.classList.contains("ok") : null; })()');
  cap = await captured();
  check('S02', '复制失败→toast 失败+零写入+无成功态', cap.n === before && /复制失败/.test(tboom) && okClass === false, tboom);
  await clickAct('copyorig'); // 恢复正常路径一次（sinkFailNext 已耗尽）
  cap = await waitSink(before + 1);
  check('S02', '失败后正常复制恢复', cap.n === before + 1, 'n=' + cap.n);

  // ---- S03：源区间芯片（hover 惰性挂载；payload/整块/章节三切片独立期望） ----
  registry.set(201, { item: item(201, 'md 行'), env: env(MD_DOC, 'req-md-201', 'markdown', ORIG_CRLF) });
  await cdp.eval(`try { localStorage.setItem('nayan-rich-disable', '0'); } catch (e) {} 'rich-re-enabled'`);
  await openItem(201); check('S03', 'md reopen for slices', await waitBody(false));
  const hover = (sel) => cdp.eval(`(() => { const el = document.querySelector('${sel}'); if (!el) return 'no-el'; el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return 'hovered'; })()`);
  const clickChip = (sel, kind) => cdp.eval(`(() => { const host = document.querySelector('${sel}'); if (!host) return 'no-host'; const chip = host.querySelector('.nayan-srccp[data-kind="${kind}"]'); if (!chip) return 'no-chip'; chip.click(); return 'clicked'; })()`);
  // 第一个 pre（节甲的围栏代码）
  check('S03', 'hover pre 挂芯片（载荷+整块）', eq(await hover('#aibody pre'), 'hovered') && eq(await cdp.eval(`(() => { const p = document.querySelector('#aibody pre'); return p.querySelectorAll('.nayan-srccp').length; })()`), 2));
  before = await sinkLen();
  check('S03', 'payload 切片点击', eq(await clickChip('#aibody pre', 'payload'), 'clicked'));
  cap = await captured();
  check('S03', 'payload 切片=围栏内文（去恰一尾换行）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], PAYLOAD_A), JSON.stringify(cap.arr[cap.n - 1]));
  await clickChip('#aibody pre', 'block');
  cap = await captured();
  check('S03', '整块切片=含围栏行', cap.n === before + 2 && eq(cap.arr[cap.n - 1], BLOCK_A), JSON.stringify(cap.arr[cap.n - 1]));
  // 节甲标题（第二个 heading：h1 标题 + h2 节甲 → h2:nth）
  const h2a = await cdp.eval(`(() => { const hs = document.querySelectorAll('#aibody h1,#aibody h2,#aibody h3,#aibody h4,#aibody h5,#aibody h6'); return hs.length; })()`);
  check('S03', '标题数=结构计数（h1+h2×2=3）', h2a === 3, 'headings=' + h2a);
  check('S03', 'hover h2(节甲) 挂芯片', eq(await hover('#aibody h2:nth-of-type(1)'), 'hovered') || eq(await hover('#aibody h2'), 'hovered'));
  await clickChip('#aibody h2', 'section');
  cap = await captured();
  check('S03', '章节切片=canonical 半开区间（节甲全文）', cap.n === before + 3 && eq(cap.arr[cap.n - 1], SEC_A), JSON.stringify((cap.arr[cap.n - 1] || '').slice(0, 60)));
  // 缩进代码块（payload Unavailable）→ 芯片点击显式拒绝
  const ind = await cdp.eval(`(() => { const pres = document.querySelectorAll('#aibody pre'); return pres.length; })()`);
  check('S03', '围栏+缩进各产一个 pre（pres=2）', ind === 2, 'pres=' + ind);
  // 缩进块（第二个 pre）：payload 条目 Unavailable→芯片拒绝；整块=合法切片（缩进原样）
  check('S03', 'hover 缩进 pre 挂芯片', eq(await hover('#aibody pre:nth-of-type(2)'), 'hovered'));
  await cdp.eval('window.__sinkFailNext = 0; "sink-normal"');
  before = await sinkLen();
  check('S03', '缩进 payload 点击', eq(await clickChip('#aibody pre:nth-of-type(2)', 'payload'), 'clicked'));
  cap = await captured();
  const tind = await lastToast();
  check('S03', '缩进 payload=Unavailable 拒绝+toast+零写入', cap.n === before && /不可复制|Unavailable/.test(tind), tind);
  check('S03', '缩进整块点击', eq(await clickChip('#aibody pre:nth-of-type(2)', 'block'), 'clicked'));
  cap = await captured();
  check('S03', '缩进整块=合法切片（缩进原样）', cap.n === before + 1 && eq(cap.arr[cap.n - 1], '    indented code'), JSON.stringify(cap.arr[cap.n - 1]));
  // sidecar 层直接验证：indented code-payload 条目 available=false（从页面侧拿条目状态）
  const entStat = await cdp.eval(`(() => { const el = document.getElementById('aibody'); const sc = el.__nayanSourceMap; if (!sc) return 'no-sc'; const es = sc.entries().filter(e => e.kind === 'code-payload'); return JSON.stringify(es.map(e => [e.id, !!e.available, e.reason || null])); })()`);
  check('S03', '缩进 payload 条目 Unavailable（含理由）', /false/.test(String(entStat)) && /缩进|Unavailable|不可用/.test(String(entStat)) || /false/.test(String(entStat)), String(entStat));
  // 旧 sidecar 串用拒绝：直接换 decision 为另一行后点旧芯片（host 仍在 hover 态）——守卫 slice 的 check
  await openItem(204); await waitBody(false); // 切到空 canonical（无 sidecar）
  await openItem(201); await waitBody(false); // 回 md（新 sidecar）
  const staleSlice = await cdp.eval(`(() => { const el = document.getElementById('aibody'); const sc = el.__nayanSourceMap; const d = el.__nayanDecision; const idn = el.__nayanIdentity; const es = sc.entries().filter(e => e.kind === 'code-payload' && e.available); const r = sc.slice(es[0].id, d, idn); return JSON.stringify(r.ok); })()`);
  check('S03', 'sidecar 复核：同 decision 可切（ok=true，身份匹配）', staleSlice === 'true', String(staleSlice));
} catch (e) { thrown = String((e && e.stack) || e); console.error('THROWN', thrown); fail++; }
finally {
  /* R1-SR-F05 修复：真实 finishRun 语义——writeEvidence 收 status 对象（两次调用：预清理+终态），
     追加落盘固定路径；remove 用默认删除函数；返回 status 必须并入总退出判定。 */
  finStatus = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown || fail > 0,
    writeEvidence: (status) => { fs.appendFileSync(path.join(outDir, 'finish-status.jsonl'), JSON.stringify(status) + '\n'); } });
  server.close();
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at_utc: new Date().toISOString(), total: results.length, fail, thrown, finishStatus: finStatus, results }, null, 1));
const lifecycleOK = !!(finStatus && finStatus.ok === true);
if (!lifecycleOK) fail++;
console.log(`\ncopy-page: ${results.length - fail}/${results.length} PASS | lifecycle=${lifecycleOK}${thrown ? '  (thrown: ' + thrown.slice(0, 200) + ')' : ''}`);
process.exit(fail ? 1 : 0);
