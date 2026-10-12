// tests/renderer/reader-performance.test.mjs —— P1-B06-PERF-01-REPAIR-01 / R1-F03+F04 修正版
// 真实 index.html 详情路由（bindEntry → GET content → fillReaderBody → renderReaderBodyAsync
// → 完成跳挂 sidecar），四份冻结夹具各 1 首跑 + 30 warm；完成=渲染 promise 结算+sidecar+双 rAF。
// 观察器：连续 heartbeat（2ms，记录 {scheduled,fired} 原始样本，非仅漂移值）+ MessageChannel 往返。
// R1-F03：fixtures 载入即严格校验（bytes/sha256/utf16/codepoints 对照 manifest 与实际 Buffer 长度），
//   bytes 显式进入每条记录与 JSON；预算门用共享 gate.mjs（缺失/未知/NaN/未完成一律显式失败）。
// R1-F04：注入门=固定轻量夹具的正常对照（自身须有效）+ 三位置注入，捕获判定为「观察器存在真实
//   横跨注入窗口的样本」（detectInjectionAttribution），退出码 classifyInjectRun 分类
//   （3=完整成功；6=对照无效/污染；7=盲区；4=证据写失败；5=清理失败；1=异常）。
// 正常模式 exit 0/1（尊重 thrown/okClean/证据写复核）。所有时间=运行时记录，不倒填。
// 用法：node tests/renderer/reader-performance.test.mjs --out DIR [--ledger FILE] [--inject early|mid|late]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from './cdp.mjs';
import { ownRoot, bindChild, finishRun } from './tauri-asset-smoke/lifecycle.mjs';
import { evaluatePerformanceGate, detectInjectionAttribution, classifyInjectRun, validateTrial } from './reader-performance/gate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI_DIR = path.join(REPO, 'app/ui');
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out');
if (!outDir) { console.error('需要 --out DIR'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const profileTrials = argOf('--profile') ? Number(argOf('--profile')) : null;
if(profileTrials!==null&&(!Number.isInteger(profileTrials)||profileTrials<1||profileTrials>5))throw Error('--profile 1..5 only');
if(process.argv.includes('--parity')&&!profileTrials)throw Error('--parity only diagnostic, never formal timing');
const fault = argOf('--fault');
const branch = argOf('--branch') || 'auto';
if (fault && !['evidence','cleanup','blind','exception'].includes(fault)) throw new Error('Unknown test fault');
if (!['auto','mc','timeout'].includes(branch)) throw new Error('Unknown yield branch');
const injectCase = argOf('--inject') || null;
if (injectCase && !['early', 'mid', 'late'].includes(injectCase)) { console.error('--inject 须为 early|mid|late'); process.exit(2); }

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const SOURCE_HASHES = {
  'app/ui/rich-text.js': sha256File(path.join(REPO, 'app/ui/rich-text.js')),
  'app/ui/index.html': sha256File(path.join(REPO, 'app/ui/index.html')),
  'app/ui/rich-source-map.js': sha256File(path.join(REPO, 'app/ui/rich-source-map.js')),
  'tests/renderer/reader-performance.test.mjs': sha256File(path.join(REPO, 'tests/renderer/reader-performance.test.mjs')),
  'tests/renderer/reader-performance/gate.mjs': sha256File(path.join(REPO, 'tests/renderer/reader-performance/gate.mjs')),
};

/* ---------- 冻结夹具：载入即严格校验（R1-F03） ---------- */
const FIX_DIR = path.join(REPO, 'docs/implementation-plan-2026-09-23/batches/P1-B06-PERF-01/evidence');
const man = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'fixtures-manifest.json'), 'utf8'));
const fixtures = [];
const fixtureValidation = [];
for (let i = 0; i < man.fixtures.length; i++) {
  const m = man.fixtures[i];
  const raw = fs.readFileSync(path.join(FIX_DIR, `fixture-${i}-${m.label}.txt`));
  const text = raw.toString('utf8');
  const checks = {
    sha256: crypto.createHash('sha256').update(raw).digest('hex') === m.sha256,
    manifest_utf8_bytes: m.utf8_bytes,
    bufferLength: raw.length,
    bufferMatchesManifest: raw.length === m.utf8_bytes,
    utf16: text.length === m.utf16_units,
    codepoints: [...text].length === m.codepoints,
    blocks: m.blocks_declared,
  };
  const valid = checks.sha256 && checks.bufferMatchesManifest && checks.utf16 && checks.codepoints
    && Number.isInteger(checks.manifest_utf8_bytes) && (checks.manifest_utf8_bytes === 102400 || checks.manifest_utf8_bytes === 1048576);
  fixtureValidation.push({ label: m.label, ...checks, valid });
  if (!valid) { console.error('夹具校验失败，拒绝测量:', JSON.stringify(checks)); process.exit(1); }
  fixtures.push({ label: m.label, bytes: m.utf8_bytes, blocks: m.blocks_declared, text });
}

