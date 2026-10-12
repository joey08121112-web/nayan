// P1-B06-NATIVE-PERF-REPAIR-01 / Step 3 — core regression driver.
// Product code is unchanged in this batch; runs the existing smoke-harness gates
// with the unchanged nayan-native-verify binary (sha must match NATIVE-VERIFY-01)
// and records command/UTC/exit/signal/load for every run into commands.jsonl.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
/* READER-CONTRACT-REPAIR-05 / RC-R4-F02: the authoritative batch scope comes from the shared
   preflight-lib trusted constant (NOT from --evidence/--out/env-derived parents). Full strict
   parameter parsing and the one-shot read-only preflight happen before any side effect. */
const args=process.argv.slice(2);
if(args.includes('--resume-from'))throw Error('--resume-from is removed: the driver must run the complete fixed 11 rounds; resuming/partial ledgers are forbidden');
const { parseArgs, preflightOut, BATCH_DIR }=await import('../nayan-reader-view/preflight-lib.mjs');
const parsed=parseArgs(args,{'--out':'value','--bin-sha':'value','--evidence':'value'});
const out=path.resolve(parsed['--out']);
const binShaArg=parsed['--bin-sha'];
const E=parsed['--evidence'];
const repo=process.cwd();
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const bin=path.resolve('app/src-tauri/target/debug/nayan-native-verify');
if(!/^[0-9a-f]{64}$/.test(binShaArg))throw Error('--bin-sha must be a full 64-hex sha256');
if(sha(bin)!==binShaArg)throw Error('verify binary sha mismatch: '+sha(bin)+' expected '+binShaArg);
const THIS_BATCH=BATCH_DIR; // trusted constant, never derived from caller input
const { noSymlinkAncestors, lstatNoFollow }=await import('../nayan-reader-view/preflight-lib.mjs');
function validateLedgerOut(abs){
  const rel=path.relative(THIS_BATCH,abs);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('preflight: ledger --out must be inside '+THIS_BATCH+' — refused: '+abs);
  noSymlinkAncestors(abs);
  const t=lstatNoFollow(abs);
  if(!t.absent){
    if(t.st.isSymbolicLink())throw Error('preflight: ledger --out is a symlink: '+abs);
    if(!t.st.isDirectory())throw Error('preflight: ledger --out not a directory: '+abs);
    if(fs.readdirSync(abs).length)throw Error('preflight: ledger --out nonempty refused: '+abs);
  }
}
const EVROOT=path.resolve(E);
function preflightTarget(p){
  const abs=path.resolve(p);
  const rel=path.relative(THIS_BATCH,abs);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('preflight: target outside this batch refused: '+abs);
  noSymlinkAncestors(abs);
  const t=lstatNoFollow(abs);
  if(!t.absent){
    if(t.st.isSymbolicLink())throw Error('preflight: symlink target refused: '+abs);
    if(!t.st.isDirectory())throw Error('preflight: target not a directory: '+abs);
    if(fs.readdirSync(abs).length)throw Error('preflight: nonempty target refused: '+abs);
  }
  return abs;
}
/* --resume-from removed (R5): the driver always runs the complete fixed 11 rounds. */
const runs=[
 {name:'smoke-final5',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','smoke','--out',`${E}/step3-smoke-final5`]},
 {name:'negative-final5',cmd:['node','tests/renderer/nayan-native-smoke/negative.mjs','--out',`${E}/step3-negative-final5`]},
 {name:'gate-native-final5',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','gate-native','--out',`${E}/step3-gate-native-final5`],expect:7},
 {name:'gate-net-final5',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','gate-net','--out',`${E}/step3-gate-net-final5`],expect:8},
 {name:'inject-early-final5',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','inject-early','--out',`${E}/step3-inject-early-final5`],expect:3},
 {name:'inject-mid-final5',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','inject-mid','--out',`${E}/step3-inject-mid-final5`],expect:3},
 {name:'inject-late-final5',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','inject-late','--out',`${E}/step3-inject-late-final5`],expect:3},
 {name:'interrupt-final5',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','interrupt','--out',`${E}/step3-interrupt-final5`],expect:1},
 {name:'fault-evidence-close',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','smoke','--fault','evidence','--out',`${E}/step3-fault-evidence-close`],expect:4},
 {name:'fault-cleanup-close',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','smoke','--fault','cleanup','--out',`${E}/step3-fault-cleanup-close`],expect:5},
 {name:'normal-close',cmd:['node','tests/renderer/nayan-native-smoke/run.mjs','--mode','smoke','--out',`${E}/step3-normal-close`],expect:0},
];
// One-shot preflight: ledger --out + evidence root + every run target (+ ancestors), BEFORE any side effect.
{
  validateLedgerOut(out);
  if(!fs.existsSync(EVROOT))throw Error('preflight: evidence root missing (create the batch evidence dir first): '+EVROOT);
  if(fs.lstatSync(EVROOT).isSymbolicLink())throw Error('preflight: evidence root is a symlink: '+EVROOT);
  {
    const evRel=path.relative(THIS_BATCH,EVROOT);
    if(evRel.startsWith('..')||path.isAbsolute(evRel))throw Error('preflight: evidence root must be inside this batch directory: '+EVROOT);
  }
  for(const r of runs){ const oi=r.cmd.indexOf('--out'); preflightTarget(r.cmd[oi+1]); }
  // rewritten runs target the authoritative root, regardless of the caller-supplied value:
  for(const r of runs){ const oi=r.cmd.indexOf('--out'); r.cmd[oi+1]=path.join(EVROOT, path.basename(r.cmd[oi+1])); }
}
fs.mkdirSync(out,{recursive:true}); // first and only early side effect, after full preflight
const ledger=[];
const loadTick=setInterval(()=>{ledger.forEach(r=>{if(!r.done)r.load.push({at_utc:new Date().toISOString(),value:os.loadavg()});});},1000);
runs.forEach((r,i)=>{r.expect=r.expect==null?0:r.expect;});
for(let i=0;i<runs.length;i++){
 const r=runs[i];
 const row={name:r.name,cmd:r.cmd,start_utc:new Date().toISOString(),load:[],done:false};ledger.push(row);
 {const oi=r.cmd.indexOf('--out');fs.mkdirSync(path.join(repo,r.cmd[oi+1]),{recursive:true});}
 await new Promise(res=>{
  // RC-R3-F04: full per-child logs (files + sha), cwd and explicit env overrides in the ledger.
  const safeName=r.name;
  const outFilePath=path.join(out,`${safeName}.runner-stdout.log`);
  const errFilePath=path.join(out,`${safeName}.runner-stderr.log`);
  const childOut=fs.openSync(outFilePath,'w');const childErr=fs.openSync(errFilePath,'w');
  const childEnv={...process.env,NAYAN_R4_EVIDENCE_ROOT:EVROOT}; // authoritative batch output scope for children
  row.pre_source_hashes={};for(const f of ['app/src-tauri/src/main.rs','app/ui/rich-text.js','app/ui/index.html','tests/renderer/nayan-native-smoke/run.mjs','tests/renderer/nayan-native-smoke/negative.mjs','tests/renderer/reader-performance/gate.mjs'])row.pre_source_hashes[f]=sha(path.join(repo,f));
  const envOverrides={NAYAN_R4_EVIDENCE_ROOT:EVROOT};

  row.cwd=repo;row.env_overrides=envOverrides;row.stdout_file=outFilePath;row.stderr_file=errFilePath;
  const child=spawn(r.cmd[0],r.cmd.slice(1),{cwd:repo,env:childEnv},()=>{});
  child.stdout.on('data',d=>fs.writeSync(childOut,d));
  child.stderr.on('data',d=>fs.writeSync(childErr,d));
  child.on('close',(exit,signal)=>{fs.closeSync(childOut);fs.closeSync(childErr);
    row.exit=exit;row.signal=signal;row.end_utc=new Date().toISOString();
    row.stdout_file_sha=sha(outFilePath);row.stderr_file_sha=sha(errFilePath);
    row.stdout_bytes=fs.statSync(outFilePath).size;row.stderr_bytes=fs.statSync(errFilePath).size;
    row.ok=(exit===r.expect);row.done=true;res();});
 });
 console.log(r.name,row.ok?'PASS':'FAIL','exit='+row.exit,'expect='+r.expect);
}

clearInterval(loadTick);
fs.writeFileSync(path.join(out,'commands.jsonl'),ledger.map(r=>JSON.stringify(r)).join('\n')+'\n');
const summary={at_utc:new Date().toISOString(),binSha:sha(bin),runs:ledger.map(r=>({name:r.name,exit:r.exit,signal:r.signal,ok:r.ok,start:r.start_utc,end:r.end_utc})),allPass:ledger.every(r=>r.ok)};
fs.writeFileSync(path.join(out,'step3-summary.json'),JSON.stringify(summary,null,2));
console.log('ALL',summary.allPass?'PASS':'FAIL');
process.exit(summary.allPass?0:1);
