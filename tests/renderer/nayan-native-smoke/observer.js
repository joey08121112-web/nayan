// Test-only initialization observer. Uses genuine Tauri IPC; does not replace api/core.invoke.
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
 const envelope=(text,req,format)=>({schema_version:1,request_id:req,format,format_provenance:'declared',acquisition:'manual',original:{kind:'text',text},fidelity:{truncated:false},canonical:text.replace(/\r\n?/g,'\n'),canonical_unavailable_reason:null,plain_projection:format==='html'?{status:'unavailable',reason:'html sanitizer 未实现：结构化 plain projection 不可用（本批契约显式拒绝伪投影）'}:{status:'available',text:text.replace(/\r\n?/g,'\n')}});
 const create=async(text,req,format)=>invoke('api',{method:'POST',path:'/api/suggestions',body:{title:req,request_id:req,content:envelope(text,req,format),source_tool:'native-test',workspace:'Synthetic'}});
 let completed=[],yieldN=0,injection=null,injectWindow=null;
 function installRenderObserver(){
  const render=window.renderReaderBodyAsync;
  window.renderReaderBodyAsync=function(el,d,open){const rec={el,decision:d,done:false};completed.push(rec);return render(el,d,open).then(res=>{Object.assign(rec,res,{done:true});return res;});};
  const yield0=window.richTaskYield;
  window.richTaskYield=function(task){return yield0(task).then(async()=>{yieldN++;if(injection&&injection.at===yieldN)injectNow('yield');if(window.__nativeStopOnYield){window.__nativeStopOnYield=false;const rec=completed[completed.length-1];await invoke('native_checkpoint',{value:{yieldN,inProgress:!!(rec&&!rec.done),connected:!!(rec&&rec.el.isConnected),requestId:rec&&rec.el.__nayanIdentity&&rec.el.__nayanIdentity.requestId}});await new Promise(()=>{});}if(window.__nativeRaceSwitch){const f=window.__nativeRaceSwitch;window.__nativeRaceSwitch=null;f();}});};
  const mount=window.mountReaderSidecar;
  window.mountReaderSidecar=function(el,d,sc){if(injection&&injection.at===-1)injectNow('completion');return mount(el,d,sc);};
 }
 function injectNow(where){const ms=injection.ms;injection=null;const start=performance.now();while(performance.now()-start<ms){}injectWindow={start,end:performance.now(),where};}
 function observer(){
  const samples=[],msgLat=[],mc=new MessageChannel();let active=true,timer,probe,scheduled=0,sent=0;
  mc.port1.onmessage=e=>msgLat.push(performance.now()-e.data);
  const tick=()=>{if(!active)return;const fired=performance.now();samples.push({scheduled,fired});scheduled=performance.now();timer=setTimeout(tick,2);};
  return {start(){scheduled=performance.now();timer=setTimeout(tick,2);probe=setTimeout(function loop(){if(!active)return;mc.port2.postMessage(performance.now());sent++;probe=setTimeout(loop,4);},4);},stop(){active=false;clearTimeout(timer);clearTimeout(probe);mc.port1.close();mc.port2.close();return {samples,msgLat,msgSent:sent};}};
 }
 async function trial(item,format,opts){
  let el=document.getElementById('aibody');cancelReaderBodyRender(el);el.textContent='';el.className='aibody';el.__nayanSourceMap=null;el.__nayanSidecarCache=null;el.__nayanDecision=null;
  await sleep(30);completed=[];yieldN=0;injection=opts||null;injectWindow=null;
  // No fixture pre-render. The first trial includes the actual detail DOM, IPC and uncached parse.
  const obs=observer();obs.start();const begin=performance.now();state.sel=item.id;renderDetail();el=document.getElementById('aibody');
  let rec=null;
  for(let i=0;i<4000;i++){rec=completed[completed.length-1];if(rec&&rec.done&&(format!=='markdown'||el.__nayanSidecarCache))break;await sleep(4);}
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const visibleMs=performance.now()-begin;await sleep(6);
  const stat=obs.stop(),sc=readerSidecarOf(el);
  return {visibleMs,status:rec&&rec.status,rendered:!!(rec&&rec.rendered),yields:yieldN,maxDrift:Math.max(0,...stat.samples.map(x=>x.fired-x.scheduled)),driftN:stat.samples.length,samples:stat.samples,msgLat:stat.msgLat,msgSent:stat.msgSent,injectionWindow:injectWindow,identityOk:format==='markdown'?!!(sc&&sc.identity().requestId===item.req&&sc.check(el.__nayanDecision,el.__nayanIdentity)):!!(el.__nayanIdentity&&el.__nayanIdentity.itemId===item.id),entries:sc?sc.entries().length:0,headings:el.querySelectorAll('h1,h2,h3,h4,h5,h6').length,fences:el.querySelectorAll('pre code').length,domNodes:el.querySelectorAll('*').length,bodyTextLen:el.textContent.length,bodyText:opts&&opts.body?el.textContent:undefined};
 }
 async function run(){
  let out={mode,checks,net,errors,perf:[],injection:null,phaseOrder:[]};
  try{
   for(let i=0;i<2000&&!(window.__TAURI_INTERNALS__&&typeof window.renderDetail==='function'&&window.state);i++)await sleep(10);
   check('actual native IPC and product page ready',!!window.__TAURI_INTERNALS__&&typeof renderDetail==='function');
   await load(false);window.aiBusy=true;installRenderObserver();
   const items0=await invoke('api',{method:'GET',path:'/api/suggestions'});check('new isolated database starts empty',items0.length===0);
   out.ua=navigator.userAgent;out.protocol=location.protocol;out.yieldBranch=typeof scheduler==='object'&&typeof scheduler.yield==='function'?'scheduler':'mc';
   if(mode==='isolation'){await setPhase('teardown');await invoke('native_result',{result:out});return;}
   const fixtureData=await fetch0('/__native-fixtures.json').then(r=>r.json());
   await setPhase('smoke');
   const md='# 原生测试\n\n1. 第一\n2. 第二\n   - 嵌套\n\n> 引用\n\n```js\n  const value = "中文 e\u0301";\n\tTab\n```\n';
   const m=await create(md,'native-md','markdown');m.req='native-md';await load(false);state.sel=m.id;renderDetail();
   const t=await trial(m,'markdown');check('MD real backend/native IPC/detail complete',t.status==='rendered'&&t.identityOk&&t.entries>0);
   const el=document.getElementById('aibody');check('code preserved exactly',el.querySelector('pre code').textContent==='  const value = "中文 e\u0301";\n\tTab\n');check('ordered/nested/quote structure',el.querySelectorAll('ol').length===1&&el.querySelectorAll('ul').length===1&&el.querySelectorAll('blockquote').length===1);
   const saved=await invoke('api',{method:'GET',path:'/api/suggestions/'+m.id+'/content'});check('saved original and canonical equal synthetic input',saved.content.original.text===md&&saved.content.canonical===md);out.smokeMd={id:m.id,req:m.req,text:md,trial:t};
   const sidecar=readerSidecarOf(el),ent=sidecar.entries().find(e=>e.kind==='code-payload');check('source slice current native identity',sidecar.slice(ent.id,el.__nayanDecision,el.__nayanIdentity).text==='  const value = "中文 e\u0301";\n\tTab');
   document.querySelector('[data-act="togglerich"]').click();for(let i=0;i<1000&&el.textContent!==md;i++)await sleep(4);check('actual source toggle preserves canonical exactly',el.textContent===md&&!readerSidecarOf(el));
   document.querySelector('[data-act="togglerich"]').click();for(let i=0;i<1000&&!readerSidecarOf(el);i++)await sleep(4);check('actual rich toggle restores current source map',!!readerSidecarOf(el)&&readerSidecarOf(el).identity().requestId===m.req);
   const plain='段落\r\n\r\n  缩进\r<脚本> e\u0301\n';const p=await create(plain,'native-plain','plain');p.req='native-plain';await load(false);state.sel=p.id;renderDetail();await trial(p,'plain');check('plain native canonical exact',document.getElementById('aibody').textContent===plain.replace(/\r\n?/g,'\n'));
   const legacy='  # legacy looks markdown\n\n  preserve\n';const l=await invoke('api',{method:'POST',path:'/api/suggestions',body:{title:'native-legacy',quote:legacy}});await load(false);state.sel=l.id;renderDetail();await trial(l,'plain');check('legacy remains plain exact',document.getElementById('aibody').textContent===legacy);
   if(mode==='interrupt'){
    const f=fixtureData.fixtures[3],row=await invoke('native_seed',{label:f.label});await load(false);window.__nativeStopOnYield=true;state.sel=row.id;renderDetail();await new Promise(()=>{});
   }else if(mode.startsWith('perform')||mode.startsWith('inject-')){
    const seeded=[];
    for(const f of fixtureData.fixtures){const row=await invoke('native_seed',{label:f.label});seeded.push({...f,id:row.id,req:row.req});}
    await load(false);await setPhase('performance');
    if(mode.startsWith('inject-')){
     const r=await invoke('native_seed',{label:'inject'});const item={id:r.id,req:r.req};await load(false);state.sel=r.id;
     const control=await trial(item,'markdown'),pos=mode.slice(7),injected=await trial(item,'markdown',{at:pos==='early'?1:pos==='mid'?2:-1,ms:150});out.injection={position:pos,control,injected};
    }else{
     for(const item of seeded){state.sel=item.id;const trials=[];for(let i=0;i<31;i++)trials.push(await trial(item,'markdown'));out.perf.push({label:item.label,bytes:item.bytes,blocks:item.blocks,counts:{headings:trials[0].headings,fences:trials[0].fences,entries:trials[0].entries,blocks:item.blocks},trials});}
    }
   }else{
    await setPhase('hostile-window');
    const hostile='<p>safe <strong>bold</strong></p><script>window.__nativePwned=1</script><img src="https://body.invalid/x" onerror="window.__nativePwned=1"><a href="javascript:window.__nativePwned=1">bad</a><iframe src="https://body.invalid/f"></iframe>';
    // Seed outside the closed hostile phase; real write must not be attributed to body.
    await setPhase('smoke');const h=await create(hostile,'native-hostile-html','html'),hm=await create('# Hostile\n\n'+hostile,'native-hostile-md','markdown');hm.req='native-hostile-md';await load(false);
    for(const [row,format]of[[h,'html'],[hm,'markdown']]){state.sel=row.id;await setPhase('hostile-window');renderDetail();await trial(row,format);const b=document.getElementById('aibody');check('hostile '+format+' has no privileged executable tags/attrs',!window.__nativePwned&&b.querySelectorAll('script,img,iframe,[onclick],[onerror],[style],a[href^="javascript:"]').length===0);}
    if(mode==='gate-native')await invoke('open_path',{path:'/nonexistent-synthetic-test'}).catch(()=>{});
    if(mode==='gate-net'){fetch('https://transient.invalid/blocked').catch(()=>{});const img=new Image();img.src='https://transient.invalid/short';document.body.appendChild(img);img.remove();}
    await sleep(40);out.hostileNet=net.filter(e=>e.phase==='hostile-window');await setPhase('race');
    const texts=fixtureData.fixtures[2].text;const a=await create(texts,'native-race-A','markdown'),bb=await create(texts.replace('章节','章类'),'native-race-B','markdown');a.req='native-race-A';bb.req='native-race-B';await load(false);state.sel=a.id;renderDetail();await trial(a,'markdown');const oldMap=readerSidecarOf(document.getElementById('aibody'));
    state.sel=bb.id;renderDetail();await trial(bb,'markdown');const b=document.getElementById('aibody');check('A→B old source map rejected',!oldMap.check(b.__nayanDecision,b.__nayanIdentity));state.sel=a.id;renderDetail();await trial(a,'markdown');check('A→B→A current map correct',readerSidecarOf(document.getElementById('aibody')).identity().requestId===a.req);
    const live=document.getElementById('aibody'),decision=live.__nayanDecision,timeout0=window.setTimeout;let held=null;
    window.setTimeout=function(f,ms,...args){if(!held&&ms===0&&typeof f==='function'&&String(f).includes('res.sidecar')&&String(f).includes('isCurrent()')){held=()=>f(...args);return timeout0(()=>{},0);}return timeout0(f,ms,...args);};
    fillReaderBody(live,decision);for(let i=0;i<1000&&!held;i++)await sleep(4);window.setTimeout=timeout0;check('actual completion hop captured after render',!!held);
    fillReaderBody(live,decision);const newRec=completed[completed.length-1];held();check('stale completion does not publish into newer live task',!newRec.done&&live.__nayanSourceMap===null);
    for(let i=0;i<1000&&(!newRec.done||!readerSidecarOf(live));i++)await sleep(4);check('new completion publishes correct native identity',newRec.status==='rendered'&&!!readerSidecarOf(live)&&readerSidecarOf(live).identity().requestId===a.req);
    const make=(id,text)=>{const e=document.createElement('div');document.body.appendChild(e);e.__nayanDecision={format:'markdown',provenance:'declared',mode:'markdown',renderable:true,text};e.__nayanIdentity={itemId:id,requestId:'native-direct-'+id,revision:null};return e;};
    const e1=make(9001,texts),e2=make(9002,texts);const both=await Promise.all([renderReaderBodyAsync(e1,e1.__nayanDecision,null),renderReaderBodyAsync(e2,e2.__nayanDecision,null)]);check('real MC concurrent waits settle both',both.every(r=>r.status==='rendered'));e1.remove();e2.remove();
    const e3=make(9003,texts);window.__nativeRaceSwitch=()=>cancelReaderBodyRender(e3);const cancelled=await renderReaderBodyAsync(e3,e3.__nayanDecision,null);check('cancelled MC task actually settles',cancelled.status==='cancelled');e3.remove();
    const e4=make(9004,texts);window.__nativeRaceSwitch=()=>{e4.__nayanDecision.text+='x';};const mutated=await renderReaderBodyAsync(e4,e4.__nayanDecision,null);check('same-object mutation prevents stale completion',mutated.status==='cancelled');e4.remove();
   }
   await setPhase('teardown');out.net=net;out.errors=errors;await invoke('native_result',{result:out});
  }catch(e){out.error=String(e.stack||e);try{await invoke('native_result',{result:out});}catch(e2){console.error('native result unavailable',e2);}}
 }
 run();
})();