function envFor(text, req) {
  return { schema_version: 1, request_id: req, format: 'markdown', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text }, fidelity: { truncated: false }, canonical: text, canonical_unavailable_reason: null, plain_projection: { status: 'available', text: '' } };
}
const mkItem = (id, title, quote) => ({ id, title, quote: quote || '', user_msg: '', my_note: '', status: 'inbox', created_at: '2026-10-01T00:00:00Z', source_tool: 'chat', session_ref: 's1', window_id: 1, steps: [] });
// 注入门专用固定轻量夹具（形成有效正常对照；不替代四份性能输入）：400 blocks → 多批多 yield、总时长短
const INJECT_FIX_TEXT = (() => {
  const parts = ['# inject-fixture\n\n'];
  for (let i = 1; i <= 400; i++) parts.push(`## 节 ${i}\n\n段落 中文 English e\u0301，${i} 号。\n\n\`\`\`ts\nconst v${i} = ${i};\n  indent\n\`\`\`\n\n> 引用 ${i}\n\n- 列表 ${i}\n- 另一项 ${i}\n\n`);
  return parts.join('');
})();
const INJECT_AT = { early: 1, mid: 2, late: -1 };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!url.startsWith('/api/')) {
    const file = path.normalize(path.join(UI_DIR, url === '/' ? '/index.html' : url));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' }); res.end(fs.readFileSync(file));
    return;
  }
  const m = /^\/api\/suggestions\/(\d+)\/content$/.exec(url);
  if (m && req.method === 'GET') {
    const r = server.registry.get(Number(m[1]));
    if (!r) return send(404, { error: 'not found' });
    return send(200, { content: r.content.content, quote: r.content.quote });
  }
  if (url === '/api/suggestions' && req.method === 'GET') return send(200, [...server.registry.values()].map((r) => r.item));
  if (url === '/api/session-aliases') return send(200, []);
  return send(200, {});
});
server.registry = new Map();
await new Promise((res) => server.listen(0, '127.0.0.1', res));

const chromeProc = await startChrome();
const ownedProfile = ownRoot(chromeProc.profile); bindChild(ownedProfile, chromeProc.child);
let cdp; let thrown = null;
const t0 = new Date().toISOString();
let perfData = null; let injectData = null;
let evidenceWritten = null; let evidenceError = null;
let cleanupOk = null;

