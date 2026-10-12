#!/usr/bin/env node
// tests/reader/scenarios.mjs —— P0-T03 可重放 reader 场景运行器
// （P0-B01-REPAIR-02 / R2-F01：精确逐条目断言 + 全量增量 trace + 错配确定性拦截 + self-test）
//
// 相对上一版的关键差异：
//   * 压力/终态断言以「最终选中条目的明确 fixture 期望附件集合」为依据——名称集合、
//     数量、DOM 附件 ID 与真实 API 返回的 DB 附件 ID 逐一相等；禁止总名称白名单与
//     空列表 every 自动通过（旧版这两点会放过 OI-1 形态错误，已被总控反例证实）。
//   * 页面 helper trace 全量增量落盘（每步/每次压力迭代 splice(0) 取尽，不再 slice(-40)），
//     每条带 run/case 包装；删除类步骤前后记录 DB suggestion_id 差量（runner 侧事件）。
//   * 新增 S14（客户端归属守卫：真实绑定 handler + DOM 错放 id → 拒发请求零删除）与
//     S15（后端原子归属校验：expected_suggestion_id 不符 → 零行删除）。
//   * --self-test：对断言函数注入必败反例（T2 显示 T4 行 / 空列表 / ID 互换 / 旧行残留），
//     证明测试能抓住目标错误后才允许正向运行。
//
// 用法：node tests/reader/scenarios.mjs --root DIR [--out DIR] [--stress N] [--self-test]

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY_EXPECTED, SUGGESTIONS, expectedAttachmentsByName } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argOf(k) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; }
const root = argOf('--root');
const stressN = Number(argOf('--stress') || 0);
const selfTest = process.argv.includes('--self-test');
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-scenarios-'));
// 开卷期相（S1–S4 的期望集合）：run1=seed（全新库）；重启轮=after-ui（T1 已含持久化运行期引用）。
// 由调用方显式声明轮次身份，不从 DB 当前状态反推。
const openPhase = argOf('--open-phase') === 'after-ui' ? 'after-ui' : 'seed';

// ---------- 断言核心（纯函数：压力与 self-test 共用） ----------
const EXPECTED_BY_TITLE = expectedAttachmentsByName('after-ui'); // Map<title, name[]>
const titleOf = (key) => SUGGESTIONS.find(s => s.key === key).title;

/// 终态判定：最终选中条目 → 期望附件名称集合（fixture 显式定义）
/// 与 DOM 行（名称+ID）及 DB 行（真实 API）三方完全一致；attList 的 data-item 必须等于 sel。
export function judgeFinalState({ sel, title, domRows, dbAtts, expectedByTitle }) {
  const exp = expectedByTitle || EXPECTED_BY_TITLE;
  const problems = [];
  if (!title) { problems.push('无标题'); return { ok: false, problems }; }
  const expNames = exp.get(title);
  if (!expNames) { problems.push('未知条目标题：' + title); return { ok: false, problems }; }
  const domNames = (domRows || []).map(r => r.name).sort();
  if (JSON.stringify(domNames) !== JSON.stringify([...expNames].sort())) {
    problems.push(`「${title.slice(0, 14)}」DOM 名称集合不符：got=[${domNames}] 预期=[${[...expNames].sort()}]`);
  }
  const dbNames = (dbAtts || []).map(a => a.name).sort();
  if (JSON.stringify(dbNames) !== JSON.stringify([...expNames].sort())) {
    problems.push(`「${title.slice(0, 14)}」DB 名称集合不符：got=[${dbNames}] 预期=[${[...expNames].sort()}]`);
  }
  const domIds = (domRows || []).map(r => String(r.attId)).sort();
  const dbIds = (dbAtts || []).map(a => String(a.id)).sort();
  if (JSON.stringify(domIds) !== JSON.stringify(dbIds)) {
    problems.push(`「${title.slice(0, 14)}」DOM 附件 ID 与 DB 不符：dom=[${domIds}] db=[${dbIds}]`);
  }
  if (sel != null && domRows && domRows.length && domRows[0].listItem != null && String(domRows[0].listItem) !== String(sel)) {
    problems.push(`DOM 行归属 item=${domRows[0].listItem} ≠ 选中 ${sel}`);
  }
  return { ok: problems.length === 0, problems };
}

