// tests/renderer/source-map-dom.test.mjs —— P1-B06-FIVE-STEP-2026-10-01 / S04 DOM 级
// 真实 capture-mini.html 预览页（新 script 链：rich-source-map.js 经 <script src> 真实加载）
// + 本地 harness 页（真实 renderer + 30 次性能样本）。
// 覆盖：sidecar 接线（挂/换/清）、A→B→A 与同长度异文防串用、request_id 身份、
// legacy/html 不可用、渲染行为不变（plain 恒等复测）、100KB/1MB mapper+渲染性能。
// 用法：node tests/renderer/source-map-dom.test.mjs [--out DIR]
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
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-source-map-dom-'));
fs.mkdirSync(outDir, { recursive: true });

const productCSS = [...fs.readFileSync(path.join(UI_DIR,'index.html'),'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 400)}`);
}

// ---------- 本地服务：真实 UI 文件 + harness 页 ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (url === '/__harness') {
    const html = `<!doctype html><meta charset="utf-8"><style>${productCSS}</style><style>
      body{margin:0;padding:16px;font-family:-apple-system,'PingFang SC',sans-serif;background:#fff;}
      .stage{width:480px;}
      .aibody{white-space:pre-wrap;font-size:13px;line-height:1.7;}
      .aibody.rich{white-space:normal;}
      .aibody.rich pre{white-space:pre;}
    </style><div class="stage"><div class="aibody" id="body-el"></div></div>
    <script src="/vendor/markdown-it.umd.min.js"></script>
    <script src="/vendor/purify.min.js"></script>
    <script src="/rich-text.js"></script>
    <script src="/rich-source-map.js"></script>`;
    return send(200, 'text/html; charset=utf-8', html);
  }
  const file = path.normalize(path.join(UI_DIR, url));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'text/plain', 'not found');
  const mime = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain';
  return send(200, mime, fs.readFileSync(file));
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;