/* 页面装置：观察 wrapper + 三分支 yield 计数/注入（scheduler/MC/setTimeout 全覆盖）+ 双观察器 */
const INSTALL = `(() => {
  const ObserverMC = window.MessageChannel;
  if(window.__performanceBranch==='mc'||window.__performanceBranch==='timeout') Object.defineProperty(window,'scheduler',{value:undefined,configurable:true});
  if(window.__performanceBranch==='timeout') window.MessageChannel=undefined;
  window.__perfEvents=[];
  const event=(type,via)=>window.__perfEvents.push({seq:window.__perfEvents.length,type,via,at:performance.now()});
  window.__capResults = []; window.__lastRender = null;
  const origRRA = window.renderReaderBodyAsync;
  window.renderReaderBodyAsync = function (el, d, o) {
    const rec = { status: null, done: false, t0: performance.now() };
    window.__capResults.push(rec); window.__lastRender = rec;
    const p = origRRA.call(window, el, d, o);
    p.then((r) => { rec.status = r.status; rec.rendered = !!r.rendered; rec.projection=r.projection; rec.done = true; rec.tDone = performance.now(); window.__renderSettled = true; event('render-settled','render'); },
           (e) => { rec.status = 'error'; rec.done = true; rec.tDone = performance.now(); window.__renderSettled = true; event('render-settled','render'); });
    return p;
  };
  const origST = window.setTimeout.bind(window);
  window.__origSetTimeout = origST;
  window.__sleep = (ms) => new Promise((r) => origST(r, ms));
  window.__yieldCount = 0; window.__yieldVia = {}; window.__inject = null; window.__renderSettled = false;
  window.__injectionWindow = null;
  const actualBranch=()=>typeof scheduler==='object'&&scheduler&&typeof scheduler.yield==='function'?'scheduler':typeof MessageChannel==='function'?'mc':'setTimeout';
  const injectNow=(phase,via)=>{
    const inject=window.__inject;
    if(!inject||!((phase==='yield'&&window.__yieldCount===inject.at)||(phase==='completion'&&inject.at===-1)))return;
    window.__inject=null;window.__injectedAt=window.__yieldCount;window.__injectedVia=via;
    event('inject-start',via);
    const start=performance.now();while(performance.now()-start<inject.ms){}
    window.__injectionWindow={start,end:performance.now(),phase};event('inject-end',via);
  };
  const originalYield=window.richTaskYield;
  window.richTaskYield=function(task){
    const via=actualBranch();event('yield-call',via);
    return originalYield.call(window,task).then(()=>{
      event('yield-resolved',via);window.__yieldCount++;window.__yieldVia[via]=(window.__yieldVia[via]||0)+1;
      injectNow('yield',via);event('render-resume',via);
    });
  };
  const originalMount=window.mountReaderSidecar;
  window.mountReaderSidecar=function(el,d,prepared){
    event('sidecar-start','completion');injectNow('completion','completion');
    const result=originalMount(el,d,prepared);event('sidecar-end','completion');return result;
  };
  // 双观察器：heartbeat 记录 {scheduled,fired} 原始样本（供注入归因）；MC 往返为任务队列交互代理
  window.__observer = () => {
    const st = { samples: [], msgLat: [], msgSent: 0, running: true };
    const ch = new ObserverMC();
    ch.port1.onmessage = (ev) => { st.msgLat.push(performance.now() - ev.data); };
    let scheduledAt = 0; let hbTimer = 0; let probeTimer = 0;
    const HB = 2, PROBE = 4;
    const hb = () => { if (!st.running) return; const now = performance.now(); if(!(window.__performanceFault==='blind'&&window.__injectionWindow&&scheduledAt<=window.__injectionWindow.start&&now>=window.__injectionWindow.end-4)) st.samples.push({ scheduled: scheduledAt, fired: now }); else event('observer-sample-skipped','test-fault'); scheduledAt = performance.now(); hbTimer = origST(hb, HB); };
    return {
      start() { scheduledAt = performance.now(); hbTimer = origST(hb, HB); probeTimer = origST(function probe() { if (!st.running) return; ch.port2.postMessage(performance.now()); st.msgSent++; probeTimer = origST(probe, PROBE); }, PROBE); },
      stop() { st.running = false; clearTimeout(hbTimer); clearTimeout(probeTimer); try { ch.port1.close(); ch.port2.close(); } catch (e) {} return st; },
    };
  };
  return { installed: true };
})()`;

/* Diagnostic-only wrappers on the actual detail page; never performance acceptance. */
const PROFILE_INSTALL = `(() => {
 window.__phaseRows=[];
 const record=(label,fn)=>function(...args){const start=performance.now();try{return fn.apply(this,args);}finally{window.__phaseRows.push({label,start,end:performance.now()});}};
 const seen=new WeakSet();
 const wrapMD=md=>{if(seen.has(md))return md;seen.add(md);md.parse=record('parse',md.parse);md.renderer.render=record('render-html',md.renderer.render);return md;};
 const constructor=window.markdownit;window.markdownit=function(...args){return wrapMD(constructor(...args));};
 if(window.MD_INSTANCE)wrapMD(window.MD_INSTANCE);if(window.__nayanSourceMapMD)wrapMD(window.__nayanSourceMapMD);
 window.sanitizeRichHtml=record('sanitize',window.sanitizeRichHtml);
 window.plainProjection=record('projection',window.plainProjection);
 const spans=window.NaYanSourceSpans;window.NaYanSourceSpans={...spans,build:record('mapper',spans.build),prepare:record('mapper-prepare',spans.prepare)};
 const mount=window.mountReaderSidecar;window.mountReaderSidecar=record('sidecar',mount);
 const ins=Element.prototype.insertAdjacentHTML;Element.prototype.insertAdjacentHTML=record('insert-html',ins);
 const append=Node.prototype.appendChild;Node.prototype.appendChild=function(n){return this.id==='aibody'?record('attach',append).call(this,n):append.call(this,n);};
 window.__longTasks=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.__longTasks.push({start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:false});
 return true;
})()`;

