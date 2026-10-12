// P1-B06-NATIVE-PERF-REPAIR-01 / Step 1 — profiling-only initialization observer.
// Same real Tauri IPC/product-page flow as nayan-native-smoke/observer.js; adds
// test-side phase instrumentation around the REAL product functions (no product
// replacement): renderDetail skeleton, content IPC gap, NaYanSourceSpans.prepare,
// markdown-it parse/renderer.render, sanitizeRichHtml(DOMPurify), projection,
// actual yield waits, sidecar mount, flush arrivals (MutationObserver), rAF tail.
// All wrappers only record timings; they call through to the original functions.
// This observer is for diagnosis only; formal timing uses the untouched smoke observer.
(function(){
 'use strict';
 const mode=window.__NATIVE_MODE__,checks=[],net=[],errors=[];let phase='init';
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)throw Error(name+': '+String(detail||''));};
 const external=url=>/^https?:/i.test(String(url))&&!/^https?:\/\/(ipc\.localhost|localhost)(\/|:|$)/i.test(String(url));
 const record=(type,url)=>{if(external(url))net.push({seq:net.length,phase,type,url:String(url).slice(0,300),at:performance.now()});};
 const fetch0=window.fetch;window.fetch=function(url,...rest){record('fetch',url&&url.url||url);return fetch0.call(this,url,...rest);};
 const xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){record('xhr',url);return xo.call(this,method,url,...rest);};
 const isrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
 Object.defineProperty(HTMLImageElement.prototype,'src',{...isrc,set:function(v){record('img-src',v);return isrc.set.call(this,v);}});
 const sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if(/^(IMG|SCRIPT|IFRAME|LINK)$/.test(this.tagName)&&/^(src|href)$/i.test(name))record('attribute',value);return sa.call(this,name,value);};
 // Same document-wide security MutationObserver as the formal smoke observer (overhead parity).
 const inspect=n=>{if(n.nodeType!==1)return;for(const x of [n,...n.querySelectorAll('img,script,iframe,link')])if(/^(IMG|SCRIPT|IFRAME|LINK)$/.test(x.tagName))record('mutation',x.getAttribute('src')||x.getAttribute('href')||'');};
 new MutationObserver(list=>{for(const m of list)for(const n of m.addedNodes)inspect(n);}).observe(document,{childList:true,subtree:true});
 window.addEventListener('error',e=>errors.push(String(e.message)));
 const invoke=(cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args||{});
 const setPhase=async name=>{await invoke('native_phase',{name});phase=name;};
 const envelope=(text,req,format)=>({schema_version:1,request_id:req,format,format_provenance:'declared',acquisition:'manual',original:{kind:'text',text},fidelity:{truncated:false},canonical:text.replace(/\r\n?/g,'\n'),canonical_unavailable_reason:null,plain_projection:format==='html'?{status:'unavailable',reason:'html sanitizer 未实现'}:{status:'available',text:text.replace(/\r\n?/g,'\n')}});
 const create=async(text,req,format)=>invoke('api',{method:'POST',path:'/api/suggestions',body:{title:req,request_id:req,content:envelope(text,req,format),source_tool:'native-test',workspace:'Synthetic'}});
 let completed=[],yieldN=0;

 /* ---------------- profiling context ---------------- */
 const P={cur:null,on:false,wrapOverheadUs:null,sim:null,lastHopAt:0,flushAtHop:0};
 function newCur(){return {beginAt:0,detailSync:0,ipcGap:null,detailDoneAt:0,fillAt:0,prepare:0,prepareN:0,build:0,buildN:0,parse:0,parseN:0,render:0,renderN:0,sanitize:0,sanitizeN:0,sanitizeInChars:0,project:0,projectN:0,yieldWait:0,yieldN:0,yieldMax:0,mount:0,mountAt:0,resolvedAt:0,flushes:[],yields:[],rafTimeout:false};}
 function installProfileWrappers(){
  // 1) renderDetail skeleton (sync portion: entryHTML build + bindEntry wiring)
  const rd0=window.renderDetail;
  window.renderDetail=function(){const c=P.cur,t0=performance.now();try{return rd0.apply(this,arguments);}finally{if(c&&P.on){c.detailSync=performance.now()-t0;c.detailDoneAt=performance.now();}}};
  // 2) content IPC + decision gap: renderDetail end → fillReaderBody entry
  const frb0=window.fillReaderBody;
  window.fillReaderBody=function(el,r){const c=P.cur;if(c&&P.on&&c.detailDoneAt&&c.ipcGap==null){c.ipcGap=performance.now()-c.detailDoneAt;c.fillAt=performance.now();}return frb0.apply(this,arguments);};
  // 3) NaYanSourceSpans wrapper object (delegates to the frozen original; times prepare/build)
  const SSM0=window.NaYanSourceSpans;
  const W={availability:SSM0.availability,version:SSM0.version};
  W.build=function(d,i){const c=P.cur,t0=performance.now();try{return SSM0.build(d,i);}finally{if(c&&P.on){c.build+=performance.now()-t0;c.buildN++;}}};
  W.prepare=function(d,i){const c=P.cur,t0=performance.now();try{return SSM0.prepare(d,i);}finally{if(c&&P.on){c.prepare+=performance.now()-t0;c.prepareN++;}}};
  window.NaYanSourceSpans=W;
  // 4) sanitizeRichHtml: total DOMPurify cost + input size per call
  const srh0=window.sanitizeRichHtml;
  window.sanitizeRichHtml=function(html,frag){const c=P.cur,t0=performance.now();try{return srh0.apply(this,arguments);}finally{if(c&&P.on){c.sanitize+=performance.now()-t0;c.sanitizeN++;c.sanitizeInChars+=html?html.length:0;}}};
  // 5) projection per batch
  const pb0=window._projBlocks;
  window._projBlocks=function(el,ind){const c=P.cur,t0=performance.now();try{return pb0.apply(this,arguments);}finally{if(c&&P.on){c.project+=performance.now()-t0;c.projectN++;}}};
  // 6) MD_INSTANCE pre-set with instrumented parse/renderer.render (identical options;
  //    the mapper keeps its own untouched instance/cache path)
  const md=window.markdownit({html:false,breaks:false,linkify:false,typographer:false});
  const p0=md.parse.bind(md);md.parse=function(src,env){const c=P.cur,t0=performance.now();try{return p0(src,env);}finally{if(c&&P.on){c.parse+=performance.now()-t0;c.parseN++;}}};
  const r0=md.renderer.render.bind(md.renderer);md.renderer.render=function(t,o,e){const c=P.cur,t0=performance.now();try{return r0(t,o,e);}finally{if(c&&P.on){c.render+=performance.now()-t0;c.renderN++;}}};
  window.MD_INSTANCE=md;
  // 7) yield waits: measure actual await duration of each richTaskYield call
  const ry0=window.richTaskYield;
  window.richTaskYield=function(task){
   // Diagnosis-only yield-policy simulation: skip the real macrotask hop when the
   // last real hop is fresher than P.sim.every ms AND no live flush happened since.
   // Skipped awaits still settle as microtasks; cancellation checks run per slice.
   const c=P.cur;
   if(c&&P.on&&P.sim){
    const now=performance.now();
    const flushed=c.flushes.length>P.flushAtHop;
    if(!flushed&&now-P.lastHopAt<P.sim.every){c.simSkips=(c.simSkips||0)+1;return Promise.resolve();}
    P.lastHopAt=now;P.flushAtHop=c.flushes.length;
   }
   const t0=performance.now();
   return ry0(task).then(function(r){if(c&&P.on){const t1=performance.now();const d=t1-t0;c.yieldWait+=d;c.yieldN++;if(d>c.yieldMax)c.yieldMax=d;c.yields.push({t0:t0-c.beginAt,t1:t1-c.beginAt,d:d,sim:!!(P.sim&&(c.simSkips||0)>=0)});}return r;});
  };
  // 8) sidecar mount + precise completion timestamp
  const mrs0=window.mountReaderSidecar;
  window.mountReaderSidecar=function(el,r,sc){const c=P.cur,t0=performance.now();try{return mrs0.apply(this,arguments);}finally{if(c&&P.on){c.mount+=performance.now()-t0;c.mountAt=performance.now();}}};
  // Wrapper overhead estimate: plain call vs same-length wrapper chain, per call.
  const pn='__nayanProfProbe';const probe=function(a){return a;};
  window[pn]=probe;const t0=performance.now();for(let i=0;i<20000;i++)window[pn](i);const bare=performance.now()-t0;
  const origProbe=probe;window[pn]=function(a){return origProbe(a);};
  const t1=performance.now();for(let i=0;i<20000;i++)window[pn](i);const wrappedCost=performance.now()-t1;
  delete window[pn];
  P.wrapOverheadUs=(wrappedCost-bare)*1000/20000; // ms→us per call
 }
 function installRenderObserver(){
  const render=window.renderReaderBodyAsync;
  window.renderReaderBodyAsync=function(el,d,open){const rec={el,decision:d,done:false};completed.push(rec);return render(el,d,open).then(res=>{Object.assign(rec,res,{done:true});const c=P.cur;if(c&&P.on&&c.resolvedAt===0)c.resolvedAt=performance.now();return res;});};
  const yield0=window.richTaskYield;
  window.richTaskYield=function(task){return yield0(task).then(async()=>{yieldN++;if(window.__nativeStopOnYield){window.__nativeStopOnYield=false;const rec=completed[completed.length-1];await invoke('native_checkpoint',{value:{yieldN,inProgress:!!(rec&&!rec.done),connected:!!(rec&&rec.el.isConnected),requestId:rec&&rec.el.__nayanIdentity&&rec.el.__nayanIdentity.requestId}});await new Promise(()=>{});}});};
 }
 function observer(){
  const samples=[],msgLat=[],mc=new MessageChannel();let active=true,timer,probe,scheduled=0,sent=0;
  mc.port1.onmessage=e=>msgLat.push(performance.now()-e.data);
  const tick=()=>{if(!active)return;const fired=performance.now();samples.push({scheduled,fired});scheduled=performance.now();timer=setTimeout(tick,2);};
  return {start(){scheduled=performance.now();timer=setTimeout(tick,2);probe=setTimeout(function loop(){if(!active)return;mc.port2.postMessage(performance.now());sent++;probe=setTimeout(loop,4);},4);},stop(){active=false;clearTimeout(timer);clearTimeout(probe);mc.port1.close();mc.port2.close();return {samples,msgLat,msgSent:sent};}};
 }
 async function ptrial(item,format){
  let el=document.getElementById('aibody');cancelReaderBodyRender(el);el.textContent='';el.className='aibody';el.__nayanSourceMap=null;el.__nayanSidecarCache=null;el.__nayanDecision=null;
  await sleep(30);completed=[];yieldN=0;
  const flushes=[];const mo=new MutationObserver(list=>{let n=0;for(const m of list)n+=m.addedNodes.length;flushes.push({at:performance.now(),added:n});});
  P.cur=newCur();P.on=true;P.lastHopAt=performance.now();P.flushAtHop=0;
  const obs=observer();obs.start();const begin=performance.now();state.sel=item.id;renderDetail();el=document.getElementById('aibody');
  mo.observe(el,{childList:true});
  P.cur.beginAt=begin;
  let rec=null;
  for(let i=0;i<4000;i++){rec=completed[completed.length-1];if(rec&&rec.done&&(format!=='markdown'||el.__nayanSidecarCache))break;await sleep(4);}
  const resolvedSeen=performance.now();
  const rafWait=new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const rafFallback=new Promise(r=>setTimeout(()=>{cur.rafTimeout=true;r();},5000));
  await Promise.race([rafWait,rafFallback]);const visibleMs=performance.now()-begin;await sleep(6);
  const stat=obs.stop();mo.disconnect();
  const cur=P.cur;P.on=false;P.cur=null;
  const sc=readerSidecarOf(el);
  return {visibleMs,rafTail:performance.now()-resolvedSeen,rafTimeout:cur.rafTimeout,status:rec&&rec.status,rendered:!!(rec&&rec.rendered),yields:yieldN,maxDrift:Math.max(0,...stat.samples.map(x=>x.fired-x.scheduled)),driftN:stat.samples.length,samples:stat.samples,msgLat:stat.msgLat,msgSent:stat.msgSent,identityOk:!!(sc&&sc.identity().requestId===item.req&&sc.check(el.__nayanDecision,el.__nayanIdentity)),entries:sc?sc.entries().length:0,headings:el.querySelectorAll('h1,h2,h3,h4,h5,h6').length,fences:el.querySelectorAll('pre code').length,domNodes:el.querySelectorAll('*').length,bodyTextLen:el.textContent.length,
   prof:{beginAt:cur.beginAt,yields:cur.yields,simSkips:cur.simSkips||0,detailSync:cur.detailSync,ipcGap:cur.ipcGap,prepare:cur.prepare,prepareN:cur.prepareN,build:cur.build,buildN:cur.buildN,parse:cur.parse,parseN:cur.parseN,render:cur.render,renderN:cur.renderN,sanitize:cur.sanitize,sanitizeN:cur.sanitizeN,sanitizeInChars:cur.sanitizeInChars,project:cur.project,projectN:cur.projectN,yieldWait:cur.yieldWait,yieldN:cur.yieldN,yieldMax:cur.yieldMax,mount:cur.mount,mountAt:cur.mountAt,resolvedAt:cur.resolvedAt,flushes,wrapOverheadUs:P.wrapOverheadUs}};
 }
 async function run(){
  let out={mode,checks,net,errors,perf:[],phaseOrder:[],profileMeta:{}};
  const startedAt=Date.now();
  const wd=setInterval(async()=>{if(Date.now()-startedAt>200000){try{console.error('[prof] watchdog forced result');await invoke('native_result',{result:{...out,watchdog:'forced at 200s'}});}catch(e){}}},5000);
  const mark=m=>console.log('[prof]',m,Math.round(performance.now()));
  try{
   for(let i=0;i<2000&&!(window.__TAURI_INTERNALS__&&typeof window.renderDetail==='function'&&window.state);i++)await sleep(10);
   check('actual native IPC and product page ready',!!window.__TAURI_INTERNALS__&&typeof renderDetail==='function');
   mark('ready');await load(false);window.aiBusy=true;installProfileWrappers();installRenderObserver();mark('installed');
   const items0=await invoke('api',{method:'GET',path:'/api/suggestions'});check('new isolated database starts empty',items0.length===0);
   out.ua=navigator.userAgent;out.protocol=location.protocol;out.yieldBranch=typeof scheduler==='object'&&typeof scheduler.yield==='function'?'scheduler':'mc';
   const fixtureData=await fetch0('/__native-fixtures.json').then(r=>r.json());
   await setPhase('smoke');mark('fixtures-loaded');
   const md='# 原生测试\n\n1. 第一\n2. 第二\n   - 嵌套\n\n> 引用\n\n```js\n  const value = "中文 e\u0301";\n\tTab\n```\n';
   const m=await create(md,'native-md','markdown');m.req='native-md';await load(false);state.sel=m.id;renderDetail();
   const t=await ptrial(m,'markdown');mark('smoke-trial-done');check('MD real backend/native IPC/detail complete',t.status==='rendered'&&t.identityOk&&t.entries>0);
   const el=document.getElementById('aibody');check('code preserved exactly',el.querySelector('pre code').textContent==='  const value = "中文 e\u0301";\n\tTab\n');
   const saved=await invoke('api',{method:'GET',path:'/api/suggestions/'+m.id+'/content'});check('saved original and canonical equal synthetic input',saved.content.original.text===md&&saved.content.canonical===md);
   // ---- profile branch: frozen four fixtures, cold + limited warm ----
   const seeded=[];
   for(const f of fixtureData.fixtures){const row=await invoke('native_seed',{label:f.label});seeded.push({...f,id:row.id,req:row.req});}
   await load(false);await setPhase('performance');mark('seeded');
   const counts={'ordinary-102400':4,'ordinary-1048576':4,'dense-102400':4,'dense-1048576':4};
   for(const item of seeded){const trials=[];const n=counts[item.label]||4;
    for(let i=0;i<n;i++)trials.push(await ptrial(item,'markdown'));
    out.perf.push({label:item.label,bytes:item.bytes,blocks:item.blocks,counts:{headings:trials[0].headings,fences:trials[0].fences,entries:trials[0].entries,blocks:item.blocks},trials});mark('fixture-done:'+item.label);}
   // ---- dense-1MiB containment/slice simulation sweep (test-side CSS/constants; product untouched) ----
   const dense=seeded.find(x=>x.label==='dense-1048576');
   const sweep=[];
   const runVar=async(name,n,setup,teardown)=>{if(setup)setup();const trials=[];for(let i=0;i<n;i++)trials.push(await ptrial(dense,'markdown'));if(teardown)teardown();sweep.push({variant:name,trials});return trials;};
   await runVar('baseline',4);mark('sweep-baseline-done');
   // Variant 1: layout containment on the reader container (proposed product CSS; simulated here).
   const ctStyle=document.createElement('style');ctStyle.textContent='.aibody{contain:layout style;}';
   await runVar('contain-layout-style',4,()=>document.head.appendChild(ctStyle),()=>ctStyle.remove());mark('sweep-contain-done');
   // Variant 2: halve/quarter the top-level batch count (RICH_SLICE_MAX_ELEMS is the real
   // dense constraint; 48KiB HTML cap is never reached on dense inputs).
   const savedElems=window.RICH_SLICE_MAX_ELEMS,savedAttach=window.RICH_ATTACH_MAX_HTML;
   window.RICH_SLICE_MAX_ELEMS=1024;
   await runVar('elems1024',4,null,()=>{window.RICH_SLICE_MAX_ELEMS=savedElems;});mark('sweep-elems1024-done');
   window.RICH_SLICE_MAX_ELEMS=2048;
   await runVar('elems2048',4,null,()=>{window.RICH_SLICE_MAX_ELEMS=savedElems;});mark('sweep-elems2048-done');
   // Variant 3: elems1024 + attach512 together.
   window.RICH_SLICE_MAX_ELEMS=1024;window.RICH_ATTACH_MAX_HTML=512*1024;
   await runVar('elems1024+attach512',4,null,()=>{window.RICH_SLICE_MAX_ELEMS=savedElems;window.RICH_ATTACH_MAX_HTML=savedAttach;});mark('sweep-combined-done');
   out.sweep=sweep;
   clearInterval(wd);
   await setPhase('teardown');out.net=net;out.errors=errors;out.profileMeta={wrapOverheadUs:P.wrapOverheadUs,yieldBranch:out.yieldBranch,mcIdle:out.profileMeta.mcIdle,mcWithHeartbeat:out.profileMeta.mcWithHeartbeat,cvSupported:(typeof CSS!=='undefined'&&CSS.supports)&&CSS.supports('content-visibility','auto')};
   await invoke('native_result',{result:out});
  }catch(e){out.error=String(e.stack||e);try{await invoke('native_result',{result:out});}catch(e2){console.error('native result unavailable',e2);}}
 }
 run();
})();
