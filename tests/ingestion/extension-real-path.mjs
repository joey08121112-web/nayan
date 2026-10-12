#!/usr/bin/env node
// tests/ingestion/extension-real-path.mjs —— P1-T04 真实 extension→sync 路径走查。
//
// 证据链（全部真实组件，零 mock 扩展代码）：
//   * 扩展 = 仓库 extension/ 目录逐字节拷贝（background.js / content/box-select.js 原样），
//     仅 manifest.json 的 host_permissions 追加 http://127.0.0.1/*（测试端口授权；
//     生产 manifest 的 8787 限定不在本测目标内——差异如实记录）；
//   * Chrome headless=new --load-extension 真加载；service worker 经 CDP 真驱动；
//   * 框选 = 页面合成 PointerEvent 序列 → 真实 content script 拾取/开卡（真实 DOM 布局）；
//   * 入库 = 卡片保存按钮 → chrome.runtime.sendMessage → 真实 background saveSuggestion
//     → 真实 HTTP fetch → 测试 sync-server.js → Rust 驱动初始化的 v2 合成库；
//   * 对账 = node:sqlite 直读 DB（envelope/original/quote 逐字符）。
// 用法：node tests/ingestion/extension-real-path.mjs [--out DIR] [--keep]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  REPO, mkWork, rustInit, startSync, freePort, dbOpen, expectEnvelope,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-extension-real-path-'));
const KEEP = process.argv.includes('--keep');
fs.mkdirSync(OUT, { recursive: true });

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
function log(x) { const l = typeof x === 'string' ? x : JSON.stringify(x); logLines.push(l); console.log(l); }
let PASS = 0, FAIL = 0;
function check(step, name, ok, detail) {
  if (ok) { PASS++; log('PASS [' + step + '] ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
  else { FAIL++; log('FAIL [' + step + '] ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
function die(msg) { console.error('extension-real-path: ' + msg); process.exit(1); }

// 浏览器选型：branded Chrome 153 已对 MV3 SW 顶层绑定隔离且随版本拒绝 --load-extension；
// Chrome for Testing（puppeteer 缓存内 150）实测可加载扩展、SW 顶层函数可经 CDP 调用。
const CANDIDATES = [
  process.env.NAYAN_TEST_CHROME,
  path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) die('无可用的 Chrome/Chrome for Testing 二进制');
log({ ev: 'chrome-binary', path: CHROME });

// ---------- CDP 客户端（tests/capture 同法，零依赖） ----------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map(); this.consoleLines = [];
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('CDP ws error')); });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        this.consoleLines.push({ type: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      const p = path.join(OUT, name + '.jpg');
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      log({ ev: 'screenshot', file: p });
    } catch (e) { log({ ev: 'screenshot.err', err: String(e) }); }
  }
}
async function cdpTarget(port, predicate, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const t = list.find(predicate);
      if (t && t.webSocketDebuggerUrl) return t;
    } catch (_) {}
    await wait(300);
  }
  return null;
}