/* 单次真实详情试跑（页内）。完整完成=渲染 promise 结算+sidecar 挂载+双 rAF */
const TRIAL = `(async function (itemId, opts) {
  const el = document.getElementById('aibody');
  cancelReaderBodyRender(el);
  el.textContent = ''; el.className = 'aibody';
  el.__nayanSourceMap = null; el.__nayanSidecarCache = null; el.__nayanDecision = null;
  await window.__sleep(30);
  window.__capResults = []; window.__yieldCount = 0; window.__yieldVia = {}; window.__renderSettled = false;
  window.__injectedAt = null; window.__injectedVia = null; window.__injectionWindow = null; window.__perfEvents=[];
  if(window.__phaseRows){window.__phaseRows=[];window.__longTasks=[];}
  if (opts && opts.inject) window.__inject = Object.assign({}, opts.inject);
  const obs = window.__observer(); obs.start();
  const t0 = performance.now();
  bindEntry(findItem(itemId));                                // 真实生产链
  let rec = null;
  for (let i = 0; i < 3000 && !(rec && rec.done && el.__nayanSidecarCache); i++) { await window.__sleep(4); rec = window.__capResults[window.__capResults.length - 1] || null; }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const doneAt = performance.now();
  await window.__sleep(6);
  const st = obs.stop();
  const sc = readerSidecarOf(el);
  const phases=window.__phaseRows?window.__phaseRows.slice():undefined,longTasks=window.__longTasks?window.__longTasks.slice():undefined;
  let counts = { headings: -1, fences: -1 };
  if (opts && opts.counts && el.__nayanDecision) {
    const md = markdownit({ html: false, breaks: false, linkify: false, typographer: false });
    const toks = md.parse(el.__nayanDecision.text, {});
    counts = { headings: toks.filter((t) => t.type === 'heading_open').length, fences: toks.filter((t) => t.type === 'fence').length };
  }
  let parity;
  if(opts&&opts.parity){
    const scratch=document.createElement('div');scratch.className='aibody';
    scratch.style.cssText='position:absolute;visibility:hidden;contain:none;width:'+el.getBoundingClientRect().width+'px';
    document.body.appendChild(scratch);
    const old=renderReaderBody(scratch,el.__nayanDecision,null);
    const geometry={height:el.scrollHeight,width:el.scrollWidth},contain=el.style.contain;
    el.style.contain='none';
    const withoutContain={height:el.scrollHeight,width:el.scrollWidth};el.style.contain=contain;
    parity={html:el.innerHTML===scratch.innerHTML,projection:rec.projection===old.projection,
      codes:JSON.stringify([...el.querySelectorAll('pre')].map(x=>x.textContent))===JSON.stringify([...scratch.querySelectorAll('pre')].map(x=>x.textContent)),
      height:geometry.height===withoutContain.height,width:geometry.width===withoutContain.width,
      slices:sc.entries().filter(e=>e.available).every(e=>sc.slice(e.id,el.__nayanDecision,el.__nayanIdentity).text===el.__nayanDecision.text.slice(e.start,e.end))};
    scratch.remove();
  }
  return {
    parity, visibleMs: doneAt - t0,
    status: rec && rec.status, rendered: rec && rec.rendered,
    identityOk: !!(el.__nayanIdentity && el.__nayanDecision && sc && sc.identity().requestId === el.__nayanIdentity.requestId && sc.check(el.__nayanDecision, el.__nayanIdentity)),
    yields: window.__yieldCount, yieldVia: window.__yieldVia,
    injectedAt: window.__injectedAt, injectedVia: window.__injectedVia, injectionWindow: window.__injectionWindow,
    maxDrift: st.samples.length ? Math.max(...st.samples.map((s) => s.fired - s.scheduled)) : NaN,
    driftN: st.samples.length,
    samples: st.samples, events: window.__perfEvents, phases, longTasks,
    msgMax: st.msgLat.length ? Math.max(...st.msgLat) : 0, msgN: st.msgLat.length,
    entries: sc ? sc.entries().length : -1, domNodes: el.querySelectorAll('*').length,
    bodyTextLen: (el.textContent || '').length,
    headings: counts.headings, fences: counts.fences,
  };
})`;

