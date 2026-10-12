// P1-B06-NATIVE-PERF-REPAIR-01 / Step 1 — profiling run wrapper (mode=profile only).
// Spawns the profiling binary built by build.mjs against a fresh owned root,
// archives native-result/native-isolation/DB/logs and the load series.
// Diagnosis tool: no performance-gate verdict is produced here.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import net from 'node:net';import {spawn} from 'node:child_process';
import {createRoot,bindChild,waitChild,cleanRoot} from '../tauri-asset-smoke/lifecycle.mjs';
const args=process.argv.slice(2),option=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
const out=path.resolve(option('--out')||'');if(!option('--out'))throw Error('--out required');if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('nonempty output directory refused');fs.mkdirSync(out,{recursive:true});
const mode=option('--mode')||'profile';if(mode!=='profile')throw Error('profiling runner only accepts mode=profile');
const bin=path.resolve('app/src-tauri/target/debug/nayan-native-perf'),record=createRoot('nayan-native-perf-run-'),root=record.root;
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
fs.writeFileSync(path.join(root,'nayan-test-owned.json'),JSON.stringify({owner:'nayan-reader-regression',run_id:record.run,active_pid:null}));
const picker=net.createServer();await new Promise(r=>picker.listen(0,'127.0.0.1',r));const port=picker.address().port;await new Promise(r=>picker.close(r));
const start=new Date().toISOString(),loads=[{at_utc:start,value:os.loadavg()}],fd=fs.openSync(path.join(out,'native.log'),'w');
const env={...process.env,NAYAN_TEST_PROFILE:root,NAYAN_TEST_UI_DIR:path.resolve('app/ui'),NAYAN_TEST_PORT:String(port),NAYAN_TEST_RUN_ID:record.run,NAYAN_NATIVE_MODE:mode};
const child=spawn(bin,[],{env});bindChild(record,child);for(const s of[child.stdout,child.stderr])s.on('data',d=>fs.writeSync(fd,d));
const timer=setInterval(()=>loads.push({at_utc:new Date().toISOString(),value:os.loadavg()}),1000);
const termination=await waitChild(child,240000);clearInterval(timer);fs.closeSync(fd);
let exit=0,error=null,result=null,isolation=null;
const wrote=fs.existsSync(path.join(root,'native-result.json'))&&fs.statSync(path.join(root,'native-result.json')).isFile();
if(wrote){result=JSON.parse(fs.readFileSync(path.join(root,'native-result.json')));fs.copyFileSync(path.join(root,'native-result.json'),path.join(out,'native-result.json'));}
if(fs.existsSync(path.join(root,'native-isolation.json'))){isolation=JSON.parse(fs.readFileSync(path.join(root,'native-isolation.json')));fs.copyFileSync(path.join(root,'native-isolation.json'),path.join(out,'native-isolation.json'));}
try{
 if(termination.code!==0||termination.signal||termination.timedOut)throw Error('native termination '+JSON.stringify(termination));
 if(!wrote||!result||result.pid!==child.pid||result.run!==record.run)throw Error('missing/wrong-run result');
 if(!isolation||isolation.pid!==child.pid||isolation.root!==root||isolation.nonPersistent!==true)throw Error('WK DataStore not proved nonPersistent');
 if(result.js.error||!result.js.checks.length||result.js.checks.some(r=>!r.ok)||result.js.errors.length)throw Error('native JS/DOM check failed '+JSON.stringify(result.js.error||result.js.errors));
 if(!Array.isArray(result.js.perf)||result.js.perf.length!==4)throw Error('profile rows missing');
}catch(e){exit=1;error=String(e);}
fs.writeFileSync(path.join(out,'run-result.json'),JSON.stringify({start,end:new Date().toISOString(),mode,binSha:sha(bin),record,termination,exit,error,wrote,isolation,hardware:{cpu:os.cpus()[0].model,cores:os.cpus().length,node:process.version},load:loads},null,2));
for(const n of fs.readdirSync(root)){if(n.startsWith('inbox.db')||n==='nayan.log')fs.copyFileSync(path.join(root,n),path.join(out,n));}
try{cleanRoot(record);fs.writeFileSync(path.join(out,'cleanup.json'),JSON.stringify({ok:true,record,rootRemoved:!fs.existsSync(root)},null,2));}
catch(e){fs.writeFileSync(path.join(out,'cleanup.json'),JSON.stringify({ok:false,record,error:String(e)},null,2));exit=exit||5;}
console.log(JSON.stringify({mode,exit,error,checks:result&&result.js.checks.length,nonPersistent:isolation&&isolation.nonPersistent}));
process.exit(exit);