// ---------- self-test：断言函数必须抓住目标错误（R2-F01 必败反例） ----------
if (selfTest) {
  const t2 = titleOf('t2');
  const cases = [
    {
      name: 'T2 显示 T4 的行（OI-1 形态）',
      input: { sel: 2, title: t2, domRows: [{ name: 't4-gone.md', attId: '5', listItem: 2 }], dbAtts: [{ id: 1, name: 't2-note.md' }] },
    },
    { name: 'T2 空列表', input: { sel: 2, title: t2, domRows: [], dbAtts: [{ id: 1, name: 't2-note.md' }] } },
    {
      name: '标题正确但附件 ID 与 DB 互换',
      input: { sel: 4, title: titleOf('t4'), domRows: [{ name: 't4-gone.md', attId: '1', listItem: 4 }], dbAtts: [{ id: 5, name: 't4-gone.md' }] },
    },
    {
      name: 'DOM 行属旧 item（容器归属残留）',
      input: { sel: 2, title: t2, domRows: [{ name: 't2-note.md', attId: '1', listItem: 4 }], dbAtts: [{ id: 1, name: 't2-note.md' }] },
    },
    {
      name: 'DB 缺行（DOM 有行但 DB 无对应）',
      input: { sel: 2, title: t2, domRows: [{ name: 't2-note.md', attId: '1', listItem: 2 }], dbAtts: [] },
    },
  ];
  let all = true;
  for (const c of cases) {
    const r = judgeFinalState(c.input);
    const ok = r.ok === false && r.problems.length > 0;
    if (!ok) all = false;
    console.log(`${ok ? 'PASS' : 'FAIL'} self-test/「${c.name}」被判定为错误：${ok ? r.problems[0] : '未抓住!'}`);
  }
  const good = judgeFinalState({ sel: 2, title: t2, domRows: [{ name: 't2-note.md', attId: '1', listItem: 2 }], dbAtts: [{ id: 1, name: 't2-note.md' }] });
  if (!good.ok) { all = false; console.log('FAIL self-test/正向形态被误判：' + good.problems.join(';')); }
  else console.log('PASS self-test/正向形态通过');
  console.log(all ? 'self-test: 断言能抓住全部目标错误' : 'self-test: 存在漏判');
  process.exit(all ? 0 : 1);
}