try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.go(`http://127.0.0.1:${server.address().port}/index.html`);
  await cdp.eval('window.__performanceBranch='+JSON.stringify(branch)+';window.__performanceFault='+JSON.stringify(fault));
  const inst = await cdp.eval(INSTALL);
  if (!inst.installed) throw new Error('install failed');
  await cdp.eval(`(async () => { for (let i = 0; i < 400 && !(state.items && state.items.length); i++) await window.__sleep(5); return (state.items || []).length; })()`);
  fixtures.forEach((f, i) => { const id = 101 + i; server.registry.set(id, { item: mkItem(id, f.label, f.text), content: { content: envFor(f.text, 'perf-' + f.label), quote: f.text } }); });
  server.registry.set(210, { item: mkItem(210, 'inject-fixture', INJECT_FIX_TEXT), content: { content: envFor(INJECT_FIX_TEXT, 'perf-inject'), quote: INJECT_FIX_TEXT } });
  await cdp.eval(`(async () => { await load(false); return state.items.length; })()`);
  await cdp.eval(`(() => { window.aiBusy = true; return true; })()`);   // 测量窗口抑制 4s 自动刷新（产品 aiBusy 门；测试态数据隔离）
  await cdp.eval(`(async () => { state.sel = 101; renderDetail(); for (let i = 0; i < 900 && !(window.__capResults.length && window.__capResults[window.__capResults.length - 1].done && document.getElementById('aibody').__nayanSidecarCache); i++) await window.__sleep(4); return true; })()`);

  const loadavgs = { start: os.loadavg() };

  if(profileTrials) await cdp.eval(PROFILE_INSTALL);
  if(profileTrials&&argOf('--experiment')==='contain') await cdp.eval("document.getElementById('aibody').style.contain='layout style';true");
  if(profileTrials&&argOf('--experiment')==='fair') await cdp.eval("window.richTaskYield=function(task){return scheduler.postTask(()=>{}, {priority:'background'});};true");

  if (injectCase) {
    /* ---- 注入故障门：固定轻量夹具的有效正常对照 + 三位置注入（归因检测） ---- */
    const inj = JSON.stringify({ inject: { at: INJECT_AT[injectCase], ms: 150 } });
    const control = await cdp.eval(`(${TRIAL})(${210}, {})`);
    const controlReason=validateTrial(control,1201);
    const controlValid=controlReason===null&&control.maxDrift<=100;
    const injected = await cdp.eval(`(${TRIAL})(${210}, ${inj})`);
    const attribution = injected.injectionWindow
      ? detectInjectionAttribution(injected.samples, injected.injectionWindow.start, injected.injectionWindow.end)
      : { caught: false, reason: 'injection-window-not-recorded' };
    const injectedReason=validateTrial(injected,1201);
    if(fault==='exception') throw new Error('Controlled runner exception after real browser trial');
    injectData = { sourceHashes: SOURCE_HASHES, controlReason, injectedReason, injectedValid: injectedReason===null, at_utc: t0, case: injectCase, at: INJECT_AT[injectCase],
      fixtureNote: 'inject-fixture(400 blocks，固定轻量对照——只验证观察器灵敏度，不替代四份性能输入)',
      branchUsed: injected.yieldVia, control, injected, attribution,
      controlValid, controlGatePassed: controlValid, attributed: attribution.caught === true };
    loadavgs.end = os.loadavg();
    injectData.loadavg = loadavgs;
  } else {
    /* ---- 正常模式：四夹具 1 首跑 + 30 warm + 同步对照（旧失败基线，不作门） ---- */
    const perf = [];
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i], id = 101 + i;
      const trials = [];
      for (let t = 0; t < (profileTrials||31); t++) {
        const r = await cdp.eval(`(${TRIAL})(${id}, ${t === 0 ? (process.argv.includes('--parity')?'{counts:true,parity:true}':'{counts:true}') : '{}'})`);
        trials.push(r);
      }
      loadavgs['after-' + f.label] = os.loadavg();
      const first = trials[0];
      perf.push({ label: f.label, bytes: f.bytes, blocks: f.blocks,
        counts: { headings: first.headings, fences: first.fences, entries: first.entries, blocks: f.blocks },
        trials, samplesNote: '每试跑保留全部 heartbeat {scheduled,fired}；maxDrift/计数需与原始样本一致' });
      const p95a = [...trials.slice(1).map((x) => x.visibleMs)].sort((a, b) => a - b);
      console.log(`${f.label}(bytes=${f.bytes}): first=${first.visibleMs.toFixed(1)}ms | warm p95=${(profileTrials?Math.max(...trials.map(x=>x.visibleMs)):p95a[Math.ceil(30 * 0.95) - 1]).toFixed(1)}ms | maxDrift(all31)=${Math.max(...trials.map((x) => x.maxDrift)).toFixed(1)}ms | yields=${trials[profileTrials?0:5].yields} via=${JSON.stringify(trials[profileTrials?0:5].yieldVia)} entries=${first.entries}`);
    }
    const syncBase = await cdp.eval(`(async () => {
      const f = ${JSON.stringify({ text: fixtures[3].text })};
      const el = document.getElementById('aibody');
      cancelReaderBodyRender(el); el.textContent = ''; el.className = 'aibody';
      el.__nayanSourceMap = null; el.__nayanSidecarCache = null; el.__nayanDecision = null;
      await window.__sleep(30);
      const decision = { format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: f.text };
      const identity = { itemId: 1, requestId: 'sync', revision: null };
      const begin = performance.now();
      const hbScheduled = performance.now(); let hbFired = 0;
      const hbP = new Promise((resolve) => window.__origSetTimeout(() => { hbFired = performance.now(); resolve(); }, 0));
      const sc = NaYanSourceSpans.build(decision, identity);
      el.__nayanDecision = decision; el.__nayanIdentity = identity;
      renderReaderBody(el, decision, null); setReaderSidecar(el, sc);
      el.offsetHeight;
      await hbP;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { syncMs: performance.now() - begin, inputBlockMs: hbFired - hbScheduled, domNodes: el.querySelectorAll('*').length, entries: sc.entries().length };
    })()`);
    if(process.argv.includes('--parity')){
      const parityRows=perf.map(f=>({label:f.label,parity:f.trials[0].parity}));
      fs.writeFileSync(path.join(outDir,'parity-results.json'),JSON.stringify(parityRows,null,2));
      if(parityRows.some(f=>!f.parity||Object.values(f.parity).some(v=>v!==true))) throw Error('Full-fixture fidelity/geometry parity failed');
    }
    const gate = profileTrials ? {diagnosticOnly:true,checked:[],failures:[],gateFail:0} : evaluatePerformanceGate(perf);
    perfData = {
      hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, node: process.version, loadavg: loadavgs, chrome: await cdp.eval('navigator.userAgent') },
      diagnosticOnly:!!profileTrials, fixtureValidation, sourceHashes: SOURCE_HASHES,
      gate, fixtures: perf, syncBaselineDense1MiB: syncBase,
      note: '首跑≠OS 冷启动；heartbeat=事件循环代理（样本=scheduled/fired 原始对）；MC 往返=任务队列交互代理；同步对照保留旧失败基线不作门；预算门=gate.mjs 共享实现（p95/maxDrift 由完整 trials 重算）',
    };
    fs.writeFileSync(path.join(outDir, 'reader-performance.json'), JSON.stringify({ at_utc: t0, ...perfData }, null, 2));
    fs.writeFileSync(path.join(outDir, 'gate-results.json'), JSON.stringify({ ...gate, at_utc: t0, sourceHashes: SOURCE_HASHES }, null, 2));
    for (const c of gate.checked) console.log(`GATE ${c.label}: bytes=${c.bytes} p95=${Number.isFinite(c.visibleP95) ? c.visibleP95.toFixed(1) : '?'} budget=${c.budget} ${c.pass ? 'PASS' : 'FAIL'}`);
    for (const x of gate.failures) console.error('GATE-FAIL ' + x);
    if (gate.gateFail) thrown = new Error(`性能门未通过：${gate.gateFail} 项`);
  }
} catch (e) {
  thrown = e; console.error(e);
}

