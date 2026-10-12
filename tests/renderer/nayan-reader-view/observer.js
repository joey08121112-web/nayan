// P1-B06-NATIVE-PAYLOAD-01 / Step 1 — boundary-event observer (diagnosis only).
// Same formal-parity security observation as nayan-native-smoke/observer.js; adds
// same-trial timestamped boundary events (no durations, no inclusive sums):
//   renderDetailStart/End, apiCallStart (GET :id/content), apiResolved,
//   decisionAt (readerBody returns), fillAt, taskStart, resolvedAt, mountAt,
//   observedDoneAt (poll exit condition first met), visibleAt (two rAF done).
// Timestamps are relative to trial beginAt; segmentation is by adjacent-difference.
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
 const inspect=n=>{if(n.nodeType!==1)return;for(const x of [n,...n.querySelectorAll('img,script,iframe,link')])if(/^(IMG|SCRIPT|IFRAME|LINK)$/.test(x.tagName))record('mutation',x.getAttribute('src')||x.getAttribute('href')||'');};
 new MutationObserver(list=>{for(const m of list)for(const n of m.addedNodes)inspect(n);}).observe(document,{childList:true,subtree:true});
 window.addEventListener('error',e=>errors.push(String(e.message)));
 const invoke=(cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args||{});
 const setPhase=async name=>{await invoke('native_phase',{name});phase=name;};
 const envelope=(text,req,format)=>({schema_version:1,request_id:req,format,format_provenance:'declared',acquisition:'manual',original:{kind:'text',text},fidelity:{truncated:false},canonical:text.replace(/\r\n?/g,'\n'),canonical_unavailable_reason:null,plain_projection:format==='html'?{status:'unavailable',reason:'html sanitizer 未实现'}:{status:'available',text:text.replace(/\r\n?/g,'\n')}});
 const create=async(text,req,format)=>invoke('api',{method:'POST',path:'/api/suggestions',body:{title:req,request_id:req,content:envelope(text,req,format),source_tool:'native-test',workspace:'Synthetic'}});
 let completed=[],yieldN=0;
 const P={cur:null,on:false};
 function installBoundaryWrappers(){
  const rd0=window.renderDetail;
  window.renderDetail=function(){const c=P.cur;if(c&&P.on&&c.t.renderDetailStart==null)c.t.renderDetailStart=performance.now();try{return rd0.apply(this,arguments);}finally{if(c&&P.on)c.t.renderDetailEnd=performance.now();}};
  const api0=window.api;
  window.api=function(method,url){const c=P.cur;if(c&&P.on&&method==='GET'&&/\/content$/.test(String(url))&&c.t.apiCallStart==null)c.t.apiCallStart=performance.now();return api0.apply(this,arguments);};
  const rb0=window.readerBody;
  window.readerBody=function(env,q){const c=P.cur;const t0=performance.now();try{return rb0.apply(this,arguments);}finally{if(c&&P.on){c.t.readerBodyCallStart=(c.t.readerBodyCallStart==null)?t0:c.t.readerBodyCallStart;c.t.decisionAt=performance.now();c.t.decision=(c.t.decision||[]).concat([{at:performance.now(),renderable:arguments[0]&&!!(arguments[0].content),mode:null}]);}}};
  const frb0=window.fillReaderBody;
  window.fillReaderBody=function(el,r){const c=P.cur;if(c&&P.on){c.t.fillAt=performance.now();c.t.fillMode=r&&r.mode;c.t.fillRenderable=!!(r&&r.renderable);c.t.fillTextLen=r&&typeof r.text==='string'?r.text.length:0;}return frb0.apply(this,arguments);};
  const mrs0=window.mountReaderSidecar;
  window.mountReaderSidecar=function(){const c=P.cur;try{return mrs0.apply(this,arguments);}finally{if(c&&P.on)c.t.mountAt=performance.now();}};
 }
 function installRenderObserver(){
  const render=window.renderReaderBodyAsync;
  window.renderReaderBodyAsync=function(el,d,open){const c=P.cur;if(c&&P.on&&c.t.taskStart==null)c.t.taskStart=performance.now();const rec={el,decision:d,done:false};completed.push(rec);return render(el,d,open).then(res=>{Object.assign(rec,res,{done:true});if(c&&P.on&&c.t.resolvedAt==null)c.t.resolvedAt=performance.now();return res;});};
 }
 function observer(){
  const samples=[],msgLat=[],mc=new MessageChannel();let active=true,timer,probe,scheduled=0,sent=0;
  mc.port1.onmessage=e=>msgLat.push(performance.now()-e.data);
  const tick=()=>{if(!active)return;const fired=performance.now();samples.push({scheduled,fired});scheduled=performance.now();timer=setTimeout(tick,2);};
  return {start(){scheduled=performance.now();timer=setTimeout(tick,2);probe=setTimeout(function loop(){if(!active)return;mc.port2.postMessage(performance.now());sent++;probe=setTimeout(loop,4);},4);},stop(){active=false;clearTimeout(timer);clearTimeout(probe);mc.port1.close();mc.port2.close();return {samples,msgLat,msgSent:sent};}};
 }
 async function btrial(item,format){
  let el=document.getElementById('aibody');cancelReaderBodyRender(el);el.textContent='';el.className='aibody';el.__nayanSourceMap=null;el.__nayanSidecarCache=null;el.__nayanDecision=null;
  await sleep(30);completed=[];yieldN=0;
  P.cur={t:{}};P.on=true;
  const obs=observer();obs.start();const begin=performance.now();
  const T=P.cur.t;T.beginAt=begin;
  state.sel=item.id;renderDetail();
  el=document.getElementById('aibody');
  let rec=null;
  for(let i=0;i<4000;i++){rec=completed[completed.length-1];if(rec&&rec.done&&(format!=='markdown'||el.__nayanSidecarCache)){T.observedDoneAt=performance.now();break;}await sleep(4);}
  if(T.observedDoneAt==null)T.observedDoneAt=performance.now();
  const visibleAt=await new Promise(r=>{const t0=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.now())));});
  T.visibleAt=visibleAt;const visibleMs=visibleAt-begin;
  const stat=obs.stop();
  const cur=P.cur;P.on=false;P.cur=null;
  const sc=readerSidecarOf(el);
  const rel=t=>(t==null?null:Math.round((t-begin)*10)/10);
  return {visibleMs:Math.round(visibleMs*10)/10,status:rec&&rec.status,rendered:!!(rec&&rec.rendered),yields:yieldN,
   maxDrift:Math.max(0,...stat.samples.map(x=>x.fired-x.scheduled)),driftN:stat.samples.length,
   identityOk:!!(sc&&sc.identity().requestId===item.req&&sc.check(el.__nayanDecision,el.__nayanIdentity)),
   entries:sc?sc.entries().length:0,headings:el.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
   fences:el.querySelectorAll('pre code').length,domNodes:el.querySelectorAll('*').length,bodyTextLen:el.textContent.length,
   events:{renderDetailStart:rel(T.renderDetailStart),renderDetailEnd:rel(T.renderDetailEnd),apiCallStart:rel(T.apiCallStart),
    decisionAt:rel(T.decisionAt),fillAt:rel(T.fillAt),taskStart:rel(T.taskStart),resolvedAt:rel(T.resolvedAt),
    mountAt:rel(T.mountAt),observedDoneAt:rel(T.observedDoneAt),visibleAt:rel(T.visibleAt),
    fillMode:T.fillMode,fillRenderable:T.fillRenderable,fillTextLen:T.fillTextLen}};
 }
 async function run(){
  let out={mode,checks,net,errors,perf:[],payloads:[],phaseOrder:[]};
  try{
   for(let i=0;i<2000&&!(window.__TAURI_INTERNALS__&&typeof window.renderDetail==='function'&&window.state);i++)await sleep(10);
   check('actual native IPC and product page ready',!!window.__TAURI_INTERNALS__&&typeof renderDetail==='function');
   await load(false);window.aiBusy=true;installBoundaryWrappers();installRenderObserver();
   const items0=await invoke('api',{method:'GET',path:'/api/suggestions'});check('new isolated database starts empty',items0.length===0);
   out.ua=navigator.userAgent;out.protocol=location.protocol;
   const fixtureData=await fetch0('/__native-fixtures.json').then(r=>r.json());
   await setPhase('smoke');
   const md='# 原生测试\n\n1. 第一\n2. 第二\n   - 嵌套\n\n> 引用\n\n```js\n  const value = "中文 e\u0301";\n\tTab\n```\n';
   const m=await create(md,'native-md','markdown');m.req='native-md';await load(false);state.sel=m.id;renderDetail();
   const t=await btrial(m,'markdown');check('MD real backend/native IPC/detail complete',t.status==='rendered'&&t.identityOk&&t.entries>0);
   const el=document.getElementById('aibody');check('code preserved exactly',el.querySelector('pre code').textContent==='  const value = "中文 e\u0301";\n\tTab\n');
   // payload probe for every seeded row (Rust-side real handle_api measurement)
   const seeded=[];
   for(const f of fixtureData.fixtures){const row=await invoke('native_seed',{label:f.label});seeded.push({...f,id:row.id,req:row.req});
    out.payloads.push(await invoke('payload_probe',{id:row.id}));}
   await load(false);await setPhase('performance');
   // boundary trials: dense-1MiB x6, ordinary-1MiB x4, small x3 each
   const plan={'dense-1048576':6,'ordinary-1048576':4,'dense-102400':3,'ordinary-102400':3};
   for(const item of seeded){const n=plan[item.label]||3;const trials=[];
    for(let i=0;i<n;i++)trials.push(await btrial(item,'markdown'));
    out.perf.push({label:item.label,bytes:item.bytes,blocks:item.blocks,trials});}
   await setPhase('teardown');out.net=net;out.errors=errors;await invoke('native_result',{result:out});
  }catch(e){out.error=String(e.stack||e);try{await invoke('native_result',{result:out});}catch(e2){console.error('native result unavailable',e2);}}
 }
 run();
})();
