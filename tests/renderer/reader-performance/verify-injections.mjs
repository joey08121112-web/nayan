import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2),out=args[args.indexOf('--out')+1];
if(!out)throw Error('--out required');fs.mkdirSync(out,{recursive:true});
const rows=[];
for(const branch of ['auto','mc','timeout'])for(const position of ['early','mid','late']){
 const dir=path.join(out,branch+'-'+position);fs.mkdirSync(dir,{recursive:true});
 const child=spawn(process.execPath,['tests/renderer/reader-performance/run-command.mjs','--ledger',path.join(out,'commands.jsonl'),
  '--log',path.join(dir,'run.log'),'--','tests/renderer/reader-performance.test.mjs','--out',dir,'--branch',branch,'--inject',position],{stdio:'ignore'});
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
 const d=JSON.parse(fs.readFileSync(path.join(dir,'inject-'+position+'.json'),'utf8'));
 const events=d.injected.events;
 const start=events.findIndex(e=>e.type==='inject-start'),end=events.findIndex(e=>e.type==='inject-end');
 const isLate=position==='late';
 const prior=events.slice(0,start).some(e=>e.type===(isLate?'render-settled':'yield-resolved'));
 const after=events.slice(end+1).some(e=>e.type===(isLate?'sidecar-end':'render-resume'));
 const via=isLate?'completion':branch==='auto'?'scheduler':branch==='mc'?'mc':'setTimeout';
 const ok=exit.code===3&&exit.signal===null&&d.controlValid===true&&d.injectedValid===true&&d.attributed===true
  && start>=0&&end>start&&prior&&after&&d.injected.injectedVia===via;
 rows.push({branch,position,...exit,ok,prior,after,via,controlMaxDrift:d.control.maxDrift,attribution:d.attribution});
 console.log(`${ok?'PASS':'FAIL'} ${branch}/${position}: exit${exit.code}`);
}
fs.writeFileSync(path.join(out,'injection-matrix.json'),JSON.stringify({at_utc:new Date().toISOString(),rows},null,2));
process.exit(rows.every(r=>r.ok)?0:1);