/* 证据写入与复核（R1-F04：写失败必须被分类，不冒充成功） */
if (injectCase) {
  try {
    const p = path.join(outDir, `inject-${injectCase}.json`);
    if(fault==='evidence') fs.mkdirSync(p); // real EISDIR on the following evidence write
    fs.writeFileSync(p, JSON.stringify(injectData || { error: 'no-data' }, null, 2));
    const back = JSON.parse(fs.readFileSync(p, 'utf8'));
    evidenceWritten = !!back && back.case === injectCase && !!back.control && !!back.injected;
    if (!evidenceWritten) evidenceError = 'roundtrip-verify-failed';
  } catch (e) { evidenceError = String((e && e.message) || e); evidenceWritten = false; }
} else if (perfData) {
  try {
    const back = JSON.parse(fs.readFileSync(path.join(outDir, 'reader-performance.json'), 'utf8'));
    evidenceWritten = !!(back && back.gate && Array.isArray(back.fixtures) && back.fixtures.length === 4 && back.fixtures.every((f) => Number.isInteger(f.bytes)));
    if (!evidenceWritten) evidenceError = 'roundtrip-verify-failed';
  } catch (e) { evidenceError = String((e && e.message) || e); evidenceWritten = false; }
}

let cleanupStatus = null;
try { if (cdp) await cdp.close(); } catch (_) {}
cleanupStatus = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown || (evidenceWritten===false ? new Error('Evidence write failed: '+evidenceError) : null),
  remove: fault==='cleanup' ? ()=>{throw new Error('Controlled cleanup IO failure after ownership validation');} : undefined,
  writeEvidence: (result) => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(result, null, 2)) });
