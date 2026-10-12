import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import net from 'node:net';import {spawn} from 'node:child_process';
import {createRoot,bindChild,waitChild,cleanRoot} from '../tauri-asset-smoke/lifecycle.mjs';
import {evaluatePerformanceGate,validateTrial,detectInjectionAttribution,classifyInjectRun} from '../reader-performance/gate.mjs';
/* READER-CONTRACT-REPAIR-04: strict args + scope preflight (no side effect before validation). */
const args=process.argv.slice(2),option=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
if(args.length%2!==0)throw Error('odd argv: every option needs a value');
const outRaw=option('--out');if(!outRaw)throw Error('--out required');
const { parseArgs, preflightOut, BATCH_DIR }=await import('../nayan-reader-view/preflight-lib.mjs');
const parsed=parseArgs(args,{'--out':'value','--mode':'optional','--fault':'optional'});
const mode=parsed['--mode']||'smoke';
if(!['isolation','smoke','perform','inject-early','inject-mid','inject-late','gate-native','gate-net','interrupt'].includes(mode))throw Error('unknown mode: '+mode);
const fault=parsed['--fault'];if(fault&&!['evidence','cleanup'].includes(fault))throw Error('unknown fault: '+fault);
preflightOut(outRaw,BATCH_DIR); // trusted constant scope; caller env cannot widen it
const out=path.resolve(outRaw);if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('nonempty output directory refused; preserve prior evidence');fs.mkdirSync(out,{recursive:true});
const bin=path.resolve('app/src-tauri/target/debug/nayan-native-verify'),record=createRoot('nayan-native-run-'),root=record.root;
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
fs.writeFileSync(path.join(root,'nayan-test-owned.json'),JSON.stringify({owner:'nayan-reader-regression',run_id:record.run,active_pid:null}));
const picker=net.createServer();await new Promise(r=>picker.listen(0,'127.0.0.1',r));const port=picker.address().port;await new Promise(r=>picker.close(r));
const start=new Date().toISOString(),loads=[{at_utc:start,value:os.loadavg()}],fd=fs.openSync(path.join(out,'native.log'),'w');
const env={...process.env,NAYAN_TEST_PROFILE:root,NAYAN_TEST_UI_DIR:path.resolve('app/ui'),NAYAN_TEST_PORT:String(port),NAYAN_TEST_RUN_ID:record.run,NAYAN_NATIVE_MODE:mode};
const child=spawn(bin,[],{env});bindChild(record,child);for(const s of[child.stdout,child.stderr])s.on('data',d=>fs.writeSync(fd,d));
let faultFired=false,checkpoint=null;
const timer=setInterval(()=>loads.push({at_utc:new Date().toISOString(),value:os.loadavg()}),1000);
const faultTimer=setInterval(()=>{
 if(faultFired)return;
 if(fault==='evidence'&&fs.existsSync(path.join(root,'native-isolation.json'))){fs.mkdirSync(path.join(root,'native-result.json'));faultFired=true;}
 if(mode==='interrupt'&&fs.existsSync(path.join(root,'native-checkpoint.json'))){checkpoint=JSON.parse(fs.readFileSync(path.join(root,'native-checkpoint.json')));if(checkpoint.run===record.run&&checkpoint.pid===child.pid&&checkpoint.value.inProgress&&checkpoint.value.connected){faultFired=true;child.kill('SIGKILL');}}
},10);
const termination=await waitChild(child,mode==='perform'?240000:90000);clearInterval(timer);clearInterval(faultTimer);fs.closeSync(fd);
let exit=0,error=null,result=null,isolation=null,gate=null;
const wrote=fs.existsSync(path.join(root,'native-result.json'))&&fs.statSync(path.join(root,'native-result.json')).isFile();
if(wrote){result=JSON.parse(fs.readFileSync(path.join(root,'native-result.json')));fs.copyFileSync(path.join(root,'native-result.json'),path.join(out,'native-result.json'));}
if(fs.existsSync(path.join(root,'native-isolation.json'))){isolation=JSON.parse(fs.readFileSync(path.join(root,'native-isolation.json')));fs.copyFileSync(path.join(root,'native-isolation.json'),path.join(out,'native-isolation.json'));}
try{
 if(termination.code!==0||termination.signal||termination.timedOut)throw Error('native termination '+JSON.stringify(termination));
 if(!wrote||!result||result.pid!==child.pid||result.run!==record.run)throw Error('missing/wrong-run result');
 if(!isolation||isolation.pid!==child.pid||isolation.root!==root||isolation.nonPersistent!==true)throw Error('WK DataStore not proved nonPersistent');
 if(result.js.error||!result.js.checks.length||result.js.checks.some(r=>!r.ok)||result.js.errors.length)throw Error('native JS/DOM check failed '+JSON.stringify(result.js.error||result.js.errors));
 if(!Array.isArray(result.ipc)||!result.ipc.length||result.ipc.some((e,i)=>e.seq!==i||typeof e.phase!=='string')||result.ipc.at(-1).cmd!=='native_result')throw Error('native IPC evidence missing/incomplete');
 const allowed=e=>['native_phase','native_result','js_log','own_icon','app_icon'].includes(e.cmd)||(e.cmd==='api'&&e.method==='GET'&&(/^\/api\/suggestions(?:\/\d+(?:\/(content|reader|attachments))?)?$/.test(e.path)||['/api/session-aliases','/api/settings'].includes(e.path)));
 const unauthorized=result.ipc.filter(e=>e.phase==='hostile-window'&&!allowed(e));
 const external=result.js.net.filter(e=>e.phase==='hostile-window');
 if(mode==='gate-native'){if(unauthorized.length!==1||unauthorized[0].cmd!=='open_path')throw Error('native gate blind/unexpected');exit=7;}
 else if(mode==='gate-net'){if(!external.some(e=>e.type==='fetch')||!external.some(e=>e.type==='img-src'))throw Error('net gate blind');exit=8;}
 else if(unauthorized.length||external.length)throw Error('unauthorized body native/network activity');
 if(mode==='perform'){
  const rows=result.js.perf,dir='docs/implementation-plan-2026-09-23/batches/P1-B06-PERF-01/evidence';
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'fixtures-manifest.json')));
  if(rows.length!==4)throw Error('four fixtures required');
  for(let i=0;i<4;i++){
   const m=manifest.fixtures[i],f=rows[i],text=fs.readFileSync(path.join(dir,`fixture-${i}-${m.label}.txt`),'utf8');
   if(crypto.createHash('sha256').update(text).digest('hex')!==m.sha256||Buffer.byteLength(text)!==m.utf8_bytes)throw Error('frozen fixture drift');
   if(f.label!==m.label||f.bytes!==m.utf8_bytes||f.blocks!==m.blocks_declared||f.trials.length!==31||f.trials.some(t=>t.headings!==f.blocks*2||t.fences!==f.blocks))throw Error('fixture metadata/DOM structure mismatch');
   const c=result.stored.map(r=>r.content_envelope&&JSON.parse(r.content_envelope)).find(c=>c&&c.request_id==='wk-'+m.label);
   const stored=result.stored.find(r=>r.content_envelope&&JSON.parse(r.content_envelope).request_id==='wk-'+m.label);
   if(!c||c.original.text!==text||c.canonical!==text.replace(/\r\n?/g,'\n')||stored.quote!==c.canonical)throw Error('fixture DB exact body mismatch');
  }
  gate=evaluatePerformanceGate(rows);if(gate.gateFail)throw Error('WK performance FAIL '+JSON.stringify(gate.failures));
 }
 if(mode.startsWith('inject-')){
  const r=result.js.injection;if(!r)throw Error('injection result missing');
  const expected=1201;
  const attribution=detectInjectionAttribution(r.injected.samples,r.injected.injectionWindow?.start,r.injected.injectionWindow?.end);
  const controlValid=validateTrial(r.control,expected)===null;const injectedValid=validateTrial(r.injected,expected)===null;
  const verdict={position:r.position,controlValid,controlGatePassed:r.control.maxDrift<=100,injectedValid,attribution};
  gate=verdict;exit=classifyInjectRun({thrown:null,controlValid,injectedValid,controlGatePassed:verdict.controlGatePassed,attributed:attribution.caught,evidenceWritten:true,cleanupOk:true}).code;
 }
 // Independent stored-envelope body checks; these are test-side expectations, not renderer output.
 for(const row of result.stored){if(!row.content_envelope)continue;const c=JSON.parse(row.content_envelope);if(c.original.kind==='text'&&c.canonical!==c.original.text.replace(/\r\n?/g,'\n'))throw Error('stored canonical mismatch');}
}catch(e){exit=termination.code===4?4:1;error=String(e);}
fs.writeFileSync(path.join(out,'run-result.json'),JSON.stringify({phase:'pre-cleanup',start,end:new Date().toISOString(),mode,fault,faultFired,checkpoint,binSha:sha(bin),record,termination,exit,error,wrote,isolation,gate,hardware:{cpu:os.cpus()[0].model,cores:os.cpus().length,node:process.version},load:loads},null,2));
// Archive the synthetic DB/logs before removing; cleanup itself must be truthful.
for(const n of fs.readdirSync(root)){if(n.startsWith('inbox.db')||n==='nayan.log')fs.copyFileSync(path.join(root,n),path.join(out,n));}
try{if(fault==='evidence'){throw Error('native evidence failed; root retained for investigation');}cleanRoot(record,fault==='cleanup'?()=>{faultFired=true;throw Error('controlled owned-root remove failure');}:fs.rmSync);fs.writeFileSync(path.join(out,'cleanup.json'),JSON.stringify({ok:true,record,rootRemoved:!fs.existsSync(root)},null,2));}
catch(e){fs.writeFileSync(path.join(out,'cleanup.json'),JSON.stringify({ok:false,record,error:String(e),faultFired},null,2));exit=fault==='evidence'?4:5;}
// Authoritative post-cleanup verdict; the earlier snapshot is explicitly pre-cleanup.
fs.writeFileSync(path.join(out,'final-status.json'),JSON.stringify({at_utc:new Date().toISOString(),mode,fault,exit,error,termination,evidenceWritten:wrote,rootRemoved:!fs.existsSync(root),record},null,2),{flag:'wx'});
console.log(JSON.stringify({mode,exit,error,gate,checks:result&&result.js.checks.length,nonPersistent:isolation&&isolation.nonPersistent}));process.exit(exit);