const chromeProc = await startChrome();
const ownedProfile = ownRoot(chromeProc.profile); bindChild(ownedProfile, chromeProc.child);
let cdp;
let thrown = null;
try {
  cdp = await CDP.connect(chromeProc.cdpPort);

  const MD_A = '# 标题A\n\n开头段。\n\n## 子A\n\n```js\nlet a=1;\n  indent\n```\n\n尾段A。\n';
  const MD_B = '# 标题B\n\n另一篇正文，长度刻意与 A 相同。\n\n## 子B\n\n```py\nx=2\n```\n\n尾段B。\n';
  const pad = (s, n) => s + 'x'.repeat(Math.max(0, n - s.length));
  const MD_B_SAMELEN = pad(MD_B, MD_A.length).slice(0, MD_A.length);
  const env = (text, req) => ({ schema_version: 1, request_id: req, format: 'markdown', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text }, fidelity: { truncated: false }, canonical: text, canonical_unavailable_reason: null, plain_projection: { status: 'available', text: '' } });

  // ---------- P1：真实 capture-mini.html 接线 ----------
  await cdp.go(base + '/capture-mini.html');
  const chain = await cdp.eval(`(() => ({
    map: typeof window.NaYanSourceSpans, set: typeof window.setReaderSidecar,
    of: typeof window.readerSidecarOf
  }))()`);
  check('P1-wire', '真实预览页新 script 链加载（NaYanSourceSpans/挂取接口）',
    chain.map === 'object' && chain.set === 'function' && chain.of === 'function', JSON.stringify(chain));

  const rA = await cdp.eval(`(() => {
    applyCapture({ request_id: 'req-A', text: ${JSON.stringify(MD_A)}, app: 'T', ws: '', sr: '', wid: 0, channel: 'ax', content: ${JSON.stringify(env(MD_A, 'req-A'))} });
    const b = document.getElementById('bubble');
    const sc = window.readerSidecarOf(b);
    return { renderedRich: b.classList.contains('rich'),
      hasMap: !!sc, identity: sc ? sc.identity() : null,
      entries: sc ? sc.entries().map(e => ({ id: e.id, kind: e.kind, start: e.start, end: e.end, available: e.available, level: e.level, lang: e.lang, titleText: e.titleText })) : null,
      textLen: sc ? sc.sourceLength() : -1 };
  })()`);
  check('P1-wire', 'A 注入：markdown 预览渲染 rich + sidecar 挂载（身份=真实 request_id）',
    rA.renderedRich && rA.hasMap && rA.identity.itemId === null && rA.identity.requestId === 'req-A' && rA.identity.revision === null,
    JSON.stringify(rA).slice(0, 300));
  const sliceA = await cdp.eval(`(() => {
    const sc = window.readerSidecarOf(document.getElementById('bubble'));
    const blk = sc.entries().find(e => e.kind === 'code-block' && e.available);
    const pay = sc.entries().find(e => e.kind === 'code-payload');
    return { block: sc.slice(blk.id, document.getElementById('bubble').__nayanDecision, document.getElementById('bubble').__nayanIdentity).text,
      payload: sc.slice(pay.id, document.getElementById('bubble').__nayanDecision, document.getElementById('bubble').__nayanIdentity).text,
      payloadAvail: pay.available };
  })()`);
  check('P1-wire', 'A 注入：完整源块/内文 slice 与源逐字符（服务端独立重算）',
    sliceA.block === '```js\nlet a=1;\n  indent\n```' && sliceA.payloadAvail === true && sliceA.payload === 'let a=1;\n  indent',
    JSON.stringify(sliceA));

  // A→B 切换：旧 map 对新内容不可用
  const rAB = await cdp.eval(`(() => {
    const b = document.getElementById('bubble');
    const oldSc = window.readerSidecarOf(b);
    const oldEnt = oldSc.entries().find(e => e.kind === 'code-block' && e.available);
    applyCapture({ request_id: 'req-B', text: ${JSON.stringify(MD_B)}, app: 'T', content: ${JSON.stringify(env(MD_B, 'req-B'))} });
    const newSc = window.readerSidecarOf(b);
    return { oldRejected: oldSc.slice(oldEnt.id, b.__nayanDecision, b.__nayanIdentity).ok === false,
      newIsNew: newSc !== oldSc, newReq: newSc.identity().requestId,
      matchesOld: oldSc.matches({ itemId: null, requestId: 'req-B', revision: null }, ${JSON.stringify(MD_B)}) === false };
  })()`);
  check('P2-cross', 'A→B：旧 sidecar slice 拒绝 / matches 拒绝 / 新 sidecar 就位', rAB.oldRejected && rAB.newIsNew && rAB.newReq === 'req-B' && rAB.matchesOld, JSON.stringify(rAB));

  // A→B→A：A 的 map 重新构建（非旧对象复活）
  const rABA = await cdp.eval(`(() => {
    applyCapture({ request_id: 'req-A2', text: ${JSON.stringify(MD_A)}, app: 'T', content: ${JSON.stringify(env(MD_A, 'req-A2'))} });
    const b = document.getElementById('bubble');
    const sc = window.readerSidecarOf(b);
    const blk = sc.entries().find(e => e.kind === 'code-block' && e.available);
    return { req: sc.identity().requestId, sliceOk: sc.slice(blk.id, b.__nayanDecision, b.__nayanIdentity).text === ${JSON.stringify('```js\nlet a=1;\n  indent\n```')} };
  })()`);
  check('P2-cross', 'A→B→A：新 request 身份 + 同内容切片仍精确', rABA.req === 'req-A2' && rABA.sliceOk, JSON.stringify(rABA));

  // 同长度异文：旧 map 不给同长新内容切片
  const rSameLen = await cdp.eval(`(() => {
    const b = document.getElementById('bubble');
    const oldSc = window.readerSidecarOf(b);
    const oldEnt = oldSc.entries().find(e => e.kind === 'section' && e.available);
    applyCapture({ request_id: 'req-C', text: ${JSON.stringify(MD_B_SAMELEN)}, app: 'T', content: ${JSON.stringify(env(MD_B_SAMELEN, 'req-C'))} });
    return { sameLen: ${MD_A.length} === ${MD_B_SAMELEN.length},
      oldCheckFails: oldSc.check(b.__nayanDecision, b.__nayanIdentity) === false,
      newMap: !!window.readerSidecarOf(b),
      oldSliceRejected: oldSc.slice(oldEnt.id, b.__nayanDecision, b.__nayanIdentity).ok === false };
  })()`);
  check('P2-cross', '同长度异文：旧 map check/slice 双拒绝', rSameLen.sameLen && rSameLen.oldCheckFails && rSameLen.oldSliceRejected && rSameLen.newMap, JSON.stringify(rSameLen));

  // legacy / html：不挂 map
  const htmlEnv = JSON.stringify(env('<p>h</p><strong>ok</strong>', 'req-H')).replace('"format":"markdown"', '"format":"html"');
  const rGates = await cdp.eval(`(() => {
    applyCapture({ request_id: 'req-L', text: ${JSON.stringify('# 像 MD\n\n```js\nx\n```\n')}, app: 'T' });
    const legacyEl = document.getElementById('bubble');
    const legacyMap = legacyEl.__nayanSourceMap;
    const legacyUnavailable = !legacyMap || legacyMap.__unavailable === true;
    applyCapture({ request_id: 'req-H', text: '<p>h</p><strong>ok</strong>', app: 'T', content: ${htmlEnv} });
    const b = document.getElementById('bubble');
    const hm = b.__nayanSourceMap;
    return { legacyUnavailable, htmlUnavailable: !hm || hm.__unavailable === true, htmlStrong: !!b.querySelector('strong') };
  })()`);
  check('P2-gates', 'legacy（像 MD）不挂可用 map；声明 HTML 不挂 map 且渲染不受影响', rGates.legacyUnavailable && rGates.htmlUnavailable && rGates.htmlStrong, JSON.stringify(rGates));

  // 渲染行为不变（复测一条 plain 恒等，证明接线未破坏既有输出）
  const plain = '第一行\r\n第二行\n\n中点·不拆';
  const rPlain = await cdp.eval(`(() => {
    applyCapture({ request_id: 'req-P', text: ${JSON.stringify(plain)}, app: 'T' });
    const b = document.getElementById('bubble');
    return { text: b.textContent, cls: b.className };
  })()`);
  check('P2-invariant', 'plain legacy 恒等复测（CRLF→LF、无结构猜析）', rPlain.text === '第一行\n第二行\n\n中点·不拆' && !/\brich\b/.test(rPlain.cls), JSON.stringify(rPlain));
  await cdp.screenshot(path.join(outDir, 'source-map-dom-preview.png'));

  // Same canonical, different request: exercise actual mount/get/slice, not just matches.
  const sameBody = await cdp.eval(`(() => {
    const payload={request_id:'same-A',text:${JSON.stringify(MD_A)},content:${JSON.stringify(env(MD_A,'same-A'))}};
    applyCapture(payload); const b=document.getElementById('bubble'),old=readerSidecarOf(b),e=old.entries()[0];
    applyCapture({...payload,request_id:'same-B',content:${JSON.stringify(env(MD_A,'same-B'))}});
    const current=readerSidecarOf(b);
    const sliceRejected=!old.slice(e.id,b.__nayanDecision,b.__nayanIdentity).ok;
    const mountRejected=!setReaderSidecar(b,old),getterRejected=readerSidecarOf(b)===null;
    setReaderSidecar(b,current);
    return {sliceRejected,mountRejected,getterRejected,current:readerSidecarOf(b).identity().requestId};
  })()`);
  check('R1-live-identity','same body/different request rejects mount/get/slice',sameBody.sliceRejected&&sameBody.mountRejected&&sameBody.getterRejected&&sameBody.current==='same-B',JSON.stringify(sameBody));

  // ---------- P3（P1-B06-PERF-01 适配）：真实异步详情入口 + 完成语义 + 预算不变 ----------
  // 入口= renderReaderBodyAsync（index.html fillReaderBody 本批改调的同一产品入口）；
  // 完成= 渲染 promise 结算 + sidecar 挂载（完成跳构建，同产品接线）+ 双 rAF；
  // 观察= 连续 heartbeat（2ms 递归定时器 drift），从工作开始前到完成后收尾；
  // 预算沿用：100KiB warm p95≤200ms；1MiB≤1000ms；两种 1MiB 全采样最大阻塞≤100ms；
  // 附同步路径对照（旧测法单块心跳）——保留旧失败基线，不作门。
  await cdp.go(base+'/__harness');
  await cdp.eval(`(() => { try { Object.defineProperty(window, 'scheduler', { value: undefined, configurable: true, writable: true }); } catch (e) {} return true; })()`);  // 让产品 yield 走 MC/setTimeout 路径：定时器观察器有效（scheduler 续作会饿死定时器）
  const hw={cpu:os.cpus()[0].model,cores:os.cpus().length,node:process.version,chrome:await cdp.eval('navigator.userAgent')};
  function fixture(bytes,dense){
    const parts=[];let used=0,n=0;
    while(true){
      const i=n+1, paragraph=dense?'段落 中文 English e\u0301。':('解释 中文 English e\u0301，保留段落与缩进。 '.repeat(80));
      const block='# 章节 '+i+'\n\n'+paragraph+'\n\n## 子节 '+i+'\n\n```ts\nconst v'+i+' = '+i+';\n  indent\n```\n\n> 引用\n\n- 列表\n- 另一项\n\n';
      const length=Buffer.byteLength(block);if(used+length>bytes)break;
      parts.push(block);used+=length;n++;
    }
    // Fill the final paragraph to exact byte size; never cut a code fence or Unicode codepoint.
    parts.push('x'.repeat(bytes-used));const text=parts.join('');
    return {bytes,utf16:text.length,codepoints:[...text].length,blocks:n,dense,text};
  }
  const fixtures=[fixture(100*1024,false),fixture(1024*1024,false),fixture(100*1024,true),fixture(1024*1024,true)];
  fs.writeFileSync(path.join(outDir,'performance-fixtures.json'),JSON.stringify(fixtures,null,2));
  // 冻结输入对账：生成的四份必须与 P1-B06-PERF-01 只读复制夹具逐字节相同（同一生成规则）
  const batchFixDir=path.join(REPO,'docs','implementation-plan-2026-09-23/batches/P1-B06-PERF-01/evidence');
  const manifest=JSON.parse(fs.readFileSync(path.join(batchFixDir,'fixtures-manifest.json'),'utf8'));
  let frozenMatch=true;
  manifest.fixtures.forEach((m,i)=>{
    const expect=fs.readFileSync(path.join(batchFixDir,'fixture-'+i+'-'+m.label+'.txt'),'utf8');
    if(expect!==fixtures[i].text) frozenMatch=false;
  });
  check('P3-frozen','四份生成夹具与 P1-B06-PERF-01 冻结副本逐字节相同',frozenMatch,'');

  const measure=async function(fixtures){
    const el=document.getElementById('body-el'),parser=markdownit({html:false,breaks:false,linkify:false,typographer:false}),data=[];
    for(const f of fixtures){
      const tokens=parser.parse(f.text,{}),counts={headings:tokens.filter(t=>t.type==='heading_open').length,fences:tokens.filter(t=>t.type==='fence').length};
      const samples=[];
      for(let trial=0;trial<31;trial++){
        if(typeof cancelReaderBodyRender==='function') cancelReaderBodyRender(el);
        el.textContent='';el.className='aibody';
        el.__nayanSourceMap=null;el.__nayanSidecarCache=null;el.__nayanDecision=null;
        await new Promise(r=>setTimeout(r,20));
        const decision={format:'markdown',provenance:'declared',mode:'markdown',renderable:true,text:f.text};
        const identity={itemId:1,requestId:'perf-'+trial,revision:null};
        el.__nayanDecision=decision;el.__nayanIdentity=identity;
        let sched=performance.now();const drift=[];let hbOn=true;
        (function hb(){ if(!hbOn) return; const n=performance.now(); drift.push(n-sched); sched=performance.now(); setTimeout(hb,2); })();
        const begin=performance.now();
        const res=await renderReaderBodyAsync(el,decision,null);
        await new Promise(r=>setTimeout(r,0)); // Product completion publication task.
        // Match current index.html: reuse the renderer's sealed map when its
        // full source and identity check passes. Only the fallback rebuilds.
        const preparedMapOk=!!(res.sidecar && res.sidecar.check(decision,identity));
        let sc=res.sidecar;
        if(!preparedMapOk){
          await new Promise(r=>setTimeout(r,0));
          sc=NaYanSourceSpans.build(decision,identity);
        }
        setReaderSidecar(el,sc);
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        hbOn=false;
        await new Promise(r=>setTimeout(r,4));                     // 收尾采样
        samples.push({trial,cold:trial===0,status:res.status,rendered:res.rendered,
          visibleMs:performance.now()-begin-4,
          maxDrift:Math.max(0,...drift),p95Drift:drift.slice().sort((a,b)=>a-b)[Math.ceil(drift.length*.95)-1]||0,
          driftN:drift.length,
          preparedMapOk,
          identityOk:!!(el.__nayanIdentity&&el.__nayanDecision&&sc&&sc.identity().requestId===identity.requestId&&sc.check(el.__nayanDecision,el.__nayanIdentity)),
          entries:sc.entries().length,domNodes:el.querySelectorAll('*').length,bodyTextLen:(el.textContent||'').length});
      }
      // 同步路径对照（1 次；旧测法：单 heartbeat 于同步工作前调度）——保留旧失败基线，不作门
      let syncBase=null;
      if(f.bytes===1048576){
        if(typeof cancelReaderBodyRender==='function') cancelReaderBodyRender(el);
        el.textContent='';el.className='aibody';el.__nayanSourceMap=null;el.__nayanSidecarCache=null;
        await new Promise(r=>setTimeout(r,20));
        const decision={format:'markdown',provenance:'declared',mode:'markdown',renderable:true,text:f.text};
        const identity={itemId:1,requestId:'sync',revision:null};
        const begin=performance.now();
        const hbScheduled=performance.now();let hbFired=0;
        const hbP=new Promise(resolve=>setTimeout(()=>{hbFired=performance.now();resolve();},0));
        const sc=NaYanSourceSpans.build(decision,identity);
        el.__nayanDecision=decision;el.__nayanIdentity=identity;
        renderReaderBody(el,decision,null);setReaderSidecar(el,sc);
        el.offsetHeight;
        await hbP;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        syncBase={syncMs:performance.now()-begin,inputBlockMs:hbFired-hbScheduled};
      }
      data.push({...f,text:undefined,counts,cold:samples[0],warm:samples.slice(1),syncBase});
    }
    return data;
  };
  const perf=await cdp.eval('('+measure.toString()+')('+JSON.stringify(fixtures)+')');
  fs.writeFileSync(path.join(outDir,'perf-raw-samples.json'),JSON.stringify({hardware:hw,productCSS:true,perf},null,2));
  const p95=a=>{const sorted=[...a].sort((x,y)=>x-y);return sorted[Math.ceil(sorted.length*.95)-1];};
  for(const f of perf){
    const label=(f.dense?'dense':'ordinary')+'-'+f.bytes;
    check('P3-structure',label+': exact generated headings/fences',f.blocks>0&&f.counts.headings===f.blocks*2&&f.counts.fences===f.blocks,JSON.stringify(f.counts));
    const allDone=[f.cold,...f.warm].every(t=>t.status==='rendered'&&t.rendered&&t.preparedMapOk
      &&Number.isFinite(t.visibleMs)&&Number.isFinite(t.maxDrift)
      &&Number.isInteger(t.driftN)&&t.driftN>0
      &&Number.isInteger(t.domNodes)&&t.domNodes>0
      &&Number.isInteger(t.bodyTextLen)&&t.bodyTextLen>0
      &&t.identityOk===true);
    check('P3-route',label+': 异步真实入口全部完成（rendered+身份+采样非空+正文非空）+ entries=4×blocks',
      allDone&&f.cold.entries===f.blocks*4,
      'firstStatus='+f.cold.status+' entries='+f.cold.entries+' firstIdentityOk='+f.cold.identityOk+' firstDriftN='+f.cold.driftN);
    const visible=p95(f.warm.map(t=>t.visibleMs)),maxDrift=Math.max(f.cold.maxDrift,...f.warm.map(t=>t.maxDrift));
    check('P3-perf',label+': total visible render budget',visible<=(f.bytes===102400?200:1000),'p95='+visible.toFixed(1)+'ms');
    if(f.bytes===1048576) check('P3-perf',label+': no input blocking above 100ms',maxDrift<=100,'maxDrift(all31)='+maxDrift.toFixed(1)+'ms');
    console.log(label+': first='+f.cold.visibleMs.toFixed(1)+'ms warm p95='+visible.toFixed(1)+'ms maxDrift='+maxDrift.toFixed(1)+'ms'
      +(f.syncBase?(' | 同步对照: sync='+f.syncBase.syncMs.toFixed(1)+'ms inputBlock='+f.syncBase.inputBlockMs.toFixed(1)+'ms（基线保留，不作门）'):''));
  }
} catch (e) {
  thrown = e; fail++; console.error(e);
} finally {
  try { if (cdp) await cdp.close(); } catch (_) {}
  const status = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown,
    writeEvidence: result => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(result, null, 2)) });
  if (!status.ok) fail++;
  await new Promise(resolve => server.close(resolve));
}
const data = { total: results.length, pass: results.length - fail, fail, results };
fs.writeFileSync(path.join(outDir, 'source-map-dom-results.json'), JSON.stringify(data, null, 2));
console.log(`source-map-dom: ${data.pass}/${data.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
