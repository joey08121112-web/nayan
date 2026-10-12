import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const out=process.argv[process.argv.indexOf('--out')+1];if(!out)throw Error('--out required');fs.mkdirSync(out,{recursive:true});
const sb={console,atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64')};sb.window=sb;sb.self=sb;vm.createContext(sb);
for(const f of ['vendor/markdown-it.umd.min.js','rich-source-map.js'])vm.runInContext(fs.readFileSync('app/ui/'+f,'utf8'),sb);
const id=Object.freeze({itemId:1,requestId:'prepare',revision:null});
const base='docs/implementation-plan-2026-09-23/batches/P1-B06-PERF-01/evidence';
const man=JSON.parse(fs.readFileSync(base+'/fixtures-manifest.json','utf8'));
const examples=['# H\n\n![alt](https://example.invalid/a.png)\n\n```\n```\n','> ## container\n> ```js\n> a\n> ```\n','Setext\n======\n\n5. item\n   - sub\n'];
const fixtures=[...man.fixtures.map((f,i)=>({label:f.label,text:fs.readFileSync(base+'/fixture-'+i+'-'+f.label+'.txt','utf8')})),...examples.map((text,i)=>({label:'edge-'+i,text}))];
const rows=[];
for(const f of fixtures){
 const d={text:f.text,mode:'markdown',format:'markdown',provenance:'declared',renderable:true};
 const expected=sb.NaYanSourceSpans.build(d,id),gold=JSON.stringify(expected.entries());
 const parser=sb.__nayanSourceMapMD,orig=parser.parse;let calls=0;parser.parse=function(...args){calls++;return orig.apply(this,args);};
 const prepared=sb.NaYanSourceSpans.prepare(d,id);parser.parse=orig;
 const before=JSON.stringify(prepared.sidecar.entries());
 // Mutating renderer tokens after prepare must never change sealed source ranges/slices.
 for(const t of prepared.tokens){t.content='corrupt';if(t.map)t.map[0]=999999;t.info='corrupt';}
 const slices=prepared.sidecar.entries().filter(e=>e.available).every(e=>prepared.sidecar.slice(e.id,d,id).text===f.text.slice(e.start,e.end));
 const ok=calls===1&&gold===before&&JSON.stringify(prepared.sidecar.entries())===before&&slices&&prepared.sidecar.check(d,id)&&Object.isFrozen(prepared.sidecar.entries());
 const stale={...d,text:f.text+'changed'};
 const rejects=!prepared.sidecar.check(stale,id)&&prepared.sidecar.slice(1,stale,id).ok===false&&prepared.sidecar.slice(1,d,{...id,itemId:2}).ok===false;
 rows.push({label:f.label,calls,ok:ok&&rejects});console.log((ok&&rejects?'PASS':'FAIL')+' '+f.label);
}
fs.writeFileSync(path.join(out,'prepare-parity.json'),JSON.stringify({rows,ok:rows.every(r=>r.ok)},null,2));process.exit(rows.every(r=>r.ok)?0:1);
