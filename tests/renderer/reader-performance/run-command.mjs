// Record the actual child close result; no shell interpolation and no inferred exit codes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const argv=process.argv.slice(2),split=argv.indexOf('--');
const option=k=>{const i=argv.indexOf(k);return i>=0&&i<split?argv[i+1]:null;};
const ledger=option('--ledger'),log=option('--log');
if(split<0||!argv[split+1]||!ledger||!log)throw Error('Use --ledger FILE --log FILE -- SCRIPT [ARGS]');
fs.mkdirSync(path.dirname(log),{recursive:true});fs.mkdirSync(path.dirname(ledger),{recursive:true});
const hashes={};
for(const f of ['app/ui/index.html','app/ui/rich-text.js','app/ui/rich-source-map.js',
 'tests/renderer/reader-performance.test.mjs','tests/renderer/reader-performance/gate.mjs',
 'tests/renderer/reader-performance/run-command.mjs',argv[split+1]])
 if(fs.existsSync(f))hashes[f]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const record={start_utc:new Date().toISOString(),argv:[process.execPath,...argv.slice(split+1)],cwd:process.cwd(),
 sourceHashes:hashes,hardware:{cpu:os.cpus()[0].model,cores:os.cpus().length,node:process.version},
 load:[{at_utc:new Date().toISOString(),value:os.loadavg()}]};
const fd=fs.openSync(log,'w');
const child=spawn(process.execPath,argv.slice(split+1),{stdio:['ignore','pipe','pipe']});
record.pid=child.pid;
for(const stream of [child.stdout,child.stderr])stream.on('data',d=>fs.writeSync(fd,d));
const timer=setInterval(()=>record.load.push({at_utc:new Date().toISOString(),value:os.loadavg()}),1000);
let spawnError=null;child.on('error',e=>spawnError=String(e));
const result=await new Promise(resolve=>child.once('close',(exit,signal)=>resolve({exit,signal})));
clearInterval(timer);fs.closeSync(fd);
Object.assign(record,result,{end_utc:new Date().toISOString(),spawnError,log});
try{fs.appendFileSync(ledger,JSON.stringify(record)+'\n');}
catch(e){console.error('Command ledger write failed; child result:',record,String(e));process.exit(4);}
console.log(JSON.stringify({exit:record.exit,signal:record.signal,log,ledger}));
process.exit(spawnError||result.signal?1:(result.exit??1));
