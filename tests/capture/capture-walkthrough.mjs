#!/usr/bin/env node
// tests/capture/capture-walkthrough.mjs —— P1-T03 原生收录确认窗走查 + 重启 round-trip。
//
// 证据链（全部真实组件，无 mock Rust）：
//   * 页面 = 真实 app/ui/capture-mini.html（经本脚本静态代理服务；不动冻结 test_profile.rs）；
//   * API = 真实 nayan 测试实例（tests/reader/launcher.mjs serve，真实 handle_api + 隔离库）；
//   * Tauri invoke = CDP 预注入 stub（match_project/aliases 可控延迟，POST 直透真实桥）；
//   * 故障注入 = 桥 /__test/fault（失败/延迟）；重复/超限/篡改走真实服务端守卫；
//   * 进程重启 = SIGTERM 掉 launcher 再 --root --reuse 复起，API 读回逐 hash 对账。
//
// 用法：node tests/capture/capture-walkthrough.mjs [--out DIR] [--keep]

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(REPO, 'tests/reader/launcher.mjs');
const UI_DIR = path.join(REPO, 'app/ui');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const OUT = (argv().get('--out')) || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-capture-walkthrough-'));
const KEEP = process.argv.includes('--keep');
fs.mkdirSync(OUT, { recursive: true });

function argv() {
  const m = new Map();
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--') && !['--keep'].includes(process.argv[i])) m.set(process.argv[i], process.argv[i + 1]);
  }
  return m;
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
function log(obj) { const l = typeof obj === 'string' ? obj : JSON.stringify(obj); logLines.push(l); console.log(l); }
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function die(msg) { console.error('walkthrough: ' + msg); process.exit(1); }

let PASS = 0, FAIL = 0;
function check(step, name, ok, detail) {
  if (ok) { PASS++; log(`PASS [${step}] ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
  else { FAIL++; log(`FAIL [${step}] ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// ---------- CDP 客户端（零依赖，与 tests/reader/scenarios.mjs 同法） ----------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.consoleLines = [];
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('CDP ws error')); });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.consoleAPICalled') this.consoleLines.push({ type: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
        if (m.method === 'Runtime.exceptionThrown') this.consoleLines.push({ type: 'exception', text: m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '') });
        (this.handlers.get(m.method) || []).forEach((h) => h(m.params));
      }
    };
  }
  static async connect(port) {
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page' && t.url !== 'about:blank') || list.find((t) => t.type === 'page');
        if (page) return new CDP(page.webSocketDebuggerUrl);
      } catch (_) {}
      await wait(250);
    }
    throw new Error('无法连接 Chrome DevTools');
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
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

// ---------- launcher 驱动 ----------
async function startLauncher(extra) {
  const args = [LAUNCHER, 'serve', '--keep', ...extra];
  const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const exited = new Promise((res) => child.on('exit', (c) => res(c)));
  const info = await (async () => {
    for (let i = 0; i < 120; i++) {
      const mPort = out.match(/"port":\s*(\d+)/), mRoot = out.match(/"root":\s*"([^"]+)"/), mRun = out.match(/"run":\s*"([^"]+)"/);
      if (mPort && mRoot && mRun) {
        const port = Number(mPort[1]), root = mRoot[1], run = mRun[1];
        try {
          const info = await (await fetch(`http://127.0.0.1:${port}/__test/info`)).json();
          if (info && String(info.run_id ?? info.run) === run) return { port, root, run, info };
        } catch (_) {}
      }
      if ((await Promise.race([exited.then((c) => c), wait(0).then(() => null)])) !== null) break;
      await wait(250);
    }
    die('launcher 未就绪。stdout=' + out.slice(0, 800) + ' stderr=' + err.slice(0, 400));
  })();
  return { child, exited, ...info };
}
async function stopLauncher(l) {
  if (!l || l.child.exitCode !== null) return;
  try { l.child.kill('SIGTERM'); } catch (_) {}
  await Promise.race([l.exited, wait(9000).then(() => { try { l.child.kill('SIGKILL'); } catch (_) {} })]);
}

