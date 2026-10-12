// tests/roundtrip/routes-restart-copy.test.mjs — P1-T07 S04：真实路线保存 → 进程真实退出
// → 重启同库 → 打开详情 → 产品复制按钮 sink 对账。真实产品二进制（target/debug/nayan，
// 隔离 NAYAN_TEST_PROFILE）经 tests/reader/launcher.mjs；API=真实 handle_api；MCP=真实
// mcp-server.js（DB_PATH=同库）；复制取证=页面注入 __NAYAN_TEST_CLIP_SINK__（OS 剪贴板
// 传输=NV 另列）。负例：超限 413/拒绝零写入。extension 路线本测试不覆盖（既有
// extension-real-path 13/0 为存证引用；T07 复制腿 NV 见报告）。
// 用法: node tests/roundtrip/routes-restart-copy.test.mjs --out DIR
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from '../renderer/cdp.mjs';
import { parseArgs, preflightOut } from '../renderer/nayan-reader-view/preflight-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_DIR = path.join(REPO, 'app/ui');
const LAUNCHER = path.join(REPO, 'tests/reader/launcher.mjs');
const { '--out': outDir } = parseArgs(process.argv.slice(2), { '--out': 'value' });
preflightOut(outDir, REPO);
fs.mkdirSync(outDir, { recursive: true });