// ---------- 环境：测试库 + sync 服务 + fixture 页 + 扩展拷贝 ----------
const work = mkWork('ext');
const DB = rustInit(path.join(work, 'inbox.db'));
const SYNC_PORT = await freePort();
const sync = await startSync(DB, SYNC_PORT);
const SYNC_BASE = 'http://127.0.0.1:' + SYNC_PORT;
log({ ev: 'sync-server', base: SYNC_BASE, db: DB });

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>框选走查页</title>
<style>body{font:15px/1.7 -apple-system,sans-serif;padding:40px;max-width:720px;margin:auto}
p{border:1px dashed transparent;padding:6px}</style></head><body>
<h1>NaYan 框选走查</h1>
<p id="blk1">第一块：这是用于框选采集的目标段落，包含中文、English 与数字 42。</p>
<p id="blk2">第二块：cats 🐱 emoji 与 é combining 测试字符。</p>
<p id="blk3">第三块：用于第二次框选（超限场景）。</p>
</body></html>`;
const PAGE_PORT = await freePort();
const pageServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE_HTML); });
await new Promise((r) => pageServer.listen(PAGE_PORT, '127.0.0.1', r));
const PAGE_URL = 'http://127.0.0.1:' + PAGE_PORT + '/';
log({ ev: 'fixture-page', url: PAGE_URL });

// 扩展拷贝：源文件逐字节拷贝，仅 manifest 追加 host 权限（记录 diff）
const EXT_SRC = path.join(REPO, 'extension');
const EXT_TEST = path.join(work, 'ext-copy');
fs.mkdirSync(EXT_TEST, { recursive: true });
for (const f of ['manifest.json', 'background.js', 'title-rule.js']) fs.copyFileSync(path.join(EXT_SRC, f), path.join(EXT_TEST, f));
fs.mkdirSync(path.join(EXT_TEST, 'content'), { recursive: true });
fs.copyFileSync(path.join(EXT_SRC, 'content/box-select.js'), path.join(EXT_TEST, 'content/box-select.js'));
{
  const m = JSON.parse(fs.readFileSync(path.join(EXT_TEST, 'manifest.json'), 'utf8'));
  m.host_permissions = Array.from(new Set([...m.host_permissions, 'http://127.0.0.1/*']));
  fs.writeFileSync(path.join(EXT_TEST, 'manifest.json'), JSON.stringify(m, null, 2));
  log({ ev: 'manifest-delta', note: 'host_permissions += http://127.0.0.1/*（仅测试拷贝；产品文件零改动）' });
}
const shaSrc = sha(fs.readFileSync(path.join(EXT_SRC, 'background.js'), 'utf8') + '\0' + fs.readFileSync(path.join(EXT_SRC, 'content/box-select.js'), 'utf8'));
const shaDst = sha(fs.readFileSync(path.join(EXT_TEST, 'background.js'), 'utf8') + '\0' + fs.readFileSync(path.join(EXT_TEST, 'content/box-select.js'), 'utf8'));
check('E0', '扩展源文件逐字节拷贝（background/box-select 与仓库一致）', shaSrc === shaDst, { sha: shaSrc });

// ---------- Chrome ----------
const cdpPort = await freePort();
const profile = path.join(work, 'chrome-profile');
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1000,800',
  '--load-extension=' + EXT_TEST, 'about:blank',
], { stdio: 'ignore' });

try {
  const pageT = await cdpTarget(cdpPort, (t) => t.type === 'page');
  if (!pageT) die('无法获得页面 CDP 目标');
  const page = new CDP(pageT.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.eval('location.href = ' + JSON.stringify(PAGE_URL) + '; ""');
  await wait(600);

  // 等「本扩展」的 service worker 目标：headless 下 /json/list 混有 Chrome 内建组件扩展
  // 的 SW（如 Google Network Speech），必须按 manifest 名识别；我们的 SW 在 onInstalled
  // 后短暂运行即休眠——快速轮询抓取 + 后续定时 ping 保活。
  async function findOurSW(tries = 120) {
    for (let i = 0; i < tries; i++) {
      let list = [];
      try { list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json(); } catch (_) {}
      for (const t of list.filter((x) => x.type === 'service_worker' && x.webSocketDebuggerUrl)) {
        try {
          const probe = new CDP(t.webSocketDebuggerUrl);
          const name = await Promise.race([probe.eval('chrome.runtime.getManifest().name'), wait(1500).then(() => null)]);
          if (name === '纳言捕捉 · NaYan') return probe;
          try { probe.ws.close(); } catch (_) {}
        } catch (_) {}
      }
      await wait(150);
    }
    return null;
  }
  const sw = await findOurSW();
  if (!sw) die('未找到纳言扩展的 service worker（按 manifest 名轮询 120 次）');
  log({ ev: 'sw-target', note: '按 manifest name 识别（排除了 Chrome 内建组件扩展 SW）' });
  await sw.send('Runtime.enable');
  const keepAlive = setInterval(() => { sw.eval('1').catch(() => {}); }, 15000);
  keepAlive.unref?.();

  // SW 侧工具。注：branded Chrome 153 将 MV3 SW 顶层绑定隔离（typeof quickSave === undefined），
  // Chrome for Testing 150 实测可直调——E1 在可直调时走真实调用，不可达时降级为源码断言（如实标注）。
  const swSetEndpoint = (base) => sw.eval('chrome.storage.local.set({ \'nayan:endpoint\': ' + JSON.stringify(base) + ' }).then(() => \'ok\')');
  const swEval = (expr) => sw.eval(expr);

  // ⚠ 隔离硬前提（历史事故修正）：任何保存-capable 步骤之前，必须先完成端点覆盖并回读验证。
  // 首版曾因覆盖晚于 E1/E2 触发默认端点 localhost:8787 → 写入用户生产库（已按内容精确
  // 清除并复核行数/最大 id 复原）。此后本走查在覆盖验证通过前绝不触发保存。
  {
    await swSetEndpoint(SYNC_BASE);
    const back = await swEval('chrome.storage.local.get(\'nayan:endpoint\').then(o => o[\'nayan:endpoint\'])');
    const health = await (await fetch(SYNC_BASE + '/api/health')).json();
    check('E-PRE', '端点覆盖已写入并回读 = 测试服务（生产 8787 绝不可达）',
      back === SYNC_BASE && health.ok === true && health.db === DB, { back: back, healthDb: health.db });
  }
  const swSendViaIsolatedWorld = (payload) => swEval('(async function(){const ts=await chrome.tabs.query({active:true,currentWindow:true});' +
    'const results=await chrome.scripting.executeScript({target:{tabId:ts[0].id},func:(p)=>new Promise(res=>{' +
    'try{chrome.runtime.sendMessage({type:"nayan:save",payload:p},r=>{void chrome.runtime.lastError;res(r||null);});}catch(e){res(null);}' +
    '}),args:[' + JSON.stringify(payload) + ']});return JSON.stringify(results&&results[0]&&results[0].result);})()');

  // ---------- E1: quickSave 旧通道——selectionText 原样（去 trim 证明） ----------
  {
    const src = fs.readFileSync(path.join(REPO, 'extension/background.js'), 'utf8');
    const body = src.slice(src.indexOf('function quickSave'), src.indexOf('chrome.runtime.onMessage'));
    const noTrim = !/selectionText[^;]*\.trim\(\)/.test(body) && /quote:\s*text/.test(body);
    const callable = await swEval('typeof quickSave') === 'function';
    if (callable) {
      const before = dbOpen(DB).prepare('SELECT COUNT(*) n FROM suggestions').get().n;
      await swEval('quickSave(' + JSON.stringify({ selectionText: '  空白保留\r\n第二行·尾随  ', pageUrl: PAGE_URL }) + ', ' + JSON.stringify({ title: '框选走查页' }) + '); \'sent\'');
      await wait(600);
      const c = dbOpen(DB);
      const row = c.prepare("SELECT quote, source_tool, session_ref FROM suggestions WHERE source_tool = 'web' ORDER BY id DESC LIMIT 1").get();
      const after = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
      c.close();
      check('E1', 'quickSave（真实调用）：selectionText 不 trim 逐字符入库', row && row.quote === '  空白保留\r\n第二行·尾随  ' && after === before + 1 && noTrim,
        { stored: row && row.quote, session_ref: row && row.session_ref });
    } else {
      check('E1', 'quickSave 源码契约：selectionText 不 trim、quote 直通（SW 作用域隔离无法直调，如实降级为源码断言）',
        noTrim, { quickSaveLen: body.length });
    }
  }

  // ---------- E2: 真实消息链路保存——正文原样（未 trim）+ 端点覆盖生效 ----------
  {
    const r = await swSendViaIsolatedWorld({ title: 'E2 消息链路', quote: '  直接调用空白  \r\nX', source_tool: 'web' });
    await wait(500);
    const c = dbOpen(DB);
    const row = c.prepare("SELECT quote FROM suggestions WHERE title = 'E2 消息链路'").get();
    c.close();
    const resp = JSON.parse(r);
    check('E2', '真实消息链路保存：未 trim 入库 + 端点覆盖生效', resp && resp.ok === true && row && row.quote === '  直接调用空白  \r\nX',
      { resp: r, stored: row && row.quote });
  }

  // ---------- E3: 完整框选→卡片→保存（失败重试→成功，同 request_id 幂等） ----------
  async function dragSelect(sel) {
    // 每次框选前经真实消息通道重新 arm（content script 的 chrome.runtime.onMessage）
    await swEval('(async function(){const ts=await chrome.tabs.query({active:true,currentWindow:true});' +
      'try{await chrome.tabs.sendMessage(ts[0].id,{type:"nayan:arm"});}catch(e){}return "armed";})()');
    await wait(250);
    const rect = await page.eval('(function(){const r=document.querySelector(' + JSON.stringify(sel) + ').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()');
    const x1 = Math.max(2, rect.x - 30), y1 = Math.max(2, rect.y - 12);
    const x2 = rect.x + rect.w + 30, y2 = rect.y + rect.h + 12;
    await page.eval('(function(){' +
      'const o={bubbles:true,cancelable:true,pointerId:1,pointerType:"mouse",isPrimary:true,button:0,buttons:1};' +
      'const f=(t,x,y)=>{window.dispatchEvent(new PointerEvent(t,Object.assign({},o,{clientX:x,clientY:y})));};' +
      'f("pointerdown",' + x1 + ',' + y1 + ');f("pointermove",' + (x1 + 8) + ',' + (y1 + 6) + ');f("pointermove",' + x2 + ',' + y2 + ');f("pointerup",' + x2 + ',' + y2 + ');' +
      '})()');
    // 等卡片出现（shadow root .card.show 且 .cq 可用）
    for (let i = 0; i < 50; i++) {
      const open = await page.eval('(function(){const h=document.getElementById("nayan-capture-host");if(!h||!h.shadowRoot)return false;const q=h.shadowRoot.querySelector(".cq");return !!q;})()');
      if (open) return true;
      await wait(120);
    }
    return false;
  }
  const cardSetQuote = (text) => page.eval('(function(){const q=document.getElementById("nayan-capture-host").shadowRoot.querySelector(".cq");' +
    'q.value=' + JSON.stringify(text) + ';q.dispatchEvent(new Event("input",{bubbles:true}));return q.value.length;})()');
  const cardClickSave = () => page.eval('(function(){document.getElementById("nayan-capture-host").shadowRoot.querySelector(".csave").click();return 1;})()');
  const cardState = () => page.eval('(function(){const s=document.getElementById("nayan-capture-host").shadowRoot;' +
    'const err=s.querySelector(".cerr")?s.querySelector(".cerr").textContent:"";const q=s.querySelector(".cq");' +
    'return {err:err,qlen:q?q.value.length:-1,phase:window.__NAYAN_PHASE__||"(isolated)"};})()');
  const cardClose = () => page.eval('(function(){const s=document.getElementById("nayan-capture-host").shadowRoot;const x=s.querySelector(".cx")||s.querySelector(".cclose");if(x)x.click();return 1;})()');

  // 注入真实 content script（SW 侧 chrome.scripting，权限来自测试 manifest）
  {
    const injected = await swEval('(async function(){const ts=await chrome.tabs.query({active:true,currentWindow:true});' +
      'if(!ts.length) return "no-tab";try{await chrome.scripting.executeScript({target:{tabId:ts[0].id},files:["content/box-select.js"]});return "injected";}catch(e){return "err:"+e.message;}})()');
    check('E3a', '真实 content script 经 chrome.scripting 注入', injected === 'injected', { result: injected });
    if (injected !== 'injected') die('注入失败：' + injected);
  }

  // 死端口先行：保存应可见失败、卡片保留、按钮恢复
  {
    await swSetEndpoint('http://127.0.0.1:1'); // 无服务端口
    const opened = await dragSelect('#blk1');
    check('E3b', '框选→批注卡打开（真实拖拽拾取）', opened, {});
    if (!opened) die('卡片未打开');
    await page.shot('card-open');
    // 注：DOM textarea 的 value 语义本身会把 \r\n 规范为 \n（W3C 规范行为，发生在浏览器
    // API 边界，先于任何传输/入库）——卡片链路如实保存 DOM 给出的 LF 形态；CRLF 逐字符
    // 保真由 MCP/sync 层直测覆盖（M1/S1）。此处用 \n 文本断言「所见即所存」。
    const EDIT = '用户编辑后正文\n含缩进\t与🐱emoji é\u0301组合尾随  ';
    await cardSetQuote(EDIT);
    await cardClickSave();
    await wait(700);
    const st = await cardState();
    check('E3c', '服务不可达：卡片可见失败（错误文案）+ 原文保留', st.err.includes('连不上') && st.qlen === EDIT.length, st);
    await page.shot('card-error-deadport');

    // 切换到真实服务 → 同卡重试成功；DB 恰一行
    await swSetEndpoint(SYNC_BASE);
    await cardClickSave();
    let rowE3 = null;
    for (let i = 0; i < 30 && !rowE3; i++) {
      await wait(200);
      const c = dbOpen(DB);
      rowE3 = c.prepare("SELECT id, quote, content_envelope, session_ref FROM suggestions WHERE source_tool = 'webbox' ORDER BY id DESC LIMIT 1").get();
      c.close();
    }
    const c = dbOpen(DB);
    const nWebbox = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE source_tool = 'webbox'").get().n;
    c.close();
    const env = rowE3 && JSON.parse(rowE3.content_envelope);
    const exp = env ? expectEnvelope({ request_id: env.request_id, format: 'plain', original: { kind: 'text', text: '用户编辑后正文\n含缩进\t与🐱emoji é\u0301组合尾随  ' } }, { acquisition: 'extension_dom' }) : null;
    check('E3d', '重试成功：信封入库/原文逐字符（缩进/组合字符/尾随空白）/quote=canonical/session_ref 保来源不猜会话',
      !!(rowE3 && env && /^ext-/.test(env.request_id) && env.original.text === '用户编辑后正文\n含缩进\t与🐱emoji é\u0301组合尾随  '
        && rowE3.quote === exp.quote && env.acquisition === 'extension_dom'
        && rowE3.session_ref === '框选走查页 | ' + PAGE_URL && nWebbox === 1),
      { rid: env && env.request_id, origOk: !!(env && env.original.text === '用户编辑后正文\n含缩进\t与🐱emoji é\u0301组合尾随  '), quote: rowE3 && rowE3.quote, session_ref: rowE3 && rowE3.session_ref, rows: nWebbox });
    const done = await page.eval('(function(){const s=document.getElementById("nayan-capture-host").shadowRoot;return !!s.querySelector(".cdone");})()');
    check('E3e', '保存成功态（已入箱 ✓）', done, {});
    await page.shot('card-done');
    await cardClose();
    await wait(300);
  }

  // ---------- E4: 超限场景——客户端显式拒绝、卡片保留全文、服务端零行 ----------
  {
    await swSetEndpoint(SYNC_BASE);
    const opened = await dragSelect('#blk3');
    check('E4a', '第二次框选开卡', opened, {});
    const big = '汉'.repeat(100001);
    const len = await cardSetQuote(big);
    await cardClickSave();
    await wait(500);
    const st = await cardState();
    const c = dbOpen(DB);
    const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE quote LIKE '%汉汉%'").get().n;
    const total = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
    c.close();
    check('E4b', '超限：卡上显式报错（未截断）+ 原文全量保留 + 服务端零行',
      len === 100001 && st.err.includes('超限') && st.qlen === 100001 && n === 0,
      { len: len, err: st.err, qlen: st.qlen, oversizeRows: n, totalRows: total });
    await page.shot('card-oversize-error');
    await cardClose();
  }

  // ---------- E5: 服务端拒绝也走可见失败（真实消息链路绕过卡片预检直发 413） ----------
  {
    const r = await swSendViaIsolatedWorld({ title: 'E5 服务端超限', quote: '汉'.repeat(100001), source_tool: 'web' });
    const resp = JSON.parse(r);
    const c = dbOpen(DB);
    const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = 'E5 服务端超限'").get().n;
    c.close();
    check('E5', '服务端 413 显式错误经 background 透传（非网络异常伪装）', resp && resp.ok === false && /超限/.test(resp.error) && n === 0,
      { resp: r && r.slice(0, 120), rows: n });
  }

  // ---------- 收尾对账 ----------
  {
    const c = dbOpen(DB);
    const rows = c.prepare('SELECT id, title, source_tool, quote, content_envelope FROM suggestions ORDER BY id').all();
    c.close();
    const manifest = rows.map((r0) => ({ id: r0.id, title: r0.title, tool: r0.source_tool, quoteSha: sha(r0.quote), envSha: r0.content_envelope ? sha(r0.content_envelope) : null }));
    fs.writeFileSync(path.join(OUT, 'db-manifest.json'), JSON.stringify({ db: DB, rows: manifest }, null, 2));
    log({ ev: 'db-manifest', rows: manifest.length });
    const consoleErrs = page.consoleLines.filter((l) => l.type === 'error');
    check('E6', '页面无未捕获 JS 异常', consoleErrs.length === 0, consoleErrs.slice(0, 3));
  }
} finally {
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { sync.p.kill('SIGKILL'); } catch (_) {}
  try { pageServer.close(); } catch (_) {}
  fs.writeFileSync(path.join(OUT, 'walkthrough.log'), logLines.join('\n'));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ pass: PASS, fail: FAIL }, null, 2));
  if (!KEEP) { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} }
}
console.log('extension-real-path: ' + PASS + ' 通过 / ' + FAIL + ' 失败');
process.exit(FAIL ? 1 : 0);
