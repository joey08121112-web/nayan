// tests/renderer/reader-async.test.mjs —— P1-B06-PERF-01 / Step 4：异步渲染竞态、安全与必败控制
// 真实 index.html（浏览器上下文，TAPI=null；api() 的 fetch 回退由本测试 HTTP 服务拦截），
// 真实生产链：state.sel → renderDetail → bindEntry → GET :id/content → readerBody →
// revealQuote → fillReaderBody → renderReaderBodyAsync → 完成回调挂 sidecar。
// 时序控制 = 显式闸门（截获 delay-0 setTimeout 持有/按条件轮询/放行），全部收敛在
// 单次页面求值内，不以固定 sleep 冒充时序证明。
// 必败控制 = 同一套完整性断言对「测试侧人为错写」必须报警（证明断言有牙），
// 正常取消对照不误伤。渲染与调度全部为真产品代码；桩仅限数据/API（内容信封、库故障注入）。
// 用法：node tests/renderer/reader-async.test.mjs --out DIR
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from './cdp.mjs';
import { ownRoot, bindChild, finishRun } from './tauri-asset-smoke/lifecycle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_DIR = path.join(REPO, 'app/ui');
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-reader-async-'));
fs.mkdirSync(outDir, { recursive: true });

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 400)}`);
}

/* ---------- 内容工厂 ---------- */
function mdDoc(title, n) {
  const parts = ['# ' + title + '\n\n开头段（' + title + '）。\n'];
  for (let i = 1; i <= n; i++) {
    parts.push('## 节 ' + title + '-' + i + '\n\n段落 中文 English e\u0301，' + i + ' 号。\n\n```ts\nconst v' + i + ' = ' + i + ';\n  indent\n```\n\n> 引用 ' + i + '\n\n- 列表 ' + i + '\n- 另一项 ' + i + '\n\n');
  }
  return parts.join('');
}
const DOC_A = mdDoc('DOC-A', 1700);          // ~850KiB 源 → html ~320KiB：256KiB 阈值回挂后仍剩 ≥2 批（可持住）
const DOC_B = mdDoc('DOC-B', 1700);
const DOC_SMALL = '# 小文\n\n一段短文，一批完成，不产生任何 yield。\n\n```js\nx=1\n```\n';
const pad = (s, n) => s + 'x'.repeat(Math.max(0, n - s.length));
const DOC_B_SAMELEN = pad(DOC_B, DOC_A.length).slice(0, DOC_A.length);
const HOSTILE_HEAD = [
  '<script>window.__pwned=1</script>',
  '<img src="http://127.0.0.1:1/leak.png" onerror="window.__pwned=1">',
  '<a href="javascript:window.__pwned=1">bad</a>',
  '<a href="data:text/html,<script>window.__pwned=1</script>">data</a>',
  '<iframe src="http://127.0.0.1:1/frame"></iframe>',
  '<div onclick="window.__pwned=1" style="background:url(http://127.0.0.1:1/x)">styled</div>',
].join('\n\n');
const HOSTILE_TAIL = '<script>alert(1)</script>\n\n<video src="http://127.0.0.1:1/v.mp4"></video>\n\n[x](javascript:window.__pwned=1)';
const DOC_HOSTILE = HOSTILE_HEAD + '\n\n' + mdDoc('HOSTILE', 1700) + '\n' + HOSTILE_TAIL + '\n';
const DOC_HTML_HOSTILE = '<p>ok <strong>bold</strong></p><script>window.__pwned=1</script><div onclick="window.__pwned=1">d</div><a href="javascript:window.__pwned=1">l</a>';
const DOC_STRUCT = [
  '# 结构', '',
  '1. 第一', '2. 第二', '   - 嵌套 a', '   - 嵌套 b', '      1. 深层', '',
  '> 引用行', '> 引用二行', '',
  '| A | B |', '|---|---|', '| 1 | 2 |', '',
  '```', '', '```', '',
  '```py', 'x = "a很很很e\u0301"', '超长行 ' + 'z'.repeat(300), '```', '',
  '5. 五号起始', '6. 六号', '',
].join('\n');

function env(text, req, format = 'markdown') {
  return { schema_version: 1, request_id: req, format, format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text }, fidelity: { truncated: false }, canonical: text, canonical_unavailable_reason: null, plain_projection: { status: 'available', text: '' } };
}
const mkItem = (id, title, quote) => ({ id, title, quote: quote || '', user_msg: '', my_note: '', status: 'inbox', created_at: '2026-10-01T00:00:00Z', source_tool: 'chat', session_ref: 's1', window_id: 1, steps: [] });

/* ---------- Node 侧条目注册表（页面只经真实 GET 取数） ---------- */
const registry = new Map();
function seed(items) { registry.clear(); for (const it of items) registry.set(it.id, { item: it, content: { content: null, quote: null } }); }
function setContent(id, content, quote) { registry.get(id).content = { content, quote }; }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!url.startsWith('/api/')) {
    const file = path.normalize(path.join(UI_DIR, url === '/' ? '/index.html' : url));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const mime = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': mime }); res.end(fs.readFileSync(file));
    return;
  }
  const m = /^\/api\/suggestions\/(\d+)\/content$/.exec(url);
  if (m && req.method === 'GET') {
    const r = registry.get(Number(m[1]));
    if (!r) return send(404, { error: 'not found' });
    return send(200, { content: r.content.content, quote: r.content.quote });
  }
  // P1-B06-NATIVE-PAYLOAD-01: reader view route (same envelope source, minimal DTO shape).
  const mr = /^\/api\/suggestions\/(\d+)\/reader$/.exec(url);
  if (mr && req.method === 'GET') {
    const r = registry.get(Number(mr[1]));
    if (!r) return send(404, { error: 'not found' });
    const envObj = r.content.content;
    if (!envObj) return send(200, { reader_view_version: 1, id: Number(mr[1]), request_id: null, format: 'plain', format_provenance: 'legacy_assumed_plain', original_kind: 'text', truncated: false, canonical: r.content.quote || '', canonical_unavailable_reason: null });
    return send(200, { reader_view_version: 1, id: Number(mr[1]), request_id: envObj.request_id, format: envObj.format, format_provenance: envObj.format_provenance, original_kind: (envObj.original && envObj.original.kind) || 'text', truncated: !!(envObj.fidelity && envObj.fidelity.truncated), canonical: envObj.canonical, canonical_unavailable_reason: envObj.canonical_unavailable_reason });
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
let cdp; let thrown = null;
const t0 = new Date().toISOString();
let netLog = [];

try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  cdp.on('Network.requestWillBeSent', (p) => { netLog.push(p.request.url); });
  await cdp.send('Network.enable');

  /* 页面侧装置：观察 wrapper（捕获渲染 promise 结果）+ 显式时序闸门 */
  const INSTALL = `(() => {
    window.__capCount = 0; window.__capResults = [];
    const origRRA = window.renderReaderBodyAsync;
    window.renderReaderBodyAsync = function (el, d, o) {
      window.__capCount++;
      const rec = { index: window.__capCount, status: null, done: false, tCreated: performance.now() };
      window.__capResults.push(rec);
      const p = origRRA.call(window, el, d, o);
      rec.p = p;   // 供并发/取消用例直接 await 指定 capture（输出实际结算状态，不以超时冒充）
      p.then((r) => { rec.status = r.status; rec.rendered = !!r.rendered; rec.reason = r.reason || null; rec.done = true; },
             (e) => { rec.status = 'error'; rec.error = String(e); rec.done = true; });
      return p;
    };
    /* 分支切换：st=产品落到 setTimeout（闸门可持有）；mc=MC 真实传输；sched=scheduler.yield 真实（计数包装） */
    window.__branch = (() => {
      const origMC = window.MessageChannel;
      const origSched = (typeof scheduler === 'object' && scheduler) ? scheduler : null;
      const def = (name, val) => { try { Object.defineProperty(window, name, { value: val, configurable: true, writable: true }); } catch (e) {} };
      if (origSched && typeof origSched.yield === 'function') {
        const oy = origSched.yield.bind(origSched);
        origSched.yield = function () { window.__schedYieldCount = (window.__schedYieldCount || 0) + 1; return oy(); };
      }
      const api = {
        origMC, origSched,
        set(b) {
          if (b === 'st') { def('scheduler', undefined); def('MessageChannel', undefined); }
          else if (b === 'mc') { def('scheduler', undefined); def('MessageChannel', origMC); }
          else if (b === 'sched') { if (origSched) def('scheduler', origSched); def('MessageChannel', origMC); }
          else throw new Error('unknown branch ' + b);
          window.__branchNow = b;
        },
      };
      api.set('st');
      return api;
    })();
    window.__gate = (() => {
      const held = []; let armed = false; const counts = { yield: 0, pass: 0 };
      /* 默认分支 'st' 已由 __branch.set('st') 完成中性化 */
      const origST = window.setTimeout.bind(window);
      window.__origSetTimeout = origST;
      window.setTimeout = function (fn, delay) {
        if (armed && delay === 0 && typeof fn === 'function') { held.push(fn); counts.yield++; return held.length; }
        counts.pass++; return origST(fn, delay);
      };
      window.__sleep = (ms) => new Promise((r) => origST(r, ms));
      return { arm() { armed = true; }, disarm() { armed = false; }, armed: () => armed,
        release(n) { const k = (n == null) ? held.length : n; const fns = held.splice(0, k); fns.forEach((f) => { try { f(); } catch (e) {} }); return fns.length; },
        heldCount: () => held.length, counts: () => ({ ...counts }) };
    })();
    return { installed: true, rra: typeof origRRA, cancel: typeof cancelReaderBodyRender };
  })()`;

  /* 完整性断言器（正常路径与必败控制共用同一断言） */
  const INTEGRITY = `(() => {
    window.__viol = (expect) => {
      const el = document.getElementById('aibody');
      if (!el) return ['no-aibody'];
      const out = []; const text = el.textContent || '';
      if (expect.marker && text.indexOf(expect.marker) < 0) out.push('missing-marker:' + expect.marker);
      if (expect.absent && text.indexOf(expect.absent) >= 0) out.push('stale-content:' + expect.absent);
      const sc = (typeof readerSidecarOf === 'function') ? readerSidecarOf(el) : null;
      if (expect.sidecar) {
        if (!sc) out.push('sidecar-missing');
        else {
          const id = sc.identity();
          if (String(id.itemId) !== String(expect.sidecar.itemId) || String(id.requestId) !== String(expect.sidecar.requestId)) out.push('sidecar-identity:' + JSON.stringify(id));
        }
      }
      if (expect.noSidecar && sc) out.push('sidecar-unexpected');
      return out;
    };
    return true;
  })()`;

  const goHome = () => cdp.go(base + '/index.html');
  const boot = async () => {
    await goHome(); await cdp.eval(INSTALL); await cdp.eval(INTEGRITY);
    await cdp.eval(`(async () => { for (let i = 0; i < 400 && !(state.items && state.items.length); i++) await window.__sleep(5); return (state.items || []).length; })()`);
  };
  // 等真实完成：出现 capture → 最后渲染 promise 结算 + 两个宏任务跳（完成→sidecar）+ 双 rAF（终帧）
  const WAIT_DONE = `(async () => {
    const caps = window.__capResults;
    const tStart = performance.now();
    let last = null;
    for (let i = 0; i < 600; i++) {
      if (caps.length) { last = caps[caps.length - 1]; if (last.done) break; }
      await window.__sleep(5);
    }
    if (!last) return { error: 'no-capture', waitedMs: performance.now() - tStart };
    if (!last.done) return { error: 'timeout', waitedMs: performance.now() - tStart };
    await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { status: last.status, rendered: last.rendered, reason: last.reason || null, waitedMs: Math.round(performance.now() - tStart), tCreated: Math.round(last.tCreated || -1) };
  })()`;
  const waitDone = () => cdp.eval(WAIT_DONE);
  // 打开条目（必要时先刷新列表，保证 findItem 命中真实生产路径）
  const openItem = (id) => cdp.eval(`(async () => { if (!findItem(${id})) { await load(false); } if (!findItem(${id})) return false; state.sel = ${id}; renderDetail(); return true; })()`);
  const J = (v) => JSON.stringify(v);

  /* ============ G1：真实详情接线 ============ */
  seed([mkItem(1, 'A', DOC_A)]);
  setContent(1, env(DOC_A, 'req-A'), DOC_A);
  await boot();
  netLog = [];
  const ok1 = await openItem(1);
  let r1 = await waitDone();
  const w1 = await cdp.eval(`(() => { const el = document.getElementById('aibody');
    const sc = readerSidecarOf(el); const blk = sc && sc.entries().find((e) => e.kind === 'code-block' && e.available);
    const sl = blk && sc.slice(blk.id, el.__nayanDecision, el.__nayanIdentity);
    return { rich: el.classList.contains('rich'), nodes: el.querySelectorAll('*').length,
      marker: el.textContent.indexOf('DOC-A') >= 0, yields: window.__gate.counts().yield,
      sidecar: sc && { itemId: sc.identity().itemId, requestId: sc.identity().requestId },
      sliceOk: !!(sl && sl.ok && sl.text.length > 10 && sl.text.indexOf('const v') >= 0),
      togglerVisible: document.getElementById('togglerich') && document.getElementById('togglerich').style.display !== 'none' }; })()`);
  check('G1-wire', '真实详情路由：markdown → 异步 rich 渲染 + sidecar（itemId=1/requestId=req-A）+ 源码切换按钮',
    ok1 === true && r1.status === 'rendered' && r1.rendered === true && w1.rich && w1.marker && w1.nodes > 500 && w1.sidecar && String(w1.sidecar.itemId) === '1' && w1.sidecar.requestId === 'req-A' && w1.sliceOk && w1.togglerVisible,
    JSON.stringify({ r1, w1 }));

  seed([mkItem(2, 'S', DOC_SMALL)]);
  setContent(2, env(DOC_SMALL, 'req-S'), DOC_SMALL);
  const ok2 = await openItem(2);
  const tSmall0 = Date.now();
  let r2 = await waitDone();
  const smallMs = Date.now() - tSmall0;
  const w2 = await cdp.eval(`(() => ({ yields: window.__gate.counts().yield, rich: document.getElementById('aibody').classList.contains('rich'), marker: document.getElementById('aibody').textContent.indexOf('小文') >= 0 }))()`);
  check('G1-small', '小内容一批完成、零 yield、不为短文强制多帧（时延含通信与轮询容许 <2000ms）',
    ok2 === true && r2.status === 'rendered' && w2.yields === 0 && w2.rich && w2.marker && smallMs < 2000, JSON.stringify({ r2, w2, smallMs }));

  /* ============ G2：切换竞态（闸门内单次求值，条件轮询非固定 sleep） ============ */
  // ① A→B：renderDetail 重建 #detail → 旧 #aibody 脱离文档 → 旧任务死；A 的迟到 yield 放行后不得写 DOM
  seed([mkItem(11, 'A', DOC_A), mkItem(12, 'B', DOC_B)]);
  setContent(11, env(DOC_A, 'req-A'), DOC_A);
  setContent(12, env(DOC_B, 'req-B'), DOC_B);
  await boot();
  const ab = await cdp.eval(`(async () => {
    try {
    window.__gate.arm();
    state.sel = 11; renderDetail();
    const elA = document.getElementById('aibody');
    for (let i = 0; i < 3000 && elA.querySelectorAll('*').length === 0; i++) { if (window.__gate.heldCount() > 0) window.__gate.release(1); await window.__sleep(2); }   // 推进到首个回挂（条件驱动）
    const mid = { heldA: window.__gate.heldCount(), partialA: elA.querySelectorAll('*').length > 0, markerA: elA.textContent.indexOf('DOC-A') >= 0,
      sidecarMid: readerSidecarOf(elA) === null, taskLive: !!elA.__nayanRenderTask };
    state.sel = 12; renderDetail();                       // B 接管：旧元素脱离文档 → 旧任务死
    for (let i = 0; i < 600 && window.__gate.heldCount() <= mid.heldA; i++) await window.__sleep(2); // B 也到首个 yield
    const stale = window.__gate.release(null); window.__gate.disarm();  // 放行 A 与 B 的全部迟到回调
    const caps = window.__capResults;
    let last = caps[caps.length - 1] || null;
    for (let i = 0; i < 600 && !(last && last.done); i++) { await window.__sleep(5); const cur = caps[caps.length - 1] || null; if (cur !== last) last = cur; }
    if (!last) return { error: 'no-capture' };
    await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.getElementById('aibody');
    const sc = readerSidecarOf(el); const blk = sc && sc.entries().find((e) => e.kind === 'code-block' && e.available);
    return { mid, stale, statuses: caps.map((c) => c.status), lastStatus: last.status, capCountNow: caps.length,
      final: { markerB: el.textContent.indexOf('DOC-B') >= 0, staleA: el.textContent.indexOf('DOC-A') >= 0,
        sidecar: sc && { itemId: sc.identity().itemId, requestId: sc.identity().requestId },
        sliceOk: !!(blk && sc.slice(blk.id, el.__nayanDecision, el.__nayanIdentity).ok) } };
    } catch (e) { return { pageError: String(e && e.stack || e) }; }
  })()`);
  check('G2-AB', 'A→B（元素替换）：途中 sidecar 未发布；A 迟到 yield 放行后零错写；最终 DOM/sidecar/切片全属 B；A 状态=cancelled',
    ab.mid.heldA > 0 && ab.mid.partialA && ab.mid.markerA && ab.mid.sidecarMid === true && ab.mid.taskLive
      && ab.statuses.includes('cancelled') && ab.lastStatus === 'rendered'
      && ab.final.markerB && !ab.final.staleA && String(ab.final.sidecar.itemId) === '12' && ab.final.sidecar.requestId === 'req-B' && ab.final.sliceOk,
    JSON.stringify(ab));

  // ② A→B→A
  const aba = await cdp.eval(`(async () => {
    const caps = window.__capResults; const cap0 = caps.length;
    state.sel = 11; renderDetail();
    let last = null;
    for (let i = 0; i < 900 && !(caps.length > cap0 && (last = caps[caps.length - 1]).done); i++) await window.__sleep(5);
    await new Promise((r) => window.__origSetTimeout(r, 0)); await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.getElementById('aibody'); const sc = readerSidecarOf(el);
    const blk = sc && sc.entries().find((e) => e.kind === 'code-block' && e.available);
    return { status: last.status, markerA: el.textContent.indexOf('DOC-A') >= 0, markerB: el.textContent.indexOf('DOC-B') >= 0,
      sidecar: sc && { itemId: sc.identity().itemId, requestId: sc.identity().requestId },
      sliceOk: !!(blk && sc.slice(blk.id, el.__nayanDecision, el.__nayanIdentity).text.indexOf('const v') >= 0),
      dbg: { cap0, capsNow: caps.length, statuses: caps.map((c) => c.status), children: el.children.length,
        textLen: el.textContent.length, rich: el.classList.contains('rich'), dec: !!el.__nayanDecision,
        decMode: el.__nayanDecision && el.__nayanDecision.mode, decLen: el.__nayanDecision && el.__nayanDecision.text && el.__nayanDecision.text.length,
        cache: !!el.__nayanSidecarCache, req: el.__nayanIdentity && el.__nayanIdentity.requestId } };
  })()`);
  check('G2-ABA', 'A→B→A：回到 A = 新任务新 sidecar，A 内容/身份/切片恢复精确',
    aba.status === 'rendered' && aba.markerA && !aba.markerB && String(aba.sidecar.itemId) === '11' && aba.sidecar.requestId === 'req-A' && aba.sliceOk,
    JSON.stringify(aba));

  // ③ 同元素同 request 变文（同长度异文）：三任务串 —— 完成的 task1（缓存 sidecar）→ 在途 task2（持住）→ task3 取消 task2
  seed([mkItem(21, 'S', DOC_A)]);
  setContent(21, env(DOC_A, 'req-S1'), DOC_A);
  await boot();
  await openItem(21);
  await waitDone();
  setContent(21, env(DOC_B_SAMELEN, 'req-S1'), DOC_B_SAMELEN); // 同 item 同 request_id，正文换同长度异文
  const sw = await cdp.eval(`(async () => {
    const el0 = document.getElementById('aibody');
    const oldSc = el0.__nayanSidecarCache;                    // 完成渲染缓存下来的旧 sidecar（DOC_A/req-S1）
    const oldEnt = oldSc && oldSc.entries().find((e) => e.kind === 'code-block' && e.available);
    window.__oldSlice = oldEnt && { id: oldEnt.id };
    window.__gate.arm();
    bindEntry(findItem(21));                                   // 同元素重绑（新文 DOC_B_SAMELEN，同 req-S1）
    for (let i = 0; i < 600 && window.__capCount < 2; i++) await window.__sleep(2);
    const elS = document.getElementById('aibody');
    for (let i = 0; i < 3000 && window.__gate.heldCount() === 0; i++) await window.__sleep(2); // task2 在途（已到首个 yield）
    const elMid = document.getElementById('aibody');
    const mid = { cap2: window.__capCount, task2Live: !!elMid.__nayanRenderTask };
    bindEntry(findItem(21));                                   // task3：取消 task2
    for (let i = 0; i < 600 && window.__capCount < 3; i++) await window.__sleep(2);
    window.__gate.release(null); window.__gate.disarm();
    const caps = window.__capResults; let last = caps[caps.length - 1];
    for (let i = 0; i < 600 && !last.done; i++) await window.__sleep(5);
    await new Promise((r) => window.__origSetTimeout(r, 0)); await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.getElementById('aibody'); const sc = readerSidecarOf(el);
    const oldRejected = oldSc && oldEnt && oldSc.slice(oldEnt.id, el.__nayanDecision, el.__nayanIdentity).ok === false;
    return { mid, statuses: caps.map((c) => c.status), lastStatus: last.status,
      markerNew: el.textContent.indexOf('DOC-B') >= 0, staleA: el.textContent.indexOf('DOC-A') >= 0,
      sidecar: sc && { itemId: sc.identity().itemId, requestId: sc.identity().requestId }, oldRejected };
  })()`);
  check('G2-same-req-newtext', '同元素同 request 变文（同长度异文）：task2 被 task3 取消；最终 DOM 属新文；旧 sidecar 对新正文拒绝',
    sw.mid.cap2 === 2 && sw.statuses[1] === 'cancelled' && sw.lastStatus === 'rendered'
      && sw.markerNew && !sw.staleA && String(sw.sidecar.itemId) === '21' && sw.sidecar.requestId === 'req-S1' && sw.oldRejected === true,
    JSON.stringify(sw));

  // ④ 源码/排版连续切换（渲染途中点两次）
  seed([mkItem(31, 'T', DOC_A)]);
  setContent(31, env(DOC_A, 'req-T'), DOC_A);
  await boot();
  const tg = await cdp.eval(`(async () => {
    window.__gate.arm();
    state.sel = 31; renderDetail();
    const elT = document.getElementById('aibody');
    for (let i = 0; i < 3000 && elT.querySelectorAll('*').length === 0; i++) { if (window.__gate.heldCount() > 0) window.__gate.release(1); await window.__sleep(2); }
    const btn = document.getElementById('togglerich');
    btn.click();                                               // 排版→源码：取消在途任务 + plain
    const plainOk = !document.getElementById('aibody').classList.contains('rich')
      && document.getElementById('aibody').textContent.indexOf('DOC-A') >= 0;
    btn.click();                                               // 源码→排版：重新异步渲染
    window.__gate.release(null); window.__gate.disarm();
    const caps = window.__capResults; let last = caps[caps.length - 1];
    for (let i = 0; i < 600 && !last.done; i++) await window.__sleep(5);
    await new Promise((r) => window.__origSetTimeout(r, 0)); await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.getElementById('aibody'); const sc = readerSidecarOf(el);
    return { plainOk, statuses: caps.map((c) => c.status), lastStatus: last.status,
      rich: el.classList.contains('rich'), marker: el.textContent.indexOf('DOC-A') >= 0,
      sidecar: sc && { itemId: sc.identity().itemId, requestId: sc.identity().requestId } };
  })()`);
  check('G2-toggle', '渲染途中源码↔排版连续切换：在途任务取消、源码态全文可读、终态 rich 完整 + sidecar 正确',
    tg.plainOk && tg.statuses.includes('cancelled') && tg.lastStatus === 'rendered' && tg.rich && tg.marker
      && String(tg.sidecar.itemId) === '31' && tg.sidecar.requestId === 'req-T',
    JSON.stringify(tg));

  /* ============ G3：必败控制（断言有牙）+ 撤销后对照不误伤 ============ */
  const neg = await cdp.eval(`(() => {
    const el = document.getElementById('aibody');
    const out = {};
    el.insertAdjacentHTML('beforeend', '<p>__STALE_SLICE__</p>');       // ① 旧片错写
    out.staleDom = window.__viol({ marker: 'DOC-A', absent: '__STALE_SLICE__' }).length > 0;
    el.lastChild.remove();
    out.cleanAfterUndo = window.__viol({ marker: 'DOC-A', absent: '__STALE_SLICE__' }).length === 0;
    const fake = { identity: () => ({ itemId: 999, requestId: 'req-XXX', revision: null }), entries: () => [],  // ② 错身份 sidecar + 伪造完成
      check: () => false, slice: () => ({ ok: false }) };
    el.__nayanSourceMap = fake;
    out.wrongSidecar = window.__viol({ marker: 'DOC-A', sidecar: { itemId: 31, requestId: 'req-T' } }).length > 0;
    el.__nayanSourceMap = null;
    return out;
  })()`);
  check('G3-teeth', '必败控制：旧片错写/错身份 sidecar 必被同一断言器抓住；撤销后正常对照通过（不误伤）',
    neg.staleDom && neg.wrongSidecar && neg.cleanAfterUndo, JSON.stringify(neg));

  /* ============ G4：安全（敌意内容走真实异步分批路径） ============ */
  seed([mkItem(41, 'H', DOC_HOSTILE), mkItem(42, 'HH', DOC_HTML_HOSTILE)]);
  setContent(41, env(DOC_HOSTILE, 'req-H'), DOC_HOSTILE);
  setContent(42, env(DOC_HTML_HOSTILE, 'req-HH', 'html'), DOC_HTML_HOSTILE);
  await boot();
  netLog = [];
  const hs = await cdp.eval(`(async () => {
    window.__gate.arm();
    state.sel = 41; renderDetail();
    const el1 = document.getElementById('aibody');
    for (let i = 0; i < 3000 && el1.querySelectorAll('*').length === 0; i++) { if (window.__gate.heldCount() > 0) window.__gate.release(1); await window.__sleep(2); }   // 首段已回挂、后续批被持住
    const badEarly = ['SCRIPT','IFRAME','IMG','VIDEO','OBJECT','EMBED','STYLE','FORM','INPUT']
      .reduce((n, t) => n + el1.querySelectorAll(t).length, 0)
      + [...el1.querySelectorAll('*')].reduce((n, x) => n + [...x.attributes].filter((a) => a.name.startsWith('on')).length, 0);
    window.__gate.release(null); window.__gate.disarm();
    const caps = window.__capResults; let last = caps[caps.length - 1];
    for (let i = 0; i < 600 && !last.done; i++) await window.__sleep(5);
    await new Promise((r) => window.__origSetTimeout(r, 0)); await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.getElementById('aibody');
    const all = [...el.querySelectorAll('*')];
    const onAttrs = all.flatMap((n) => [...n.attributes].filter((a) => a.name.startsWith('on')).map((a) => a.name));
    const badTags = all.filter((n) => ['SCRIPT','IFRAME','IMG','VIDEO','OBJECT','EMBED','STYLE','FORM','INPUT'].includes(n.tagName)).map((n) => n.tagName);
    const badHref = [...el.querySelectorAll('a')].filter((a) => { const h = a.getAttribute('href'); return h != null && !/^https?:\\/\\//.test(h); }).length;
    const before = location.href;
    const a0 = el.querySelector('a'); if (a0) a0.click();             // 链接惰性：不导航
    return { held: window.__gate.counts().yield, badEarly, status: last.status,
      onAttrs, badTags, badHref, pwned: !!window.__pwned,
      literal: el.textContent.indexOf('<script>') >= 0, nav: location.href === before };
  })()`);
  const external = netLog.filter((u) => !u.startsWith(base));
  check('G4-hostile-md', '敌意 markdown 分批渲染：首批与终态均零危险节点/零事件属性/零危险 href；零执行/零外联/零导航；内嵌 HTML 转义字面',
    hs.held > 0 && hs.badEarly === 0 && hs.status === 'rendered' && hs.pwned === false && hs.onAttrs.length === 0
      && hs.badTags.length === 0 && hs.badHref === 0 && hs.literal && hs.nav && external.length === 0,
    JSON.stringify({ hs, external }));
  await openItem(42);
  let rHH = await waitDone();
  const wHH = await cdp.eval(`(() => { const el = document.getElementById('aibody');
    return { strong: !!el.querySelector('strong'), pwned: !!window.__pwned,
      onAttrs: [...el.querySelectorAll('*')].reduce((n, x) => n + [...x.attributes].filter((a) => a.name.startsWith('on')).length, 0) }; })()`);
  check('G4-hostile-html', '声明 HTML 敌意信封：白名单保留 strong、剥脚本/事件属性/危险链接',
    rHH.status === 'rendered' && wHH.strong && !wHH.pwned && wHH.onAttrs === 0, JSON.stringify({ rHH, wHH }));

  /* ============ G5：回退/错误路径 ============ */
  seed([mkItem(51, 'F1', DOC_A), mkItem(52, 'F2', DOC_A), mkItem(53, 'F3', DOC_A), mkItem(54, 'F4', DOC_A), mkItem(55, 'F5', 'bin')]);
  setContent(51, env(DOC_A, 'req-F1'), DOC_A);
  setContent(52, env(DOC_A, 'req-F2'), DOC_A);
  setContent(53, env(DOC_A, 'req-F3'), DOC_A);
  setContent(54, env(DOC_A, 'req-F4'), DOC_A);
  setContent(55, { schema_version: 1, request_id: 'req-F5', format: 'plain', format_provenance: 'declared', original: { kind: 'bytes' }, canonical: null, canonical_unavailable_reason: '二进制原文' }, '');
  await boot();
  const FBPOLL = `const caps = window.__capResults; let r = null;
    for (let i = 0; i < 500 && !(caps.length > cap0 && (r = caps[caps.length - 1]).done); i++) await window.__sleep(5);`;
  const f1 = await cdp.eval(`(async () => {
    const keep = window.markdownit; window.markdownit = undefined;
    const cap0 = window.__capResults.length; state.sel = 51; renderDetail(); ${FBPOLL}
    const el = document.getElementById('aibody');
    const out = { status: r && r.status, reason: r && r.reason, plain: el.textContent === ${J(DOC_A)}, noRich: !el.classList.contains('rich') };
    window.markdownit = keep; return out; })()`);
  check('G5-no-parser', '解析器缺失：failed + 明确原因 + plain 源文本回退（不吞错假报 rendered）',
    f1.status === 'failed' && /解析器未加载/.test(f1.reason || '') && f1.plain && f1.noRich, JSON.stringify(f1));
  const f2 = await cdp.eval(`(async () => {
    const keep = DOMPurify.sanitize; DOMPurify.sanitize = () => null;   // API 级故障注入（渲染仍为真产品代码）
    const cap0 = window.__capResults.length; state.sel = 52; renderDetail(); ${FBPOLL}
    const el = document.getElementById('aibody');
    const out = { status: r && r.status, reason: r && r.reason, plain: el.textContent === ${J(DOC_A)} };
    DOMPurify.sanitize = keep; return out; })()`);
  check('G5-sanitize-null', '清洗器故障（sanitize→null）：failed + 回退 plain 源文本',
    f2.status === 'failed' && /清洗不可用/.test(f2.reason || '') && f2.plain, JSON.stringify(f2));
  const f3 = await cdp.eval(`(async () => {
    const keepMD=window.__nayanSourceMapMD;
    window.__nayanSourceMapMD = { parse() { throw new Error('boom'); } };
    const cap0 = window.__capResults.length; state.sel = 53; renderDetail(); ${FBPOLL}
    const el = document.getElementById('aibody');
    const out = { status: r && r.status, reason: r && r.reason, plain: el.textContent === ${J(DOC_A)} };
    window.__nayanSourceMapMD = keepMD; return out; })()`);
  check('G5-parse-throw', '解析抛错：failed + 原因含解析失败 + plain 回退', f3.status === 'failed' && /解析失败/.test(f3.reason || '') && f3.plain, JSON.stringify(f3));
  const f4 = await cdp.eval(`(async () => {
    try { localStorage.setItem('nayan-rich-disable', '1'); } catch (e) {}
    const cap0 = window.__capResults.length; state.sel = 54; renderDetail(); ${FBPOLL}
    const el = document.getElementById('aibody');
    const out = { status: r && r.status, reason: r && r.reason, plain: el.textContent === ${J(DOC_A)} };
    try { localStorage.setItem('nayan-rich-disable', '0'); } catch (e) {} return out; })()`);
  check('G5-disabled', 'rich 停用：failed（停用原因）+ 源码态全文可读；取消态不误触发旧稿 fallback',
    f4.status === 'failed' && /停用/.test(f4.reason || '') && f4.plain, JSON.stringify(f4));
  const f5 = await cdp.eval(`(async () => { const cap0 = window.__capResults.length; state.sel = 55; renderDetail(); ${FBPOLL}
    const el = document.getElementById('aibody');
    return { status: r && r.status, ph: (el.textContent || '').indexOf('（') === 0 }; })()`);
  check('G5-unrenderable', '不可渲染：安全可读占位（（原因））+ rendered:false', f5.status === 'rendered' && f5.ph, JSON.stringify(f5));

  /* ============ G6：最终输出与同步实现逐项一致（3.5） ============ */
  seed([mkItem(61, 'C', DOC_STRUCT)]);
  setContent(61, env(DOC_STRUCT, 'req-C'), DOC_STRUCT);
  await boot();
  await openItem(61);
  let rC = await waitDone();
  const cmp = await cdp.eval(`(async () => {
    const detail = document.getElementById('aibody');
    const asyncOut=await window.__capResults[window.__capResults.length-1].p;
    const scratch = document.createElement('div');
    scratch.className = 'aibody'; scratch.classList.add('rich');
    document.body.appendChild(scratch);
    const out = renderReaderBody(scratch, { format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: ${J(DOC_STRUCT)} }, null);
    const walk = (n) => n.tagName + '(' + [...n.attributes].map((a) => a.name + '=' + a.value).sort().join(',') + ')' + '[' + [...n.children].map(walk).join('') + ']';
    const sig = (el) => [...el.children].map(walk).join('|');
    const codeTexts = (el) => [...el.querySelectorAll('pre')].map((p) => p.textContent);
    const res = { structEq: sig(detail) === sig(scratch), projEq: plainProjection(detail) === out.projection && asyncOut.projection === out.projection,
      codeEq: JSON.stringify(codeTexts(detail)) === JSON.stringify(codeTexts(scratch)),
      olStarts: [...detail.querySelectorAll('ol')].map((o) => o.getAttribute('start')), syncRendered: out.rendered };
    scratch.remove(); return res; })()`);
  check('G6-parity', '异步分批最终 DOM 结构/属性/code text/plain projection 与同步实现逐项一致（嵌套列表/非1起始/表格/长行/空码块/组合字符）',
    rC.status === 'rendered' && cmp.structEq && cmp.projEq && cmp.codeEq && cmp.syncRendered
      && cmp.olStarts.filter((s) => s === '5').length === 1 && cmp.olStarts.every((s) => s !== '1'),
    JSON.stringify(cmp));

  /* G7/G8 用条目：91=同 decision 复用（DOC_A），92=换条目（DOC_B） */
  registry.set(91, { item: mkItem(91, 'G8-A', DOC_A), content: { content: env(DOC_A, 'req-g8a'), quote: DOC_A } });
  registry.set(92, { item: mkItem(92, 'G8-B', DOC_B), content: { content: env(DOC_B, 'req-g8b'), quote: DOC_B } });
  await cdp.eval(`(async () => { await load(false); return state.items.length; })()`);

  /* ============ G7（R1-F01）：三分支并发/取消/结算 ============ */
  // ① MC 分支并发双容器：两个已连接的 .aibody 同时多批渲染，各自 promise 都必须结算
  const mc2 = await cdp.eval(`(async () => {
    window.__branch.set('mc');
    const host = document.getElementById('detail') || document.body;
    const d1 = document.createElement('div'); d1.className = 'aibody';
    const d2 = document.createElement('div'); d2.className = 'aibody';
    host.appendChild(d1); host.appendChild(d2);
    const mk = (t, id) => ({ format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: ${J(DOC_A)} .replace(/DOC-A/g, t) });
    const a = mk('MC-T1', 1), b = mk('MC-T2', 2);
    const idA = Object.freeze({ itemId: 71, requestId: 'mc-71', revision: null });
    const idB = Object.freeze({ itemId: 72, requestId: 'mc-72', revision: null });
    d1.__nayanDecision = a; d1.__nayanIdentity = idA;
    d2.__nayanDecision = b; d2.__nayanIdentity = idB;
    window.__capResults = []; window.__capCount = 0;
    const ev = [];
    const p1 = renderReaderBodyAsync(d1, a, null);
    ev.push('A-start');
    const p2 = renderReaderBodyAsync(d2, b, null); ev.push('B-start');
    const r1 = await p1; ev.push('A-settled');
    const r2 = await p2; ev.push('B-settled');
    const out = { ev, r1: r1.status, r2: r2.status,
      a1: d1.textContent.indexOf('MC-T1') >= 0 && d1.textContent.indexOf('MC-T2') < 0,
      b2: d2.textContent.indexOf('MC-T2') >= 0 && d2.textContent.indexOf('MC-T1') < 0,
      nodes1: d1.querySelectorAll('*').length, nodes2: d2.querySelectorAll('*').length };
    d1.remove(); d2.remove();
    window.__branch.set('st');
    return out;
  })()`);
  check('G7-mc-concurrent', 'MC 分支并发双容器：两个等待各自结算（FIFO 一一对应）、内容互不串扰',
    mc2.r1 === 'rendered' && mc2.r2 === 'rendered' && mc2.a1 && mc2.b2 && mc2.nodes1 > 500 && mc2.nodes2 > 500,
    JSON.stringify(mc2));

  // ② MC 分支同元素 A 在途→B 接管→B 完成；A 必须结算为 cancelled（不是永远 pending）
  const mcCancel = await cdp.eval(`(async () => {
    window.__branch.set('mc');
    const el = document.getElementById('aibody');
    const a = { format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: ${J(DOC_A)} };
    const b = { format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: ${J(DOC_B)} };
    el.__nayanDecision = a; el.__nayanIdentity = Object.freeze({ itemId: 81, requestId: 'mc-A', revision: null });
    window.__capResults = []; window.__capCount = 0;
    const ev = [];
    const pA = renderReaderBodyAsync(el, a, null); ev.push('A-start');
    await window.__sleep(30);                       // A 进入首批/首个 yield（真实 MC 传输在途）
    ev.push('A-inflight:' + (!window.__capResults[0].done));
    el.__nayanDecision = b; el.__nayanIdentity = Object.freeze({ itemId: 82, requestId: 'mc-B', revision: null });
    const pB = renderReaderBodyAsync(el, b, null); ev.push('B-start');   // 接管即取消 A
    const settleWithTimeout = (pm, ms) => Promise.race([pm.then((r) => ({ settled: true, status: r.status })), new Promise((r) => window.__origSetTimeout(() => r({ settled: false }), ms))]);
    const aRes = await settleWithTimeout(pA, 5000); ev.push('A-settled:' + aRes.settled + ':' + aRes.status);
    const bRes = await pB; ev.push('B-settled:' + bRes.status);
    const out = { ev, aSettled: aRes.settled, aStatus: aRes.status, bStatus: bRes.status,
      finalIsB: el.textContent.indexOf('DOC-B') >= 0 && el.textContent.indexOf('DOC-A') < 0 };
    window.__branch.set('st');
    return out;
  })()`);
  check('G7-mc-cancel-settles', 'MC 分支：A 在途被 B 接管后结算为 cancelled（实际结算状态+事件序，非超时冒充）；B 正常；终态归 B',
    mcCancel.aSettled === true && mcCancel.aStatus === 'cancelled' && mcCancel.bStatus === 'rendered' && mcCancel.finalIsB
      && mcCancel.ev.join(',').indexOf('A-inflight:true') >= 0,
    JSON.stringify(mcCancel));

  // ③ MC 分支 A→B→A（正常对照：所有 capture 都结算且归属正确）
  const mcAba = await cdp.eval(`(async () => {
    window.__branch.set('mc');
    const el = document.getElementById('aibody');
    const t = ${J(DOC_A)};
    const mkD = () => ({ format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: t });
    el.__nayanIdentity = Object.freeze({ itemId: 83, requestId: 'mc-aba', revision: null });
    window.__capResults = []; window.__capCount = 0;
    const dA = mkD(); el.__nayanDecision = dA;
    const r1 = await renderReaderBodyAsync(el, dA, null);
    const dB = mkD(); el.__nayanDecision = dB;   // 同文同身份、新 decision 对象（就绪后再渲染）
    const r2 = await renderReaderBodyAsync(el, dB, null);
    const out = { r1: r1.status, r2: r2.status, both: el.textContent.indexOf('DOC-A') >= 0, nodes: el.querySelectorAll('*').length };
    window.__branch.set('st');
    return out;
  })()`);
  check('G7-mc-serial', 'MC 分支串行同文两次（正常对照）：两个等待均结算、输出完整',
    mcAba.r1 === 'rendered' && mcAba.r2 === 'rendered' && mcAba.both && mcAba.nodes > 500, JSON.stringify(mcAba));

  // ④ scheduler 分支正常对照：真实 scheduler.yield 被实际使用且完成
  const schedRun = await cdp.eval(`(async () => {
    window.__branch.set('sched');
    window.__schedYieldCount = 0;
    const el = document.getElementById('aibody');
    const d = { format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: ${J(DOC_A)} };
    el.__nayanDecision = d; el.__nayanIdentity = Object.freeze({ itemId: 84, requestId: 'sched-84', revision: null });
    window.__capResults = []; window.__capCount = 0;
    const r = await renderReaderBodyAsync(el, d, null);
    const out = { status: r.status, schedYields: window.__schedYieldCount, marker: el.textContent.indexOf('DOC-A') >= 0 };
    window.__branch.set('st');
    return out;
  })()`);
  check('G7-sched-normal', 'scheduler 分支正常对照：真实 scheduler.yield 被使用（计数>0）且渲染完成',
    schedRun.status === 'rendered' && schedRun.schedYields > 0 && schedRun.marker, JSON.stringify(schedRun));

  /* ============ G8（R1-F02）：完成跳绑定本次任务代次 ============ */
  // 精确交错：A 完整渲染→持住 A 完成跳→同元素同 decision 对象启动 B→旧跳抵达时 sidecar 必须为 null→B 完成后才发布
  const gen1 = await cdp.eval(`(async () => {
    window.__gate.arm();
    const cap0 = window.__capResults.length;
    state.sel = 91; renderDetail();
    const el = document.getElementById('aibody');
    // 推进到「本次 fill 的新 capture」promise 结算（release 逐个放行 yield），完成跳仍是 held 的 delay-0 定时器
    let rec = null;
    for (let i = 0; i < 4000; i++) {
      await window.__sleep(3);
      if (window.__capResults.length > cap0) rec = window.__capResults[window.__capResults.length - 1];
      if (rec && rec.done) break;
      if (window.__gate.heldCount() > 0) window.__gate.release(1);
    }
    if (!rec || !rec.done) { window.__gate.disarm(); return { error: 'render-not-done' }; }
    if (!el.__nayanDecision) { window.__gate.disarm(); return { error: 'decision-missing' }; }
    const heldComplete = window.__gate.heldCount();   // A 完成跳在持（可能连同其他 0-delay 回调）
    // 同元素、同 decision 对象启动 B（生产 fillReaderBody 就地重渲路径）
    fillReaderBody(el, el.__nayanDecision);
    const bRec = window.__capResults[window.__capResults.length - 1];
    // 放行恰好 1 个旧回调（A 的完成跳）：此时 B 未完成，sidecar 必须仍为 null
    window.__gate.release(1);
    await window.__sleep(5);
    const afterOld = { sidecar: readerSidecarOf(el) !== null, bDone: bRec.done, bNodes: el.querySelectorAll('*').length, bLive: !!el.__nayanRenderTask };
    window.__gate.release(null); window.__gate.disarm();
    for (let i = 0; i < 600 && !bRec.done; i++) await window.__sleep(5);
    await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const final = { sidecar: readerSidecarOf(el) !== null, bDone: bRec.done, marker: el.textContent.indexOf('DOC-A') >= 0 };
    return { heldComplete, afterOld, final, bStatus: bRec.status };
  })()`);
  check('G8-gen-old-hop', '旧完成跳抵达时（B 未完成、同 decision 对象）sidecar 保持 null；B 完成后才发布',
    gen1.heldComplete > 0 && gen1.afterOld.sidecar === false && gen1.afterOld.bDone === false
      && gen1.final.bDone === true && gen1.final.sidecar === true && gen1.bStatus === 'rendered' && gen1.final.marker,
    JSON.stringify(gen1));

  // 取消后旧 timer：A 完成跳持住→换条目 C（取消+换代）→放行旧跳→C 完成前不得发布
  const gen2 = await cdp.eval(`(async () => {
    window.__gate.arm();
    const cap0 = window.__capResults.length;
    state.sel = 91; renderDetail();
    const el = document.getElementById('aibody');
    let rec = null;
    for (let i = 0; i < 4000; i++) {
      await window.__sleep(3);
      if (window.__capResults.length > cap0) rec = window.__capResults[window.__capResults.length - 1];
      if (rec && rec.done) break;
      if (window.__gate.heldCount() > 0) window.__gate.release(1);
    }
    if (!rec || !rec.done) { window.__gate.disarm(); return { error: 'render-not-done' }; }
    const capC0 = window.__capResults.length;
    state.sel = 92; renderDetail();     // 换条目：元素替换+换代次（旧元素脱离文档）
    window.__gate.release(null); window.__gate.disarm();  // 旧跳全部放行
    // READER-CONTRACT-REPAIR-01：取样修复（断言不变）——旧写法假设 92 的 /reader 在固定
    // sleep(10) 内返回并取「最后一个 capture」；负载高时 92 尚未启动，取到的是 91 的 rec。
    // 改为显式等待 92 的新 capture 出现，再等它结算；期待值与发布守卫断言一字未改。
    let cRec = null;
    for (let i = 0; i < 3000 && !(cRec && cRec.done); i++) {
      await window.__sleep(5);
      const last = window.__capResults[window.__capResults.length - 1];
      if (window.__capResults.length > capC0) cRec = last;
    }
    const elC = document.getElementById('aibody');        // 新元素
    await new Promise((r) => window.__origSetTimeout(r, 0)); await new Promise((r) => window.__origSetTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { cStatus: cRec && cRec.status, markerC: elC.textContent.indexOf('DOC-B') >= 0,
      sidecarC: readerSidecarOf(elC) !== null };
  })()`);
  check('G8-gen-cancel-oldtimer', '换条目后旧完成跳放行：新条目完成前不发布、完成后正常发布（代次+脱离文档双守卫）',
    gen2.cStatus === 'rendered' && gen2.markerC && gen2.sidecarC, JSON.stringify(gen2));

  // G9: small real render promises settle; only their completion timers are held.
  const contexts=await cdp.eval(`(async()=>{
    __branch.set('st');const el=document.getElementById('aibody'),rows=[];
    for(const mode of ['normal','cancel','text','format','identity','recovery']){
      cancelReaderBodyRender(el);el.__nayanSourceMap=null;el.__nayanSidecarCache=null;
      el.__nayanIdentity={itemId:91,requestId:'context-original',revision:null};
      const d={format:'markdown',provenance:'declared',mode:'markdown',renderable:true,text:'# Original\\n\\nExact paragraph\\n'};
      __gate.arm();fillReaderBody(el,d);
      const rec=__capResults[__capResults.length-1];await rec.p;await Promise.resolve();
      const held=__gate.heldCount(),body=el.textContent;
      if(mode==='cancel')cancelReaderBodyRender(el);
      if(mode==='text'||mode==='recovery')d.text='# Replacement\\n\\nNever in old DOM\\n';
      if(mode==='format')d.provenance='legacy-assumed-plain';
      if(mode==='identity')el.__nayanIdentity.requestId='context-changed';
      __gate.release();__gate.disarm();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      await new Promise(r=>__origSetTimeout(r,0));
      const rejected=!readerSidecarOf(el),unchanged=el.textContent===body;
      if(mode==='recovery'){
        fillReaderBody(el,d);await __capResults[__capResults.length-1].p;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        await new Promise(r=>__origSetTimeout(r,0));
      }
      const sc=readerSidecarOf(el),slice=sc?sc.slice(sc.entries()[0].id,d,el.__nayanIdentity):null;
      rows.push({mode,held,unchanged,rejected,available:!!sc,body:el.textContent,source:slice,
        ok:held===1&&(mode==='normal'?!!sc&&slice.ok&&slice.text===d.text:
          mode==='recovery'?rejected&&!!sc&&slice.ok&&slice.text===d.text&&el.textContent.includes('Replacement'):
          rejected&&unchanged)});
    }
    return rows;
  })()`);
  for(const row of contexts)check('G9-context',row.mode+': completion context/value/cancel contract',row.ok,JSON.stringify(row));
  const changedInflight=await cdp.eval(`(async()=>{
    const el=document.getElementById('aibody');el.__nayanIdentity={itemId:91,requestId:'inflight-change',revision:null};
    const d={format:'markdown',provenance:'declared',mode:'markdown',renderable:true,text:${J(DOC_A)}};
    __branch.set('st');__gate.arm();fillReaderBody(el,d);
    const rec=__capResults[__capResults.length-1],waiting=__gate.heldCount()>0;
    d.text='Changed while the original tokens are still rendering';
    __gate.release();__gate.disarm();const result=await rec.p;
    return{waiting,status:result.status,map:!!readerSidecarOf(el),hasNewText:el.textContent.includes(d.text)};
  })()`);
  check('G9-inflight','same decision changed during await cancels old render without publishing',
    changedInflight.waiting&&changedInflight.status==='cancelled'&&!changedInflight.map&&!changedInflight.hasNewText,JSON.stringify(changedInflight));

} catch (e) {
  thrown = e; fail++; console.error(e);
} finally {
  try { if (cdp) await cdp.close(); } catch (_) {}
  const status = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown,
    writeEvidence: (result) => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(result, null, 2)) });
  if (!status.ok) fail++;
  await new Promise((resolve) => server.close(resolve));
}
const data = { at_utc: t0, end_utc: new Date().toISOString(), total: results.length, pass: results.length - fail, fail, results };
fs.writeFileSync(path.join(outDir, 'reader-async-results.json'), JSON.stringify(data, null, 2));
console.log(`reader-async: ${data.pass}/${data.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