// ---------- 以下为真实运行路径 ----------
if (!root) { console.error('用法: scenarios.mjs --root DIR [--out DIR] [--stress N] [--self-test]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const runMeta = JSON.parse(fs.readFileSync(path.join(root, 'current-run.json'), 'utf8'));
const PORT = runMeta.port, RUN = runMeta.run, BASE = `http://127.0.0.1:${PORT}`;

const traceLines = [];
const results = [];
function log(obj) { traceLines.push(JSON.stringify(obj)); }
function assert(step, name, ok, detail) {
  results.push({ step, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${step}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) log({ ev: 'assert.fail', step, name, detail });
}
function sha256File(f) { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function dbRows(sql, ...p) {
  const db = new DatabaseSync(path.join(root, 'inbox.db'), { readOnly: true });
  try { return db.prepare(sql).all(...p); } finally { db.close(); }
}
async function apiGet(p) { return (await fetch(BASE + p)).json(); }
async function fault(plan) {
  const r = await fetch(`${BASE}/__test/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan) });
  if (!r.ok) throw new Error('fault 注入失败');
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const runtimeFile = 'runtime-add-新附件 «runtime».md';
const runtimePath = path.join(root, 'files', runtimeFile);

// ---------- CDP 客户端（零依赖：全局 WebSocket + fetch） ----------
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
        if (m.method === 'Runtime.consoleAPICalled') this.consoleLines.push({ type: m.params.type, text: (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ') });
        if (m.method === 'Runtime.exceptionThrown') this.consoleLines.push({ type: 'exception', text: m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '') });
        (this.handlers.get(m.method) || []).forEach(h => h(m.params));
      }
    };
  }
  static async connect(port) {
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find(t => t.type === 'page' && t.url !== 'about:blank') || list.find(t => t.type === 'page');
        if (page) return new CDP(page.webSocketDebuggerUrl);
      } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('无法连接 Chrome DevTools（/json/list）');
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, h) { this.handlers.set(method, (this.handlers.get(method) || []).concat([h])); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

/// 全量增量 trace 落盘（R2-F01）：取尽页面 __NAYAN_TRACE__（splice(0)），
/// 每条以 run/case 包装；finally 时统一写 trace.jsonl。
let curCase = 'setup';
async function drainTrace() {
  try {
    const news = await cdp.eval('window.__NAYAN_TRACE__ ? window.__NAYAN_TRACE__.splice(0) : []');
    for (const t of news || []) traceLines.push(JSON.stringify({ run: RUN, case: curCase, helper: t }));
  } catch (_) { /* 页面未就绪时忽略 */ }
}
function dbSnapshot(tag) {
  const rows = dbRows('SELECT id, suggestion_id, name FROM attachments ORDER BY id');
  log({ ev: 'db.snapshot', run: RUN, case: curCase, tag, rows });
  return rows;
}

// ---------- Chrome 启动 ----------
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.error('找不到 Google Chrome：' + CHROME); process.exit(2); }
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const cdpPort = await freePort();
const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-scenarios-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${chromeProfile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,860', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
const cleanupChrome = () => { try { chrome.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch (_) {} };
process.on('exit', cleanupChrome);
process.on('SIGINT', () => { cleanupChrome(); process.exit(130); });

async function shot(name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    const p = path.join(outDir, name + '.jpg');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    log({ ev: 'screenshot', file: p });
  } catch (e) { log({ ev: 'screenshot.err', err: String(e) }); }
}
async function awaitSinkAlready(label) {
  for (let i = 0; i < 20; i++) {
    try {
      const lines = fs.readFileSync(path.join(root, 'copy-sink.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const mine = lines.filter(l => l.run === RUN && l.label === label);
      if (mine.length) return mine[mine.length - 1];
    } catch (_) {}
    await wait(150);
  }
  return null;
}

// ---------- 主流程 ----------
let failures = 0;
let cdp;
try {
  cdp = await CDP.connect(cdpPort);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__NAYAN_TEST_CLIP_SINK__ = function(s){
      fetch('/__test/sink',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({label:window.__NAYAN_CASE__||'copy',text:s})});
    };
    window.__NAYAN_TRACE__ = [];` });
  const loaded = new Promise(res => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await Promise.race([loaded, wait(8000)]);
  await wait(600);

  // ---- S0 helper/接缝就绪 ----
  curCase = 'S0';
  {
    const r = await cdp.eval(`(async () => ({
      helpers: typeof attBlock === 'function' && typeof renderAtts === 'function' && typeof addAtts === 'function',
      ready: window.__NAYAN_ATTACHMENTS_READY__ === true,
      sink: typeof window.__NAYAN_TEST_CLIP_SINK__ === 'function',
      trace: Array.isArray(window.__NAYAN_TRACE__),
      tauri: !!(window.__TAURI__ && window.__TAURI__.core),
      cards: document.querySelectorAll('.card').length,
    }))()`);
    assert('S0', '三 helper 已加载 + sink/trace 接缝注入', r.helpers && r.ready && r.sink && r.trace && r.cards === 8, JSON.stringify(r));
  }

  async function openCard2(key) {
    return cdp.eval(`(async()=>{const title=${JSON.stringify(titleOf(key))};
      const card=[...document.querySelectorAll('.card')].find(c=>c.textContent.includes(title));
      if(!card) return {err:'card not found: '+title};
      card.click(); await new Promise(r=>setTimeout(r,700));
      const list=document.getElementById('attList');
      const rows=[...list.querySelectorAll('.att')].map(r=>({attId:r.getAttribute('data-att'),name:(r.querySelector('.aname')||{}).textContent,miss:r.classList.contains('miss'),listItem:list.getAttribute('data-item')}));
      return {sel:state.sel,title:(document.getElementById('dtitle')||{}).textContent,rows,bodyVisible:document.getElementById('detail').textContent.includes(${JSON.stringify(titleOf(key))})};})()`);
  }
  /// 终态三方对账（DOM × DB API × fixture 期望）；phase 显式声明（seed=开卷态，after-ui=含运行期引用）
  const EXP_SEED = expectedAttachmentsByName('seed');
  async function verifyItemState(key, phase) {
    const st = await openCard2(key);
    const dbAtts = await apiGet('/api/suggestions/' + st.sel + '/attachments');
    const j = judgeFinalState({ sel: st.sel, title: st.title, domRows: st.rows, dbAtts, expectedByTitle: phase === 'seed' ? EXP_SEED : undefined });
    log({ ev: 'state.judge', run: RUN, case: curCase, key, phase: phase || 'after-ui', judge: j, domRows: st.rows, dbAtts });
    return { st, j, dbAtts };
  }

  // ---- S1–S4：开卷态逐条目三方对账 ----
  for (const key of ['t1', 't2', 't3', 't4']) {
    curCase = 'S1-S4/' + key;
    const { st, j } = await verifyItemState(key, openPhase);
    const bodyOk = await cdp.eval(`document.getElementById('detail').textContent.length > 50`);
    assert('S1-S4', `${titleOf(key)} 三方对账（${openPhase} 期，DOM×DB×fixture）+ 正文`, j.ok && !st.err && bodyOk,
      j.ok ? '一致' : j.problems.join('；'));
  }
  await shot('s-s4-open-views');
  await drainTrace();

  // ---- S5 list 失败 → 重试 ----
  curCase = 'S5';
  {
    await fault({ path_contains: '/api/suggestions/2/attachments', action: 'fail', times: 1 });
    const r = await cdp.eval(`(async()=>{const card=[...document.querySelectorAll('.card')].find(c=>c.textContent.includes('FIXTURE T2'));card.click();
      await new Promise(r=>setTimeout(r,700));
      const err={body:document.getElementById('detail').textContent.includes('正文 T2'),
        errText:(document.querySelector('#attList .attempty')||{}).textContent,
        retry:!!document.querySelector('#attList .attempty .abtn')};
      document.querySelector('#attList .attempty .abtn').click();
      await new Promise(r=>setTimeout(r,700));
      return {err, rows:[...document.querySelectorAll('#attList .att')].map(r=>(r.querySelector('.aname')||{}).textContent)};})()`);
    assert('S5', 'list 失败局部可见可重试', r.err.body && r.err.retry && (r.err.errText || '').includes('附件读取失败') && r.rows.join() === 't2-note.md', JSON.stringify(r));
    await shot('s5-list-error-retry');
    await drainTrace();
  }
  // ---- S6 A→B 延迟竞争 ----
  curCase = 'S6';
  {
    await fault({ path_contains: '/api/suggestions/7/attachments', action: 'delay', ms: 1500, times: 1 });
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const a=q().find(c=>c.textContent.includes('FIXTURE A')),b=q().find(c=>c.textContent.includes('FIXTURE B'));
      a.click(); await new Promise(r=>setTimeout(r,150)); b.click();
      await new Promise(r=>setTimeout(r,500));
      const during={rows:[...document.querySelectorAll('#attList .att')].map(r=>(r.querySelector('.aname')||{}).textContent)};
      await new Promise(r=>setTimeout(r,1700));
      const list=document.getElementById('attList');
      const after={rows:[...list.querySelectorAll('.att')].map(r=>(r.querySelector('.aname')||{}).textContent),sel:state.sel,listItem:list.getAttribute('data-item')};
      return {during,after};})()`);
    assert('S6', 'A 迟到响应不污染 B（名称+容器归属）', r.during.rows.join() === 't8-b.md' && r.after.rows.join() === 't8-b.md' && r.after.sel === 8 && r.after.listItem === '8', JSON.stringify(r));
    await drainTrace();
  }
  // ---- S7 A→B→A ----
  curCase = 'S7';
  {
    await fault({ path_contains: '/api/suggestions/7/attachments', action: 'delay', ms: 1600, times: 1 });
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const a=q().find(c=>c.textContent.includes('FIXTURE A')),b=q().find(c=>c.textContent.includes('FIXTURE B'));
      a.click(); await new Promise(r=>setTimeout(r,150)); b.click();
      await new Promise(r=>setTimeout(r,200)); a.click();
      await new Promise(r=>setTimeout(r,2100));
      const list=document.getElementById('attList');
      return {rows:[...list.querySelectorAll('.att')].map(r=>(r.querySelector('.aname')||{}).textContent), sel:state.sel, listItem:list.getAttribute('data-item')};})()`);
    assert('S7', 'A→B→A 终态=新 A 请求（含容器归属）', r.sel === 7 && r.rows.join() === 't7-a.md' && r.listItem === '7', JSON.stringify(r));
    await drainTrace();
  }
  // ---- S8 addAtts 成功 + 失败 ----
  curCase = 'S8';
  {
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const t1=q().find(c=>c.textContent.includes('FIXTURE T1')); t1.click();
      await new Promise(r=>setTimeout(r,600));
      const okPath=${JSON.stringify(runtimePath)};
      if(![...document.querySelectorAll('#attList .att')].some(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add')))
        addAtts(findItem(1),[okPath]);
      await new Promise(r=>setTimeout(r,900));
      const afterAdd=[...document.querySelectorAll('#attList .att')].map(r=>(r.querySelector('.aname')||{}).textContent);
      addAtts(findItem(1),[okPath+'/不存在-没有这个文件.md']);
      await new Promise(r=>setTimeout(r,900));
      return {afterAdd, afterFail:{rows:[...document.querySelectorAll('#attList .att')].map(r=>(r.querySelector('.aname')||{}).textContent),
        toast:(document.getElementById('err')||{}).textContent}};})()`);
    assert('S8', 'addAtts 成功可见 + 失败有 toast 无假成功', r.afterAdd.includes(runtimeFile) && (r.afterFail.toast || '').includes('不存在') && r.afterFail.rows.every(n => n === runtimeFile), JSON.stringify(r));
    await drainTrace();
  }
  // ---- S9 真实 ✕ 移除（带归属字段的正常路径）----
  curCase = 'S9';
  {
    await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      q().find(c=>c.textContent.includes('FIXTURE T2')).click(); await new Promise(r=>setTimeout(r,700));
      const p=${JSON.stringify(runtimePath)};
      if(![...document.querySelectorAll('#attList .att')].some(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add')))
        addAtts(findItem(2),[p]); await new Promise(r=>setTimeout(r,900));})()`);
    const hashBefore = sha256File(runtimePath);
    const dbBefore = dbSnapshot('S9.before');
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const t2=q().find(c=>c.textContent.includes('FIXTURE T2')); t2.click();
      await new Promise(r=>setTimeout(r,700));
      const target=[...document.querySelectorAll('#attList .att')].find(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add'));
      if(!target) return {err:'runtime row not found'};
      const attId=target.getAttribute('data-att');
      target.querySelector('[data-act="attdel"]').click();
      await new Promise(r=>setTimeout(r,900));
      return {attId, sel:state.sel,
        after:[...document.querySelectorAll('#attList .att')].map(r=>(r.querySelector('.aname')||{}).textContent),
        bodyOk:document.getElementById('detail').textContent.includes('正文 T2')};})()`);
    const dbAfter = dbSnapshot('S9.after');
    const removed = dbBefore.length - dbAfter.length === 1 && dbAfter.every(a => String(a.id) !== String(r.attId));
    const hashAfter = sha256File(runtimePath);
    assert('S9', '真实 ✕ 移除（携归属字段）：恰好删 1 行、正文可读、源文件不动',
      !r.err && removed && r.after.join() === 't2-note.md' && r.bodyOk && hashBefore === hashAfter,
      JSON.stringify({ attId: r.attId, removed, hashUnchanged: hashBefore === hashAfter }));
    await drainTrace();
  }
  // ---- S10 DELETE 失败 ----
  curCase = 'S10';
  {
    await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      q().find(c=>c.textContent.includes('FIXTURE T2')).click(); await new Promise(r=>setTimeout(r,700));
      if(![...document.querySelectorAll('#attList .att')].some(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add')))
        addAtts(findItem(2),[${JSON.stringify(runtimePath)}]); await new Promise(r=>setTimeout(r,900));})()`);
    const hashBefore = sha256File(runtimePath);
    const attId = dbRows("SELECT id FROM attachments WHERE suggestion_id=2 AND name=?", runtimeFile)[0].id;
    const dbBefore = dbSnapshot('S10.before');
    await fault({ path_contains: `/api/attachments/${attId}`, action: 'fail', times: 1 });
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const t2=q().find(c=>c.textContent.includes('FIXTURE T2')); t2.click();
      await new Promise(r=>setTimeout(r,700));
      const row=[...document.querySelectorAll('#attList .att')].find(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add'));
      if(!row) return {err:'row not found'};
      row.querySelector('[data-act="attdel"]').click();
      await new Promise(r=>setTimeout(r,900));
      const row2=[...document.querySelectorAll('#attList .att')].find(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add'));
      return {rowStillThere:!!row2, opacityRestored:row2?row2.style.opacity==='':'n/a',
        bodyOk:document.getElementById('detail').textContent.includes('正文 T2'),
        toast:(document.getElementById('err')||{}).textContent};})()`);
    const dbAfter = dbSnapshot('S10.after');
    assert('S10', 'DELETE 失败：行仍在、透明度恢复、正文可读、DB 零变化、文件不变',
      !r.err && r.rowStillThere && r.opacityRestored === true && r.bodyOk && dbBefore.length === dbAfter.length && hashBefore === sha256File(runtimePath),
      JSON.stringify({ rowsBefore: dbBefore.length, rowsAfter: dbAfter.length }));
    await shot('s10-delete-failed-row-kept');
    await drainTrace();
    await cdp.eval(`(async()=>{const row=[...document.querySelectorAll('#attList .att')].find(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add'));
      if(row){row.querySelector('[data-act="attdel"]').click(); await new Promise(r=>setTimeout(r,800));}})()`);
  }
  // ---- S11 迟到 DELETE 错误（归属 A）----
  curCase = 'S11';
  {
    await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      q().find(c=>c.textContent.includes('FIXTURE A')).click(); await new Promise(r=>setTimeout(r,700));
      if(![...document.querySelectorAll('#attList .att')].some(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add')))
        addAtts(findItem(7),[${JSON.stringify(runtimePath)}]); await new Promise(r=>setTimeout(r,900));})()`);
    const attId = dbRows("SELECT id FROM attachments WHERE suggestion_id=7 AND name=?", runtimeFile)[0].id;
    await fault({ path_contains: `/api/attachments/${attId}`, action: 'fail_late', ms: 900, times: 1 });
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const a=q().find(c=>c.textContent.includes('FIXTURE A')),b=q().find(c=>c.textContent.includes('FIXTURE B'));
      a.click(); await new Promise(r=>setTimeout(r,700));
      const row=[...document.querySelectorAll('#attList .att')].find(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add'));
      if(!row) return {err:'row not found on A'};
      row.querySelector('[data-act="attdel"]').click();
      b.click();
      await new Promise(r=>setTimeout(r,500));
      const during={rows:[...document.querySelectorAll('#attList .att')].map(r=>(r.querySelector('.aname')||{}).textContent)};
      await new Promise(r=>setTimeout(r,1200));
      return {during, after:{rows:[...document.querySelectorAll('#attList .att')].map(r=>(r.querySelector('.aname')||{}).textContent),
        toast:(document.getElementById('err')||{}).textContent}};})()`);
    const rowStillInDb = dbRows('SELECT COUNT(*) c FROM attachments WHERE id=?', attId)[0].c === 1;
    const toastAttributed = (r.after.toast || '').includes('FIXTURE A') && (r.after.toast || '').includes('移除附件失败');
    assert('S11', '迟到 DELETE 错误：归属 A 显示、B 行不受污染、行仍在库',
      !r.err && r.after.rows.join() === 't8-b.md' && toastAttributed && rowStillInDb,
      JSON.stringify({ toast: (r.after.toast || '').slice(0, 60), rowStillInDb }));
    await shot('s11-late-delete-error-attributed');
    await drainTrace();
    await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      q().find(c=>c.textContent.includes('FIXTURE A')).click(); await new Promise(r=>setTimeout(r,700));
      const row=[...document.querySelectorAll('#attList .att')].find(r=>((r.querySelector('.aname')||{}).textContent||'').includes('runtime-add'));
      if(row){row.querySelector('[data-act="attdel"]').click(); await new Promise(r=>setTimeout(r,800));}})()`);
  }
  // ---- S12 复制 ×3（真实按钮 + await sink + 逐字符比对）----
  curCase = 'S12';
  {
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const done=[];
      for(const [label,match] of [['t1','FIXTURE T1'],['t5','FIXTURE T5'],['t6','FIXTURE T6']]){
        q().find(c=>c.textContent.includes(match)).click(); await new Promise(r=>setTimeout(r,600));
        window.__NAYAN_CASE__=label;
        document.querySelector('[data-act="copyquote"]').click();
        await new Promise(r=>setTimeout(r,350));
        done.push(label);
      }
      window.__NAYAN_CASE__='';
      return done;})()`);
    const dbq = (key) => dbRows('SELECT quote FROM suggestions WHERE title=?', titleOf(key))[0].quote;
    const det = []; let ok = true;
    for (const c of COPY_EXPECTED) {
      const rec = await awaitSinkAlready(c.label);
      const eqF = rec && rec.text === c.quote;
      const eqD = rec && rec.text === dbq(c.label);
      if (!eqF || !eqD) ok = false;
      det.push(`${c.label}:${eqF && eqD ? '相等(len=' + rec.text.length + ')' : '不符'}`);
      log({ ev: 'copy.compare', run: RUN, case: curCase, label: c.label, eqFixture: !!eqF, eqDb: !!eqD, len: rec ? rec.text.length : 0 });
    }
    assert('S12', '真实 ⧉ 复制 ×3 = 存储 quote（逐字符）', ok && r.length === 3, det.join('；'));
    await drainTrace();
  }
  // ---- S13 重开 T1（三方对账）----
  curCase = 'S13';
  {
    const { j } = await verifyItemState('t1');
    assert('S13', '重开 T1：三方对账（含运行期引用持久化）', j.ok, j.ok ? '一致' : j.problems.join('；'));
    await shot('s13-final-state');
    await drainTrace();
  }

  // ---- S14 客户端归属守卫（OI-1 形态确定性拦截）----
  // 机理说明：删除按钮在 renderAtts 绑定时即闭包捕获 {it, id}——事后修改 DOM 的
  // data-att 不会改变删除目标（本轮实测：属性改造只会触发一次对原 id 的合法删除）。
  // 因此「错条目删除」只能来自绑定时的归属错乱；守卫防御的前置条件是
  // state.atts（当前条目的权威附件集）与被点行不一致。此处注入该前置条件：
  // 把 state.atts 换成 T4 的集合，再点 T2 的真实绑定 ✕ → 必须拒发请求、零删除。
  curCase = 'S14';
  {
    const dbBefore = dbSnapshot('S14.before');
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const t2=q().find(c=>c.textContent.includes('FIXTURE T2')); t2.click();
      await new Promise(r=>setTimeout(r,700));
      const row=[...document.querySelectorAll('#attList .att')][0];
      if(!row) return {err:'no row'};
      const t4Atts=await (await fetch('/api/suggestions/4/attachments')).json(); // 外来集合（OI-1 前置条件）
      const saved=state.atts.slice();
      state.atts=t4Atts;
      const traceLen=window.__NAYAN_TRACE__.length;
      row.querySelector('[data-act="attdel"]').click();
      await new Promise(r=>setTimeout(r,800));
      const news=window.__NAYAN_TRACE__.slice(traceLen).map(t=>t.ev);
      state.atts=saved; // 恢复，不留状态污染
      return {news, toast:(document.getElementById('err')||{}).textContent};})()`);
    const dbAfter = dbSnapshot('S14.after');
    const noDeleteSent = !(r.news || []).includes('del.click');
    const foreignCaught = (r.news || []).includes('del.ctx-reject');
    assert('S14', 'state.atts 外来集合（混集合边界）→ 客户端守卫拒发请求、零删除、可见拒绝',
      !r.err && foreignCaught && noDeleteSent && dbBefore.length === dbAfter.length && (r.toast || '').includes('已拒绝删除'),
      JSON.stringify({ news: r.news, rowsBefore: dbBefore.length, rowsAfter: dbAfter.length, toast: (r.toast || '').slice(0, 50) }));
    await shot('s14-foreign-atts-guard');
    await drainTrace();
  }
  // ---- S15 后端原子归属校验（绕过客户端直打真实 API）----
  curCase = 'S15';
  {
    const t4att = dbRows("SELECT id FROM attachments WHERE suggestion_id=4")[0].id;
    const t2Before = dbRows('SELECT COUNT(*) c FROM attachments WHERE suggestion_id=2')[0].c;
    const t4Before = dbRows('SELECT COUNT(*) c FROM attachments WHERE suggestion_id=4')[0].c;
    const totalBefore = dbRows('SELECT COUNT(*) c FROM attachments')[0].c;
    const resp = await fetch(`${BASE}/api/attachments/${t4att}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_suggestion_id: 2 }),
    });
    const respText = await resp.text();
    const totalAfter = dbRows('SELECT COUNT(*) c FROM attachments')[0].c;
    const t4After = dbRows('SELECT COUNT(*) c FROM attachments WHERE suggestion_id=4')[0].c;
    const t2After = dbRows('SELECT COUNT(*) c FROM attachments WHERE suggestion_id=2')[0].c;
    log({ ev: 's15.backend-guard', run: RUN, case: curCase, status: resp.status, respText, totalBefore, totalAfter });
    assert('S15', '后端原子校验：expected_suggestion_id 不符 → 拒绝+零行删除（T4/T2/全库不变）',
      resp.status === 500 && respText.includes('归属不符') && totalAfter === totalBefore && t4After === t4Before && t2After === t2Before,
      `HTTP ${resp.status}：${respText.slice(0, 50)}；rows ${totalBefore}→${totalAfter}`);
    await drainTrace();
  }

  // ---- S16 完整旧状态注入（R3-F01 总控反例形态：真实旧行+旧 handler+旧集合）----
  // 真实打开 T4 保存其真实行/绑定 ✕/state.atts；切到 T2（选择/标题/容器保持 T2），
  // 把完整 T4 旧行接回容器并恢复旧集合，点原有 ✕ → 必须请求前拒绝、全库零变化。
  curCase = 'S16';
  {
    const dbBefore = dbSnapshot('S16.before');
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      // 1) 真实打开 T4，保存行与绑定回调与旧集合
      q().find(c=>c.textContent.includes('FIXTURE T4')).click();
      await new Promise(r=>setTimeout(r,700));
      const oldRow=document.querySelector('#attList .att');
      if(!oldRow) return {err:'T4 行未渲染'};
      const oldBtn=oldRow.querySelector('[data-act="attdel"]');
      const oldAtts=JSON.parse(JSON.stringify(state.atts));
      // 2) 打开 T2：sel/标题/容器都是 T2
      q().find(c=>c.textContent.includes('FIXTURE T2')).click();
      await new Promise(r=>setTimeout(r,700));
      const ctxNow={sel:state.sel,title:(document.getElementById('dtitle')||{}).textContent,cont:document.getElementById('attList').getAttribute('data-item')};
      // 3) 注入完整旧状态：旧行接回当前容器 + 旧集合恢复
      document.getElementById('attList').appendChild(oldRow);
      state.atts=oldAtts;
      const traceLen=window.__NAYAN_TRACE__.length;
      oldBtn.click(); // 原有绑定回调，未改写
      await new Promise(r=>setTimeout(r,800));
      const news=window.__NAYAN_TRACE__.slice(traceLen);
      return {ctxNow, news, toast:(document.getElementById('err')||{}).textContent};})()`);
    const dbAfter = dbSnapshot('S16.after');
    const news = r.news || [];
    const noDelete = !news.some(t => t.ev === 'del.click');
    const rejected = news.some(t => t.ev === 'del.ctx-reject');
    const dbSame = JSON.stringify(dbBefore) === JSON.stringify(dbAfter);
    const ctxOk = r.ctxNow && r.ctxNow.sel === 2 && String(r.ctxNow.cont) === '2' && (r.ctxNow.title || '').includes('FIXTURE T2');
    assert('S16', '完整旧状态（T4 行+handler+集合）在 T2 下 → 请求前拒绝、全库零变化、归属反馈',
      !r.err && ctxOk && rejected && noDelete && dbSame && (r.toast || '').includes('T4'),
      JSON.stringify({ ctxNow: r.ctxNow, news: news.map(t => t.ev + '/' + (t.reason || '')), dbSame, toast: (r.toast || '').slice(0, 60) }));
    await shot('s16-full-old-state-rejected');
    await drainTrace();
  }
  // ---- S17 同 id 旧代次（A→B→A 后用旧 A 行/handler，其余全部一致）----
  curCase = 'S17';
  {
    const dbBefore = dbSnapshot('S17.before');
    const r = await cdp.eval(`(async()=>{const q=()=>[...document.querySelectorAll('.card')];
      const a=q().find(c=>c.textContent.includes('FIXTURE A')),b=q().find(c=>c.textContent.includes('FIXTURE B'));
      a.click(); await new Promise(r=>setTimeout(r,700));           // 旧代次渲染
      const oldRow=document.querySelector('#attList .att');
      const oldBtn=oldRow.querySelector('[data-act="attdel"]');
      const oldRowHtml=oldRow.outerHTML;                            // 保存旧行节点
      const savedRow=oldRow;
      b.click(); await new Promise(r=>setTimeout(r,400));
      a.click(); await new Promise(r=>setTimeout(r,700));           // 新代次：同名同 id 全新行
      const list=document.getElementById('attList');
      const ctxNow={sel:state.sel,cont:list.getAttribute('data-item'),attsIds:state.atts.map(a=>a.id)};
      list.appendChild(savedRow);                                    // 旧行接回当前容器（其余全一致）
      const traceLen=window.__NAYAN_TRACE__.length;
      oldBtn.click();                                                // 旧代次回调
      await new Promise(r=>setTimeout(r,800));
      const news=window.__NAYAN_TRACE__.slice(traceLen);
      return {ctxNow, news, toast:(document.getElementById('err')||{}).textContent};})()`);
    const dbAfter = dbSnapshot('S17.after');
    const news = r.news || [];
    const noDelete = !news.some(t => t.ev === 'del.click');
    const rejected = news.some(t => t.ev === 'del.ctx-reject');
    const dbSame = JSON.stringify(dbBefore) === JSON.stringify(dbAfter);
    const ctxOk = r.ctxNow && r.ctxNow.sel === 7 && String(r.ctxNow.cont) === '7';
    assert('S17', '同 id 旧代次（A→B→A 旧行/handler）→ 请求代次校验拒绝、全库零变化',
      !r.err && ctxOk && rejected && noDelete && dbSame,
      JSON.stringify({ ctxNow: r.ctxNow, news: news.map(t => t.ev + '/' + (t.reason || '')), dbSame }));
    await drainTrace();
    // 清场：移除注入的旧行，重渲染当前条目
    await cdp.eval(`(async()=>{renderDetail(); await new Promise(r=>setTimeout(r,500));})()`);
  }

  // ---- STRESS：精确逐条目断言 + 全量增量 trace ----
  if (stressN > 0) {
    let violations = 0; const vdet = [];
    for (let i = 0; i < stressN; i++) {
      curCase = 'stress/' + i;
      const r = await cdp.eval(`(async()=>{
        const q=()=>[...document.querySelectorAll('.card')];
        const keys=['FIXTURE T1','FIXTURE T2','FIXTURE T3','FIXTURE T4','FIXTURE A','FIXTURE B'];
        const seq=[]; const n=2+Math.floor(Math.random()*3);
        for(let k=0;k<n;k++){ const t=keys[Math.floor(Math.random()*keys.length)]; seq.push(t);
          q().find(c=>c.textContent.includes(t)).click();
          await new Promise(r=>setTimeout(r,Math.floor(Math.random()*250)));
        }
        await new Promise(r=>setTimeout(r,800));
        const list=document.getElementById('attList');
        const rows=[...list.querySelectorAll('.att')].map(r=>({attId:r.getAttribute('data-att'),name:(r.querySelector('.aname')||{}).textContent,listItem:list.getAttribute('data-item')}));
        return {seq,title:(document.getElementById('dtitle')||{}).textContent,rows,sel:state.sel};})()`);
      await drainTrace(); // 每次迭代全量增量落盘
      const dbAtts = await apiGet('/api/suggestions/' + r.sel + '/attachments');
      const j = judgeFinalState({ sel: r.sel, title: r.title, domRows: r.rows, dbAtts });
      log({ ev: 'stress.judge', run: RUN, case: curCase, seq: r.seq, judge: j });
      if (!j.ok) {
        violations++;
        vdet.push({ i, seq: r.seq, title: r.title, problems: j.problems, domRows: r.rows, dbAtts });
        await shot('stress-violation-' + i);
      }
    }
    assert('STRESS', `OI-1 压力 ×${stressN}（精确集合断言：名称×数量×ID×归属）`, violations === 0,
      violations ? JSON.stringify(vdet[0]).slice(0, 400) : '全部一致');
  }

  const errors = cdp.consoleLines.filter(l => l.type === 'error' || l.type === 'exception');
  const unexpected = errors.filter(l => !String(l.text).includes('500'));
  assert('CONSOLE', '无意外 JS 错误（500 均为注入故障）', unexpected.length === 0, JSON.stringify(unexpected.slice(0, 3)));
} catch (e) {
  assert('RUNNER', '运行器执行', false, String(e));
} finally {
  try { await drainTrace(); } catch (_) {}
  failures = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ root, run: RUN, port: PORT, at: new Date().toISOString(), results, failures }, null, 2));
  fs.writeFileSync(path.join(outDir, 'trace.jsonl'), traceLines.join('\n') + '\n');
  const helperEvents = traceLines.filter(l => l.includes('"helper"')).length;
  console.log(`\nscenarios: ${results.length - failures}/${results.length} 通过（helper trace ${helperEvents} 条全量落盘：${path.join(outDir, 'trace.jsonl')}）`);
  cleanupChrome();
  process.exit(failures ? 1 : 0);
}
