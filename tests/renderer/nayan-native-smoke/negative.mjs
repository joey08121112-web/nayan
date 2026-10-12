import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import {createRoot,bindChild,waitChild,cleanRoot} from '../tauri-asset-smoke/lifecycle.mjs';
const args=process.argv.slice(2),outOpt=args.indexOf('--out');
if(outOpt<0||!args[outOpt+1]||args[outOpt+1].startsWith('--'))throw Error('--out required (value must follow)');
const { parseArgs, preflightOut, BATCH_DIR }=await import('../nayan-reader-view/preflight-lib.mjs');
parseArgs(args,{'--out':'value'});
preflightOut(args[outOpt+1],BATCH_DIR);
const out=path.resolve(args[outOpt+1]);
// READER-CONTRACT-REPAIR-01: refuse nonempty/stale output BEFORE creating any root or spawning.
if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('nonempty output directory refused; preserve prior evidence');
fs.mkdirSync(out,{recursive:true});
const outMarker=path.join(out,'negative-run-owned.json');
fs.writeFileSync(outMarker,JSON.stringify({owner:'nayan-reader-regression',started_at:new Date().toISOString(),argv:process.argv.slice(2)}));
const bin=path.resolve('app/src-tauri/target/debug/nayan-native-verify'),results=[];
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for(const name of ['missing-marker','wrong-run','alias','live-pid','missing-test-intent','production-path']){
 const record=createRoot('nayan-native-negative-'),root=record.root,sentinel=path.join(root,'sentinel.txt');fs.writeFileSync(sentinel,'unchanged synthetic sentinel');const before=sha(sentinel);
 const marker={owner:'nayan-reader-regression',run_id:record.run,active_pid:null};if(name==='wrong-run')marker.run_id='wrong-run';if(name==='live-pid')marker.active_pid=process.pid;
 if(name!=='missing-marker')fs.writeFileSync(path.join(root,'nayan-test-owned.json'),JSON.stringify(marker));
 let alias=null,testRoot=root;if(name==='alias'){alias=createRoot('nayan-native-alias-');testRoot=path.join(alias.root,'via');fs.symlinkSync(root,testRoot);}
 const env={...process.env,NAYAN_TEST_PROFILE:testRoot,NAYAN_TEST_UI_DIR:path.resolve('app/ui'),NAYAN_TEST_PORT:'62011',NAYAN_TEST_RUN_ID:record.run,NAYAN_NATIVE_MODE:'isolation'};if(name==='production-path')env.NAYAN_TEST_PROFILE=path.join(os.homedir(),'Library/Application Support/com.nayan.app');if(name==='missing-test-intent')for(const k of['NAYAN_TEST_PROFILE','NAYAN_TEST_UI_DIR','NAYAN_TEST_PORT','NAYAN_TEST_RUN_ID'])delete env[k];
 const start=new Date().toISOString(),child=spawn(bin,[],{env});bindChild(record,child);let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const term=await waitChild(child,10000);
 const row={name,start,end:new Date().toISOString(),...term,sentinelUnchanged:sha(sentinel)===before,noDB:!fs.existsSync(path.join(root,'inbox.db')),noNativeResult:!fs.existsSync(path.join(root,'native-isolation.json')),stdout,stderr};row.ok=term.code===78&&!term.signal&&row.sentinelUnchanged&&row.noDB&&row.noNativeResult;
 cleanRoot(record);if(alias)cleanRoot(alias);results.push(row);console.log(name,row.ok?'PASS':'FAIL');
}
const owned=createRoot('nayan-native-clean-gate-'),holder=spawn(process.execPath,['-e','process.stdin.resume()']);bindChild(owned,holder);
let liveRejected=false,wrongRunRejected=false;
try{cleanRoot(owned);}catch(e){liveRejected=String(e).includes('Child still alive');}
try{cleanRoot({...owned,run:'wrong-run'});}catch(e){wrongRunRejected=String(e).includes('marker mismatch');}
const closed=waitChild(holder,5000);holder.kill('SIGTERM');const stopped=await closed;cleanRoot(owned);
results.push({name:'owned-clean-live-and-wrong-run',ok:liveRejected&&wrongRunRejected&&!fs.existsSync(owned.root)&&!stopped.timedOut,liveRejected,wrongRunRejected,rootRemoved:!fs.existsSync(owned.root),stopped});
fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,allPass:results.every(x=>x.ok)},null,2));process.exit(results.every(x=>x.ok)?0:1);