cleanupOk = !!cleanupStatus.ok;
await new Promise((resolve) => server.close(resolve));

/* The external run-command.mjs ledger records actual child close exit/signal. */
if (injectCase) {
  const cls = classifyInjectRun({ thrown, controlValid: injectData && injectData.controlValid,
    controlGatePassed: injectData && injectData.controlGatePassed,
    injectedValid: injectData && injectData.injectedValid, attributed: injectData && injectData.attributed, evidenceWritten, cleanupOk });
  const line = { at_utc: new Date().toISOString(), case: injectCase, ...cls, evidenceError,
    controlMaxDrift: injectData && injectData.control && Number.isFinite(injectData.control.maxDrift) ? injectData.control.maxDrift : null,
    attributedSample: (injectData && injectData.attribution && injectData.attribution.sample) || null,
    branchUsed: injectData && injectData.branchUsed };
  fs.writeFileSync(path.join(outDir, `inject-${injectCase}-verdict.json`), JSON.stringify(line, null, 2));
  console.log(`inject-${injectCase}: exit=${cls.code} (${cls.reason}) controlMaxDrift=${line.controlMaxDrift !== null ? line.controlMaxDrift.toFixed(1) : '?'}ms attributed=${line.attributedSample ? line.attributedSample.drift.toFixed(1) + 'ms@[' + Math.round(line.attributedSample.scheduled) + ',' + Math.round(line.attributedSample.fired) + ']' : 'no'}`);
  process.exit(cls.code);
}
console.log(`normal: exit=${thrown || !cleanupOk || evidenceWritten === false ? 1 : 0} (thrown=${!!thrown} cleanup=${cleanupOk} evidence=${evidenceWritten}${evidenceError ? ' err=' + evidenceError : ''})`);
process.exit(thrown || !cleanupOk || evidenceWritten === false ? 1 : 0);