const results = []; let fail = 0;
function check(tag, name, ok, detail = '') { ok = ok === true; results.push({ tag, name, ok, detail }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${tag}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => fs.appendFileSync(path.join(outDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

// ---- 语料（独立期望；CRLF 原文 vs LF canonical） ----
const API_CRLF_TEXT = 'API 路线原文\r\n第二行含 CRLF\r\n\r\n尾段。';
const API_CRLF_CANON = API_CRLF_TEXT.replace(/\r\n?/g, '\n');
const NATIVE_TEXT = '# 原生通道形\n\n```js\nconst ok = 1;\n```\n';
const MCP_TEXT = 'MCP 路线文本\n- 甲\n- 乙\n';
const OVER_LIMIT = 'x'.repeat(100_001);
function envelope(reqId, text, acquisition, format = 'plain') {
  const canon = text.replace(/\r\n?/g, '\n');
  return { schema_version: 1, request_id: reqId, format, format_provenance: 'declared', acquisition, original: { kind: 'text', text }, fidelity: { truncated: false }, canonical: canon, canonical_unavailable_reason: null, plain_projection: { status: 'available', text: canon } };
}
function payload(reqId, text, acquisition, title) { return { request_id: reqId, title: title || ('T07 ' + reqId), gen: ++GEN, text, app: 'Zcode', ws: '/w/b', sr: '窗口：B', wid: 5, channel: acquisition === 'ax_selection' ? 'ax' : 'manual', content: envelope(reqId, text, acquisition) }; }
let GEN = 0;

// ---- launcher（真产品进程） ----
async function startLauncher(extra) {
  const child = spawn('node', [LAUNCHER, 'serve', '--keep', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const exited = new Promise((res) => child.on('exit', (c, s) => res({ code: c, signal: s })));
  for (let i = 0; i < 120; i++) {
    const mPort = out.match(/"port":\s*(\d+)/), mRoot = out.match(/"root":\s*"([^"]+)"/), mRun = out.match(/"run":\s*"([^"]+)"/);
    if (mPort && mRoot && mRun) {
      const port = Number(mPort[1]);
      try { const info = await (await fetch(`http://127.0.0.1:${port}/__test/info`)).json(); if (info && String(info.run_id ?? info.run) === mRun[1]) return { child, exited, port, root: mRoot[1], run: mRun[1] }; } catch (_) {}
    }
    if (child.exitCode !== null) break;
    await wait(250);
  }
  throw new Error('launcher 未就绪: ' + out.slice(0, 400) + ' / ' + err.slice(0, 200));
}
async function stopLauncher(l) {
  if (!l || l.child.exitCode !== null) return l ? await l.exited : null;
  try { l.child.kill('SIGTERM'); } catch (_) {}
  return await Promise.race([l.exited, wait(9000).then(() => { try { l.child.kill('SIGKILL'); } catch (_) {} return { code: 'timeout-kill', signal: 'SIGKILL' }; })]);
}
// ---- 静态+API 代理（index 页面 + vendor；/api/* 透传真桥） ----
async function startProxy(bridgePort) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const statics = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/rich-text.js': ['rich-text.js', 'application/javascript'], '/rich-source-map.js': ['rich-source-map.js', 'application/javascript'], '/vendor/markdown-it.umd.min.js': ['vendor/markdown-it.umd.min.js', 'application/javascript'], '/vendor/purify.min.js': ['vendor/purify.min.js', 'application/javascript'] };
    if (req.method === 'GET' && statics[u.pathname]) {
      try { res.writeHead(200, { 'Content-Type': statics[u.pathname][1] }); res.end(fs.readFileSync(path.join(UI_DIR, statics[u.pathname][0]))); } catch (e) { res.writeHead(500); res.end(String(e)); }
      return;
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const proxied = await fetch(`http://127.0.0.1:${bridgePort}${req.url}`, { method: req.method, headers: body.length ? { 'Content-Type': 'application/json' } : {}, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const buf = Buffer.from(await proxied.arrayBuffer());
    res.writeHead(proxied.status, { 'Content-Type': proxied.headers.get('content-type') || 'application/json' });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}
// ---- MCP（真实 mcp-server.js，DB_PATH=隔离库） ----
async function mcpAddSuggestion(dbPath, args) {
  const child = spawn('node', [path.join(REPO, 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DB_PATH: dbPath } });
  let buf = ''; const pending = new Map(); let id = 0;
  child.stdout.on('data', (d) => { buf += d.toString(); let idx; while ((idx = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, idx); buf = buf.slice(idx + 1); if (!line.trim()) continue; try { const msg = JSON.parse(line); if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch (_) {} } });
  const send = (m) => new Promise((res) => { id += 1; m.id = id; pending.set(id, res); child.stdin.write(JSON.stringify(m) + '\n'); });
  const init = await send({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't07', version: '1' } } });
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = await send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'add_suggestion', arguments: args } });
  child.kill('SIGTERM');
  return { init, call };
}

let l1 = null, l2 = null, chromeProc = null, proxy = null; let thrown = null;
try {
  if (!fs.existsSync(path.join(REPO, 'app/src-tauri/target/debug/nayan'))) throw new Error('先 cargo build（真产品测试二进制不存在）');
  // ===== Run 1：真实产品进程 =====
  l1 = await startLauncher(['--no-seed']);
  log({ ev: 'run1', root: l1.root, port: l1.port, run: l1.run });
  // ---- API 路线：CRLF 原文经真实 handle_api 保存 ----
  const r1 = await fetch(`http://127.0.0.1:${l1.port}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload('req-t07-api-crlf', API_CRLF_TEXT, 'manual')) });
  const d1 = await r1.json().catch(() => ({}));
  check('S04', 'API 路线 CRLF 行保存成功（真实 handle_api）', r1.ok && d1.id > 0, JSON.stringify({ status: r1.status, d: d1 }));
  const idApi = d1.id;
  // ---- 原生通道形（acquisition=ax_selection，与 capture 链同形） ----
  const r2 = await fetch(`http://127.0.0.1:${l1.port}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload('req-t07-native', NATIVE_TEXT, 'ax_selection')) });
  const d2 = await r2.json().catch(() => ({}));
  check('S04', '原生通道形行保存成功', r2.ok && d2.id > 0 && d2.id !== idApi, JSON.stringify(d2));
  // ---- 超限负例：零写入 ----
  const listBefore = (await (await fetch(`http://127.0.0.1:${l1.port}/api/suggestions`)).json()).length;
  const rOver = await fetch(`http://127.0.0.1:${l1.port}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload('req-t07-overlimit', OVER_LIMIT, 'manual')) });
  const listAfter = (await (await fetch(`http://127.0.0.1:${l1.port}/api/suggestions`)).json()).length;
  check('S04', '超限拒绝+零写入（100_001 字符）', !rOver.ok && listAfter === listBefore, `status=${rOver.status} before=${listBefore} after=${listAfter}`);
  // ---- MCP 路线（真实 mcp-server.js，同库） ----
  const dbPath = path.join(l1.root, 'inbox.db');
  const mcpEnv = { schema_version: 1, request_id: 'req-t07-mcp', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: MCP_TEXT }, fidelity: { truncated: false } };
  const mcp = await mcpAddSuggestion(dbPath, { title: 'MCP 路线行', text: MCP_TEXT, content: mcpEnv, request_id: 'req-t07-mcp' });
  const mcpOk = mcp.call && !mcp.call.error && mcp.call.result;
  check('S04', 'MCP 路线保存成功（真实 mcp-server.js 同库）', !!mcpOk, JSON.stringify(mcp.call).slice(0, 200));
  // ---- Run 1 真实退出 ----
  const term1 = await stopLauncher(l1);
  log({ ev: 'run1.exit', ...term1 });
  check('S04', '真产品进程真实退出（SIGTERM）', term1 && (term1.code === 0 || term1.signal === 'SIGTERM' || term1.signal === 'SIGINT' || typeof term1.code === 'number'), JSON.stringify(term1));
  // ===== Run 2：重启新进程，同库（--root --reuse） =====
  l2 = await startLauncher(['--no-seed', '--root', l1.root, '--reuse']);
  log({ ev: 'run2', root: l2.root, port: l2.port, run: l2.run });
  check('S04', '重启=新进程新 run（同库复用，root realpath 归一比较）', l2.run !== l1.run && fs.realpathSync(l2.root) === fs.realpathSync(l1.root), `${l1.run}→${l2.run} root ${l1.root}→${l2.root}`);
  const rows = await (await fetch(`http://127.0.0.1:${l2.port}/api/suggestions`)).json();
  check('S04', '重启后三行持久（API/native/MCP）', rows.length === 3, 'rows=' + rows.length);
  const rowApi = rows.find((r) => r.request_id === 'req-t07-api-crlf' || r.title.includes('API') || r.id === idApi);
  check('S04', 'API CRLF 行在', !!rowApi, JSON.stringify(rows.map((r) => [r.id, r.title])));
  const rv = await (await fetch(`http://127.0.0.1:${l2.port}/api/suggestions/${rowApi.id}/reader`)).json();
  check('S04', '/reader 读回 canonical=LF（存储 canonical 归一）', rv.canonical === API_CRLF_CANON && rv.request_id === 'req-t07-api-crlf', JSON.stringify(rv).slice(0, 300));
  const ct = await (await fetch(`http://127.0.0.1:${l2.port}/api/suggestions/${rowApi.id}/content`)).json();
  const envStored = JSON.parse(ct.envelope_json);
  check('S04', '/content 读回 original=CRLF 逐字符（原表示未动）', envStored.original.text === API_CRLF_TEXT && !envStored.original.text.includes('\r\n') === false, 'orig len=' + envStored.original.text.length);
  // ===== 重启后 UI 复制对账（真页面+产品按钮+sink） =====
  proxy = await startProxy(l2.port);
  chromeProc = await startChrome();
  let cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__NAYAN_TEST_CLIP_SINK__ = function (s) { (window.__captured = window.__captured || []).push(s); };' });
  await cdp.go(`http://127.0.0.1:${proxy.port}/index.html`);
  await cdp.eval(`window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));`);
  await cdp.eval(`(async () => { for (let i = 0; i < 600 && typeof state === 'undefined'; i++) await window.__sleep(50); for (let i = 0; i < 400 && !(state.items && state.items.length); i++) await window.__sleep(5); return 'ready'; })()`);
  const captured = async () => JSON.parse(await cdp.eval('JSON.stringify({n:(window.__captured||[]).length,arr:window.__captured||[]})'));
  const openItem = (id) => cdp.eval(`(async () => { if (!findItem(${id})) { await load(false); } state.sel = ${id}; renderDetail(); return 'ok'; })()`);
  const waitBody = () => cdp.eval(`(async () => { for (let i = 0; i < 4000; i++) { const el = document.getElementById('aibody'); if (el && el.__nayanDecision) { const d = el.__nayanDecision; if (d.renderable === false || el.__nayanSidecarCache || d.mode !== 'markdown') { await window.__sleep(30); return true; } } await window.__sleep(4); } return false; })()`);
  const clickAct = (act) => cdp.eval(`(() => { const b = document.querySelector('[data-act="${act}"]'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
  const waitSink = async (n) => { for (let i = 0; i < 240; i++) { const c = await captured(); if (c.n >= n) return c; await wait(25); } return await captured(); };

  // API CRLF 行：Copy Response=canonical(LF)、Copy Original=original(CRLF)——全链跨重启
  await openItem(rowApi.id); check('S04', '重启后打开 API 行', await waitBody());
  let cap = await captured(); const b0 = cap.n;
  await clickAct('copyquote');
  cap = await captured();
  check('S04', '重启后 Copy Response=存储 canonical（跨重启对账）', cap.n === b0 + 1 && cap.arr[cap.n - 1] === API_CRLF_CANON, (cap.arr[cap.n - 1] || '').slice(0, 40));
  await clickAct('copyorig');
  cap = await waitSink(b0 + 2);
  check('S04', '重启后 Copy Original=original CRLF 逐字符（/content 跨重启+身份/全文复核）', cap.n === b0 + 2 && cap.arr[cap.n - 1] === API_CRLF_TEXT, JSON.stringify((cap.arr[cap.n - 1] || '').slice(0, 30)));
  // MCP 行
  const rowMcp = rows.find((r) => r.title.includes('MCP'));
  await openItem(rowMcp.id); await waitBody();
  cap = await captured(); const b1 = cap.n;
  await clickAct('copyquote'); await clickAct('copyorig');
  cap = await waitSink(b1 + 2);
  check('S04', 'MCP 行 resp=canonical/orig=original（MCP→SQLite→重启→复制全链）', cap.n === b1 + 2 && cap.arr[cap.n - 2] === MCP_TEXT.replace(/\r\n?/g, '\n') && cap.arr[cap.n - 1] === MCP_TEXT, JSON.stringify(cap.arr.slice(-2).map((s) => s.slice(0, 20))));
  // 原生通道形行（markdown）
  const rowNat = rows.find((r) => r.request_id === 'req-t07-native' || (r.id !== rowApi.id && r.id !== rowMcp.id));
  await openItem(rowNat.id); await waitBody();
  cap = await captured(); const b2 = cap.n;
  await clickAct('copyquote');
  cap = await captured();
  check('S04', '原生形行 Copy Response=canonical 源码', cap.n === b2 + 1 && cap.arr[cap.n - 1] === NATIVE_TEXT.replace(/\r\n?/g, '\n'), '');
  // DB 原表示复核（脚本侧逐字节，不经 UI）
  const finalRows = await (await fetch(`http://127.0.0.1:${l2.port}/api/suggestions`)).json();
  const ctF = await (await fetch(`http://127.0.0.1:${l2.port}/api/suggestions/${rowApi.id}/content`)).json();
  check('S04', '复制后 DB 原表示零改写（original 仍 CRLF）', JSON.parse(ctF.envelope_json).original.text === API_CRLF_TEXT && finalRows.length === 3, '');
} catch (e) { thrown = String((e && e.stack) || e); console.error('THROWN', thrown); fail++; }
finally {
  try { if (chromeProc) chromeProc.child.kill(); } catch (_) {}
  try { if (proxy) proxy.server.close(); } catch (_) {}
  try { if (l1 && l1.child.exitCode === null) l1.child.kill('SIGKILL'); } catch (_) {}
  try { if (l2 && l2.child.exitCode === null) l2.child.kill('SIGKILL'); } catch (_) {}
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at_utc: new Date().toISOString(), total: results.length, fail, thrown, results }, null, 1));
console.log(`\nroutes-restart-copy: ${results.length - fail}/${results.length} PASS${thrown ? '  thrown: ' + thrown.slice(0, 200) : ''}`);
process.exit(fail ? 1 : 0);
