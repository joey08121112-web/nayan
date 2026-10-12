// Exercise the real browser runner, real child exit and frozen owned-root lifecycle.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {cleanRoot} from '../tauri-asset-smoke/lifecycle.mjs';
const args=process.argv.slice(2),out=args[args.indexOf('--out')+1];
if(!out)throw Error('--out required');fs.mkdirSync(out,{recursive:true});
const results=[];
for(const [name,fault,expected] of [['normal',null,3],['evidence','evidence',4],['cleanup','cleanup',5],['blind','blind',7],['exception','exception',1]]){
 const dir=path.join(out,name);fs.mkdirSync(dir,{recursive:true});
 const argv=['tests/renderer/reader-performance/run-command.mjs','--ledger',path.join(out,'commands.jsonl'),
  '--log',path.join(dir,'run.log'),'--','tests/renderer/reader-performance.test.mjs','--out',dir,'--inject','early'];
 if(fault)argv.push('--fault',fault);
 const child=spawn(process.execPath,argv,{stdio:['ignore','pipe','pipe']});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',d=>output+=d);
 const actual=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(exit,signal)=>resolve({exit,signal}));});
 fs.writeFileSync(path.join(dir,'parent.log'),output);
 const cleanup=JSON.parse(fs.readFileSync(path.join(dir,'browser-cleanup.json'),'utf8'));
 const retained=cleanup.records.filter(r=>!r.cleaned&&fs.existsSync(r.root));
 let restored=true;
 for(const r of retained){cleanRoot(r);restored&&=!fs.existsSync(r.root);}
 const expectedRetained=['evidence','cleanup','exception'].includes(name);
 const ok=actual.exit===expected&&actual.signal===null&&restored
  && (expectedRetained?retained.length===1:cleanup.ok===true);
 const row={name,expected,...actual,ok,retainedBeforeRecovery:retained.length,recovered:restored,cleanup};
 results.push(row);console.log(`${ok?'PASS':'FAIL'} ${name}: expected=${expected} actual=${actual.exit}`);
}
fs.writeFileSync(path.join(out,'runner-faults.json'),JSON.stringify({at_utc:new Date().toISOString(),results},null,2));
process.exit(results.every(r=>r.ok)?0:1);