// ---------- 静态 + API 代理（不动冻结 test_profile.rs 白名单） ----------
const openProxies = [];
async function startProxy(bridgePort) {
  const port = await freePort();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const serveFile = (name, ctype) => {
      try {
        const bytes = fs.readFileSync(path.join(UI_DIR, name));
        res.writeHead(200, { 'Content-Type': ctype });
        res.end(bytes);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    };
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/capture-mini.html')) return serveFile('capture-mini.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/rich-text.js') return serveFile('rich-text.js', 'application/javascript; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/title-rule.js') return serveFile('title-rule.js', 'application/javascript; charset=utf-8');
    // /api/* 与 /__test/* 透传真实桥（真实 handle_api 在真实进程执行）
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const proxied = await fetch(`http://127.0.0.1:${bridgePort}${req.url}`, {
      method: req.method,
      headers: body.length ? { 'Content-Type': 'application/json' } : {},
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const buf = Buffer.from(await proxied.arrayBuffer());
    res.writeHead(proxied.status, { 'Content-Type': proxied.headers.get('content-type') || 'application/json' });
    res.end(buf);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  openProxies.push({ port, server });
  return { port, server };
}

// ---------- TAPI stub（预注入） ----------
const STUB_SRC = `
(function(){
  const LOG = window.__TAPI_LOG__ = [];
  const DEFER = window.__TAPI_DEFER__ = { aliases: [], match: [] };
  window.__TAPI_STUB__ = function(cmd, args) {
    LOG.push({ cmd, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
    if (cmd === 'capture_window_ready' || cmd === 'capture_delivered_ack' || cmd === 'js_log' || cmd === 'close_capture') return Promise.resolve(null);
    if (cmd === 'match_project') return new Promise(res => DEFER.match.push(res));
    if (cmd === 'api') {
      const m = args.method, p = args.path;
      if (m === 'GET' && p === '/api/session-aliases') return new Promise(res => DEFER.aliases.push(res));
      const opt = m === 'GET' ? { method: m } : { method: m, headers: {'Content-Type':'application/json'}, body: JSON.stringify(args.body) };
      return fetch(p, opt).then(r => r.json().then(d => r.ok ? d : Promise.reject(d.error || ('HTTP ' + r.status))));
    }
    return Promise.resolve(null);
  };
  window.__TAURI__ = { core: { invoke: (c, a) => window.__TAPI_STUB__(c, a), event: { listen: () => {} } } };
})();
`;

// ---------- 信封构造（与 Rust serde 序列化形态逐字段一致） ----------
function envelope(reqId, text, acquisition = 'ax_selection') {
  const canon = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {
    schema_version: 1, request_id: reqId, format: 'plain', format_provenance: 'declared',
    acquisition, original: { kind: 'text', text }, fidelity: { truncated: false },
    canonical: canon, canonical_unavailable_reason: null,
    plain_projection: { status: 'available', text: canon },
  };
}
let PAYLOAD_GEN = 0;
function payload(reqId, text, over = {}) {
  // R2-F01：载荷携带单调世代（与 Rust CAPTURE_GEN 同义；测试内按构造顺序递增，
  // over.gen 可显式指定更低世代以注入「晚到旧稿」）。
  const gen = over.gen != null ? over.gen : ++PAYLOAD_GEN;
  return {
    request_id: reqId, gen, text,
    app: over.app ?? 'Zcode', ws: over.ws ?? '/w/b', sr: over.sr ?? '窗口：B',
    wid: over.wid ?? 5, channel: over.channel ?? 'ax',
    content: envelope(reqId, text, over.acquisition),
  };
}

// ---------- 主流程 ----------
let launcher1, chrome, proxy;
const cleanupFns = [];
async function main() {
  if (!fs.existsSync(CHROME)) die('找不到 Google Chrome');
  if (!fs.existsSync(path.join(REPO, 'app/src-tauri/target/debug/nayan'))) die('先 cargo build（测试实例二进制不存在）');

  launcher1 = await startLauncher(['--no-seed']);
  log({ ev: 'launcher.run1', root: launcher1.root, port: launcher1.port, run: launcher1.run });
  proxy = await startProxy(launcher1.port);
  log({ ev: 'proxy', port: proxy.port });

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-capture-chrome-'));
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=520,430', 'about:blank'], { stdio: 'ignore' });
  cleanupFns.push(() => { try { chrome.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} });

  const cdp = await CDP.connect(cdpPort);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SRC });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${proxy.port}/capture-mini.html` });
  await wait(700);

  const BASE = `http://127.0.0.1:${proxy.port}`;
  const api = {
    async get(p) { const r = await fetch(BASE + p); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; },
    async post(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json().catch(() => ({})); return { status: r.status, ok: r.ok, d }; },
    async fault(plan) { const r = await fetch(`${BASE}/__test/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan) }); if (!r.ok) throw new Error('fault 注入失败'); },
  };
  const sugCount = async () => (await api.get('/api/suggestions')).length;
  const posts = () => cdp.eval(`window.__TAPI_LOG__.filter(e => e.cmd==='api' && e.args && e.args.method==='POST').length`);
  const deliver = (p) => cdp.eval(`window.applyCapture(${JSON.stringify(p)}); true`);
  const acks = () => cdp.eval(`window.__TAPI_LOG__.filter(e => e.cmd==='capture_delivered_ack').map(e => e.args && e.args.requestId)`);
  const readyCount = () => cdp.eval(`window.__TAPI_LOG__.filter(e => e.cmd==='capture_window_ready').length`);
  const resolveMatch = (v) => cdp.eval(`window.__TAPI_DEFER__.match.shift()(${JSON.stringify(v)}); true`);
  const resolveAliases = (v) => cdp.eval(`window.__TAPI_DEFER__.aliases.shift()(${JSON.stringify(v)}); true`);

  // ===== S01：ready 握手（页面侧）+ 无交付时不发空确认 =====
  {
    const readyCalled = await cdp.eval(`window.__TAPI_LOG__.some(e => e.cmd === 'capture_window_ready')`);
    check('S01', '确认窗加载完成即主动握手（capture_window_ready）', readyCalled === true, { readyCalled });
    const noAck = await cdp.eval(`window.__TAPI_LOG__.filter(e => e.cmd === 'capture_delivered_ack').length`);
    check('S01', '无载荷到达时不发交付确认（applyCapture(null) 短路）', noAck === 0, { spuriousAcks: noAck });
    await cdp.shot('s01-ready-handshake');
  }

  // ===== S02：快速 A→B + 迟到 enrich 不污染 + 交付确认按收到顺序回传 =====
  {
    await deliver(payload('cap-wt-a', 'A 的正文内容\r\n带 CRLF', { sr: '窗口：A', ws: '/w/a' }));
    await deliver(payload('cap-wt-b', 'B 的正文内容\n带 LF', { sr: '窗口：B', ws: '/w/b' }));
    // R1-F01 页面契约：每次 applyCapture 收到载荷即回传该请求的交付确认（A、B 各一次、顺序一致）
    const ackOrder = await acks();
    check('S02', 'A→B 交付确认按收到顺序回传（requestId 逐个匹配）',
      JSON.stringify(ackOrder) === JSON.stringify(['cap-wt-a', 'cap-wt-b']), { ackOrder });
    // A 的迟到响应此刻才回来：match=A 的项目、aliases=A 的别名
    await resolveMatch('/proj/from-A');
    await resolveAliases([{ app: 'Zcode', session_ref: '窗口：A', window_id: 5, alias: 'A的别名' }]);
    await wait(150);
    const proj = await cdp.eval(`document.getElementById('proj').value`);
    const src = await cdp.eval(`document.getElementById('srcExtra').textContent`);
    check('S02', 'A 的迟到项目匹配不写入 B 的归属', proj === '/w/b', { proj });
    check('S02', 'A 的迟到别名不覆盖 B 的来源行', !String(src).includes('A的别名') && String(src).includes('B'), { src });
    // B 自己的 enrich 正常生效
    await resolveMatch('/proj/from-B');
    await wait(100);
    const proj2 = await cdp.eval(`document.getElementById('proj').value`);
    check('S02', 'B 自己的项目匹配正常生效', proj2 === '/proj/from-B', { proj: proj2 });
    await cdp.shot('s02-late-enrich-guard');
  }

  // ===== 取消：零 POST、零行 =====
  {
    const before = await sugCount();
    const posts0 = await posts();
    await deliver(payload('cap-wt-cancel', '会被取消的内容', { sr: '窗口：C', ws: '/w/c' }));
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); true`);
    await wait(120);
    const closed = await cdp.eval(`window.__TAPI_LOG__.filter(e => e.cmd==='close_capture').length`);
    check('CANCEL', 'Esc 取消 → close_capture 调用', closed >= 1, { closed });
    check('CANCEL', '取消零 POST、零行', (await posts()) === posts0 && (await sugCount()) === before, { before, after: await sugCount() });
  }

  // ===== 重复确认：恰一个成功项 =====
  {
    const before = await sugCount();
    const posts0 = await posts();
    await deliver(payload('cap-wt-dup', '重复提交测试正文', { sr: '窗口：D', ws: '/w/d' }));
    await resolveMatch(null); // 清空挂起的 enrich
    await cdp.eval(`window.confirmIt(); window.confirmIt(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'})); true`);
    await wait(300);
    check('DUP', '同步双击+回车 → 恰一次 POST', (await posts()) === posts0 + 1, { posts: (await posts()) - posts0 });
    check('DUP', 'DB 恰新增一行', (await sugCount()) === before + 1, { before, after: await sugCount() });
    const rows = await api.get('/api/suggestions');
    const dup = rows.filter((r) => r.quote === '重复提交测试正文');
    check('DUP', '该 request 恰一个 Item', dup.length === 1, { count: dup.length });
    // 同 request_id 再发一次（网络重放）→ 服务端幂等
    const replay = await api.post('/api/suggestions', { title: '重复提交测试正文', request_id: 'cap-wt-dup', content: envelope('cap-wt-dup', '重复提交测试正文') });
    check('DUP', '同 request_id 重放 → duplicate=true 且同行', replay.ok && replay.d.duplicate === true, { id: replay.d.id, duplicate: replay.d.duplicate });
    check('DUP', '重放后仍恰一行', (await sugCount()) === before + 1);
    await cdp.shot('s-dup-exactly-one');
  }

  // ===== 超限：页面拒绝 + 服务端权威边界 =====
  {
    const before = await sugCount();
    const posts0 = await posts();
    await deliver(payload('cap-wt-over', 'x'.repeat(100001), { sr: '窗口：E', ws: '/w/e' }));
    await wait(150);
    const errShown = await cdp.eval(`var e=document.getElementById('err'); e.style.display==='block' && e.textContent.includes('超过上限')`);
    check('OVERSIZE', '页面即时显式拒绝（显示错误，未截断）', errShown === true);
    await cdp.eval(`window.confirmIt(); true`);
    await wait(150);
    check('OVERSIZE', 'confirmIt 被拦 → 零 POST', (await posts()) === posts0);
    check('OVERSIZE', '零行', (await sugCount()) === before);
    await cdp.shot('s-oversize-rejected');
    // 服务端权威边界（经真实 handle_api）：恰上限接受 / 超一字符拒绝
    const at = await api.post('/api/suggestions', { title: '恰上限', request_id: 'cap-boundary-at', content: envelope('cap-boundary-at', 'b'.repeat(100000)) });
    const over = await api.post('/api/suggestions', { title: '超一字符', request_id: 'cap-boundary-over', content: envelope('cap-boundary-over', 'y'.repeat(100001)) });
    check('OVERSIZE', '服务端：100000 字符接受', at.ok === true, { id: at.d.id });
    check('OVERSIZE', '服务端：100001 字符显式拒绝（未截断入库）', over.ok === false && String(over.d.error).includes('超限'), { err: String(over.d.error).slice(0, 60) });
    check('OVERSIZE', '拒绝后零行残留', (await sugCount()) === before + 1);
  }

  // ===== 错误后重试：草稿保留 =====
  {
    await deliver(payload('cap-wt-retry', '重试场景正文\r\n第二行', { sr: '窗口：F', ws: '/w/f' }));
    await resolveMatch(null);
    await api.fault({ path_contains: '/api/suggestions', action: 'fail', ms: 0, times: 1 });
    await cdp.eval(`window.confirmIt(); true`);
    await wait(250);
    const errShown = await cdp.eval(`var e=document.getElementById('err'); e.style.display==='block' && e.textContent.includes('入箱失败')`);
    const btnEnabled = await cdp.eval(`!document.getElementById('okBtn').disabled`);
    const draftKept = await cdp.eval(`document.getElementById('bubble').textContent.includes('重试场景正文')`);
    check('RETRY', '失败可见（错误条显示）', errShown === true);
    check('RETRY', '按钮恢复可按（可重试）', btnEnabled === true);
    check('RETRY', '草稿保留在窗口（正文未丢）', draftKept === true);
    await cdp.shot('s-retry-draft-kept');
    await cdp.eval(`window.confirmIt(); true`);
    await wait(300);
    const rows = await api.get('/api/suggestions');
    const hit = rows.find((r) => r.quote === '重试场景正文\n第二行');
    check('RETRY', '重试成功入库（quote=canonical）', !!hit, { id: hit?.id });
    const closed = await cdp.eval(`window.__TAPI_LOG__.filter(e => e.cmd==='close_capture').length`);
    check('RETRY', '成功后收起窗口', closed >= 2, { closed });
  }

  // ===== 竞态：A 保存途中 B 到达 =====
  {
    const before = await sugCount();
    await deliver(payload('cap-wt-race-a', 'A 保存中的正文', { sr: '窗口：G', ws: '/w/g' }));
    await resolveMatch(null);
    await api.fault({ path_contains: '/api/suggestions', action: 'delay', ms: 700, times: 1 });
    await cdp.eval(`window.confirmIt(); true`); // A 的 POST 延迟 700ms
    await wait(120);
    await deliver(payload('cap-wt-race-b', 'B 抢占后的正文', { sr: '窗口：H', ws: '/w/h' }));
    await wait(900); // A 的 POST 完成
    const closedCount = await cdp.eval(`window.__TAPI_LOG__.filter(e => e.cmd==='close_capture').length`);
    const errHidden = await cdp.eval(`document.getElementById('err').style.display==='none'`);
    const bubbleB = await cdp.eval(`document.getElementById('bubble').textContent.includes('B 抢占后的正文')`);
    const rowsA = (await api.get('/api/suggestions')).filter((r) => r.quote === 'A 保存中的正文');
    check('RACE', 'A 已入库（保存属实）', rowsA.length === 1, { count: rowsA.length });
    check('RACE', '窗口未被 A 的成功回调收起（仍显示 B）', bubbleB === true);
    check('RACE', 'A 的回调不写错误/不污染 B', errHidden === true);
    // B 正常确认
    await resolveMatch(null);
    await cdp.eval(`window.confirmIt(); true`);
    await wait(300);
    const rowsB = (await api.get('/api/suggestions')).filter((r) => r.quote === 'B 抢占后的正文');
    check('RACE', 'B 随后正常入库', rowsB.length === 1);
    check('RACE', 'A/B 各一行（无重复无丢失）', (await sugCount()) === before + 2);
    await cdp.shot('s-race-b-after-a');
  }

  // ===== R1-F01：交付未确认时页面重载 → 重载完再握手 → 重交付同一稿 → 保存恰一行 =====
  {
    const before = await sugCount();
    const rid = 'cap-wt-reload';
    const body = '重载场景正文\r\n第二行';
    // 首次交付：页面收到并确认；但假设 Rust 侧确认丢失（网络/时序）——模拟确认未达
    await deliver(payload(rid, body, { sr: '窗口：RL', ws: '/w/rl' }));
    let a1 = await acks();
    check('RELOAD', '首次交付 → 页面回传交付确认', a1.includes(rid), { acks: a1 });
    await cdp.shot('s-reload-before');
    // 页面重载（Rust 侧稿本在确认前不会消失——由 cargo 状态机测试保证；此处验证
    // 重载后页面会再次握手，即 Rust 重交付的触发条件成立）
    await cdp.send('Page.reload');
    await wait(900);
    const refired = await readyCount();
    check('RELOAD', '重载后页面重新发起 ready 握手（重交付触发条件）', refired >= 1, { readyCalls: refired });
    // Rust 在握手时重交付同一稿（此处直接模拟该次 eval）
    await deliver(payload(rid, body, { sr: '窗口：RL', ws: '/w/rl' }));
    await wait(150);
    const shown = await cdp.eval(`document.getElementById('bubble').textContent.includes('重载场景正文')`);
    check('RELOAD', '重交付后正文完整显示（未丢稿）', shown === true);
    const a2 = await acks();
    const ridAcks = a2.filter((x) => x === rid).length;
    check('RELOAD', '重交付再次如实回传确认（跨页面世代共 2 次；Rust 忽略重复——单测覆盖）',
      ridAcks === 1 && a1.includes(rid), { freshAcks: a2, firstLoadAcks: a1 });
    await resolveMatch(null);
    await cdp.eval(`window.confirmIt(); true`);
    await wait(300);
    const rows = await api.get('/api/suggestions');
    const hit = rows.filter((r) => r.quote === '重载场景正文\n第二行');
    check('RELOAD', '重载+重交付后保存恰一行（无重复条目）', hit.length === 1, { count: hit.length });
    check('RELOAD', '总行数恰 +1', (await sugCount()) === before + 1, { before, after: await sugCount() });
    await cdp.shot('s-reload-recovered');
  }

  // ===== R2-F01：B 已应用并编辑后，晚到 A（低世代）不得覆盖 B / 不得重置编辑 =====
  {
    const before = await sugCount();
    // 连续世代：A 先采集（gen 小）、B 后采集（gen 大）；到达序 B 先 A 后（A 晚到）
    const gA = ++PAYLOAD_GEN, gB = ++PAYLOAD_GEN;
    await deliver(payload('cap-wt-a2', 'A 的旧正文', { sr: '窗口：A2', ws: '/w/a2', gen: gA }));
    await wait(100);
    // B（更高世代）到达并应用，替换 A
    await deliver(payload('cap-wt-b2', 'B 的新正文', { sr: '窗口：B2', ws: '/w/b2', gen: gB }));
    await wait(120);
    // 用户在 B 上做编辑
    await cdp.eval(`var n=document.getElementById('note'); n.value='B 的备注'; n.dispatchEvent(new Event('input'));
                    var p=document.getElementById('proj'); p.value='/手选B'; p.dispatchEvent(new Event('input')); true`);
    // 晚到 A（世代更低）抵达页面——Rust 准入复核后的残余调度窗口形态
    await deliver(payload('cap-wt-a2', 'A 的旧正文', { sr: '窗口：A2', ws: '/w/a2', gen: gA }));
    await wait(150);
    const bodyB = await cdp.eval(`document.getElementById('bubble').textContent.includes('B 的新正文')`);
    const reqB = await cdp.eval(`window.REQ`);
    const noteKept = await cdp.eval(`document.getElementById('note').value`);
    const projKept = await cdp.eval(`document.getElementById('proj').value`);
    const ackAcount = (await acks()).filter((x) => x === 'cap-wt-a2').length;
    check('STALE', '晚到 A 不覆盖 B 正文', bodyB === true && reqB === 'cap-wt-b2', { req: reqB });
    check('STALE', '晚到 A 不重置用户编辑（note/proj 保留）', noteKept === 'B 的备注' && projKept === '/手选B', { noteKept, projKept });
    check('STALE', '晚到重投不再为 A 发确认（首次应用恰 1 次 ack）', ackAcount === 1, { ackAcount });
    // B 仍可正常保存（恰一行，编辑随行落库）
    await resolveMatch(null);
    await cdp.eval(`window.confirmIt(); true`);
    await wait(300);
    const rows = await api.get('/api/suggestions');
    const hit = rows.filter((r) => r.quote === 'B 的新正文');
    check('STALE', 'B 保存恰一行且编辑随行（my_note/workspace）', hit.length === 1 && hit[0].my_note === 'B 的备注' && hit[0].workspace === '/手选B', { count: hit.length, note: hit[0]?.my_note, ws: hit[0]?.workspace });
    check('STALE', 'A 零行', rows.filter((r) => r.quote === 'A 的旧正文').length === 0);
    await cdp.shot('s-stale-a-rejected');
  }

  // ===== R2-F02：同稿重放（ack 丢失→watchdog 重投）只补确认，编辑/保存状态不动 =====
  {
    const before = await sugCount();
    const rid = 'cap-wt-replay';
    const p1 = payload(rid, '重放场景正文', { sr: '窗口：RP', ws: '/w/rp' });
    await deliver(p1);
    await wait(120);
    await cdp.eval(`var n=document.getElementById('note'); n.value='我的备注'; n.dispatchEvent(new Event('input'));
                    var p=document.getElementById('proj'); p.value='/手选RP'; p.dispatchEvent(new Event('input')); true`);
    const acks0 = (await acks()).length;
    // 同稿重放：同 gen 同 rid（watchdog 5s 重投的形态）
    await deliver(p1);
    await wait(150);
    const noteKept = await cdp.eval(`document.getElementById('note').value`);
    const projKept = await cdp.eval(`document.getElementById('proj').value`);
    const ue = await cdp.eval(`window.userEdited`);
    check('REPLAY', '同稿重放不清备注', noteKept === '我的备注', { noteKept });
    check('REPLAY', '同稿重放不改手选项目', projKept === '/手选RP', { projKept });
    check('REPLAY', 'userEdited 不被重置', ue === true);
    check('REPLAY', '同稿重放如实补确认（ack +1，Rust 幂等忽略）', (await acks()).length === acks0 + 1);
    // 保存恰一行，编辑随行落库
    await resolveMatch(null);
    await cdp.eval(`window.confirmIt(); true`);
    await wait(300);
    const rows = await api.get('/api/suggestions');
    const hit = rows.filter((r) => r.quote === '重放场景正文');
    check('REPLAY', '重放后保存恰一行且编辑随行', hit.length === 1 && hit[0].my_note === '我的备注' && hit[0].workspace === '/手选RP', { count: hit.length });
    check('REPLAY', '总行数恰 +1', (await sugCount()) === before + 1);
    await cdp.shot('s-replay-edit-kept');

    // 已保存后同稿重放：SAVED 不重置 → 再按 ⏎ 零新 POST
    const posts0 = await posts();
    await deliver(p1);
    await wait(150);
    const savedKept = await cdp.eval(`window.SAVED`);
    check('REPLAY', '已保存后重放不重置 SAVED', savedKept === true);
    await cdp.eval(`window.confirmIt(); true`);
    await wait(200);
    check('REPLAY', 'SAVED 守卫仍拦截重复提交（零新 POST）', (await posts()) === posts0);

    // 保存进行中重放：按钮禁用不被解除、在途 POST 恰一条
    const rid2 = 'cap-wt-replay2';
    const p2 = payload(rid2, '保存中重放正文', { sr: '窗口：RP2', ws: '/w/rp2' });
    await deliver(p2);
    await resolveMatch(null);
    await api.fault({ path_contains: '/api/suggestions', action: 'delay', ms: 600, times: 1 });
    await cdp.eval(`window.confirmIt(); true`);
    await wait(80);
    const postsDuring = await posts();
    await deliver(p2); // 保存进行中，同稿重放到达
    await wait(150);
    const btnDisabled = await cdp.eval(`document.getElementById('okBtn').disabled`);
    check('REPLAY', '保存进行中重放不解禁按钮', btnDisabled === true);
    await wait(500);
    const rows2 = (await api.get('/api/suggestions')).filter((r) => r.quote === '保存中重放正文');
    check('REPLAY', '保存中重放不产生重复 POST/行（恰一行）', rows2.length === 1 && (await posts()) === postsDuring, { count: rows2.length });
    await cdp.shot('s-replay-during-save');
  }

  // ===== 保存现场 → 进程重启 → API 读回（逐 hash 对账） =====
  const beforeRestart = [];
  {
    const rows = await api.get('/api/suggestions');
    for (const r of rows) {
      const c = await api.get(`/api/suggestions/${r.id}/content`);
      beforeRestart.push({
        id: r.id, legacy: c.legacy, quote: c.quote, envelope_json: c.envelope_json,
        original: c.content?.original?.text ?? null, canonical: c.content?.canonical ?? null,
        h: { quote: sha(c.quote), env: sha(c.envelope_json ?? ''), orig: sha(c.content?.original?.text ?? ''), canon: sha(c.content?.canonical ?? '') },
      });
    }
    log({ ev: 'prerestart.rows', n: beforeRestart.length });
    fs.writeFileSync(path.join(OUT, 'before-restart.json'), JSON.stringify(beforeRestart, null, 2));
  }

  await stopLauncher(launcher1);
  log({ ev: 'launcher.run1.stopped' });
  const launcher2 = await startLauncher(['--no-seed', '--root', launcher1.root, '--reuse']);
  log({ ev: 'launcher.run2', root: launcher2.root, port: launcher2.port, run: launcher2.run });

  {
    let allEq = true, legacyOk = true, dupAfterRestart = null;
    for (const b of beforeRestart) {
      const c = await (await fetch(`http://127.0.0.1:${launcher2.port}/api/suggestions/${b.id}/content`)).json();
      const eq = c.envelope_json === b.envelope_json && c.quote === b.quote && c.content?.original?.text === b.original && c.content?.canonical === b.canonical;
      if (!eq) { allEq = false; log({ ev: 'mismatch', id: b.id }); }
      if (b.legacy !== true && c.legacy === true) legacyOk = false;
      if (b.legacy === true && c.legacy !== true) legacyOk = false;
    }
    check('RESTART', `重启后 ${beforeRestart.length} 行 original/canonical/envelope/quote 逐字符相等`, allEq);
    check('RESTART', 'legacy/结构化标记一致', legacyOk);
    // 跨重启幂等：重放老 request_id 仍返回同一行
    const replay = await (await fetch(`http://127.0.0.1:${launcher2.port}/api/suggestions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '重复提交测试正文', request_id: 'cap-wt-dup', content: envelope('cap-wt-dup', '重复提交测试正文') }),
    })).json();
    const expectId = beforeRestart.find((b) => b.quote === '重复提交测试正文')?.id;
    dupAfterRestart = replay.duplicate === true && replay.id === expectId;
    check('RESTART', '跨进程重启的 request_id 幂等（重放→同行）', dupAfterRestart === true, { got: replay.id, expect: expectId });
    fs.writeFileSync(path.join(OUT, 'after-restart.json'), JSON.stringify({
      readback: beforeRestart.map((b) => ({ id: b.id, hashes: b.h })),
      dupAfterRestart, allEq, legacyOk,
    }, null, 2));
  }

  // ===== 重启后的重开预览（新交付正常工作） =====
  {
    const proxy2 = await startProxy(launcher2.port);
    log({ ev: 'proxy2', port: proxy2.port });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${proxy2.port}/capture-mini.html` });
    await wait(500);
    check('REOPEN', '重启后页面可再次加载并握手', await cdp.eval(`window.__TAPI_LOG__.length > 0`) === true);
    await deliver(payload('cap-wt-after-restart', '重启后的新采集正文', { sr: '窗口：R2', ws: '/w/r2' }));
    await wait(200);
    const shown = await cdp.eval(`document.getElementById('bubble').textContent.includes('重启后的新采集正文')`);
    check('REOPEN', '重启后新采集交付正常显示', shown === true);
    await resolveMatch(null);
    await cdp.eval(`window.confirmIt(); true`);
    await wait(300);
    const rows = await (await fetch(`http://127.0.0.1:${launcher2.port}/api/suggestions`)).json();
    const hit = rows.find((r) => r.quote === '重启后的新采集正文');
    check('REOPEN', '重启后新采集可保存', !!hit, { id: hit?.id });
    await cdp.shot('s-reopen-preview-save');
  }

  // 控制台无意外异常
  const exceptions = cdp.consoleLines.filter((l) => l.type === 'exception');
  check('CONSOLE', '无页面 JS 异常', exceptions.length === 0, exceptions.slice(0, 3));

  await stopLauncher(launcher2);
  if (!KEEP) {
    const code = await new Promise((res) => {
      const r = spawn('node', [LAUNCHER, 'clean', '--root', launcher1.root], { stdio: 'pipe' });
      r.on('exit', (c) => res(c));
    });
    log({ ev: 'clean', exit: code });
  } else {
    log({ ev: 'keep', root: launcher1.root });
  }
  // 正常路径同样收尾（chrome/代理不杀会让事件循环挂着不退出）
  for (const f of cleanupFns) { try { f(); } catch (_) {} }
  for (const p of openProxies) { try { p.server.close(); } catch (_) {} }
  await wait(150);
}

process.on('SIGINT', async () => { await emergency(); process.exit(130); });
async function emergency() {
  for (const f of cleanupFns) { try { f(); } catch (_) {} }
  await stopLauncher(launcher1);
}

try {
  await main();
  fs.writeFileSync(path.join(OUT, 'walkthrough.log'), logLines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ pass: PASS, fail: FAIL, out: OUT }, null, 2));
  log(`walkthrough: ${PASS} 项通过，${FAIL} 项失败`);
  process.exitCode = FAIL ? 1 : 0;
} catch (e) {
  log({ ev: 'fatal', err: String(e && e.stack || e) });
  await emergency();
  fs.writeFileSync(path.join(OUT, 'walkthrough.log'), logLines.join('\n') + '\n');
  process.exitCode = 1;
}
