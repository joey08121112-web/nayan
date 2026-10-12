import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const i=process.argv.indexOf('--out');
if(i<0||!process.argv[i+1])throw Error('--out required');
const out=process.argv[i+1];fs.mkdirSync(out,{recursive:true});
const source=fs.readFileSync('app/ui/rich-source-map.js','utf8');
const anchor='var env = {}, tokens = md.parse(source, env);';
assert.equal(source.split(anchor).length,2,'Exactly one actual parser call anchor');
// Actual product code and parser; the sole instrumentation counts real misses.
// It does not wrap/replace the parser function or alter cache eligibility.
const instrumented=source.replace(anchor,'globalRef.__actualParses++; '+anchor);
function context(){
 const sb={console,__actualParses:0,atob:s=>Buffer.from(s,'base64').toString('binary'),
   btoa:s=>Buffer.from(s,'binary').toString('base64')};sb.window=sb;sb.self=sb;vm.createContext(sb);
 vm.runInContext(fs.readFileSync('app/ui/vendor/markdown-it.umd.min.js','utf8'),sb);
 vm.runInContext(instrumented,sb);return sb;
}
const decision=text=>({text,mode:'markdown',format:'markdown',provenance:'declared',renderable:true});
const id={itemId:1,requestId:'cache-1',revision:null};
const text='# Heading\n\n[label][ref]\n\n[ref]: https://example.invalid/\n\n```js\n  let x = 1;\n```\n';
const rows=[];
function test(label,fn){fn();rows.push({label,ok:true});console.log('PASS '+label);}
test('Fresh independent token/env copies; current identity and immutable ranges',()=>{
 const sb=context(),d=decision(text),a=sb.NaYanSourceSpans.prepare(d,id);
 const entries=JSON.stringify(a.sidecar.entries());
 for(const t of a.tokens){t.content='tampered';if(t.map)t.map[0]=999;if(t.children)for(const c of t.children)c.content='tampered';if(t.attrs)t.attrs.push(['onclick','bad']);}
 a.env.references.REF.href='https://changed.invalid/';
 const other={itemId:2,requestId:'cache-2',revision:'r2'},b=sb.NaYanSourceSpans.prepare(d,other);
 assert.equal(sb.__actualParses,1);assert.notEqual(a.tokens,b.tokens);assert.notEqual(a.env,b.env);
 assert.equal(b.env.references.REF.href,'https://example.invalid/');assert.equal(JSON.stringify(b.sidecar.entries()),entries);
 assert.equal(b.sidecar.check(d,id),false);assert.equal(b.sidecar.check(d,other),true);
 assert.equal(sb.__nayanSourceMapMD.renderer.render(b.tokens,sb.__nayanSourceMapMD.options,b.env).includes('tampered'),false);
 for(const e of b.sidecar.entries().filter(e=>e.available))assert.equal(b.sidecar.slice(e.id,d,other).text,text.slice(e.start,e.end));
});
test('Exact source; same-length changed text and replacement evict',()=>{
 const sb=context(),a=decision(text),b=decision(text.replace('Heading','Another'));
 sb.NaYanSourceSpans.prepare(a,id);const changed=sb.NaYanSourceSpans.prepare(b,id);assert.equal(sb.__actualParses,2);
 assert.equal(changed.sidecar.check(a,id),false);sb.NaYanSourceSpans.prepare(a,id);assert.equal(sb.__actualParses,3);
});
test('Options and built-in rule changes invalidate',()=>{
 const sb=context(),d=decision(text);sb.NaYanSourceSpans.prepare(d,id);const md=sb.__nayanSourceMapMD;
 md.options.breaks=true;sb.NaYanSourceSpans.prepare(d,id);assert.equal(sb.__actualParses,2);
 md.block.ruler.disable('heading');const p=sb.NaYanSourceSpans.prepare(d,id);assert.equal(sb.__actualParses,3);
 assert.equal(p.sidecar.entries().filter(e=>e.kind==='section').length,0);
 md.block.ruler.enable('heading');sb.NaYanSourceSpans.prepare(d,id);assert.equal(sb.__actualParses,4);
});
test('Foreign parser/wrapper never cached, dynamic failure still observed',()=>{
 const sb=context(),d=decision(text);sb.NaYanSourceSpans.prepare(d,id);const md=sb.__nayanSourceMapMD,original=md.parse;let fail=false;
 md.parse=function(...args){if(fail)throw Error('dynamic parse failure');return original.apply(this,args);};
 sb.NaYanSourceSpans.prepare(d,id);sb.NaYanSourceSpans.prepare(d,id);assert.equal(sb.__actualParses,3);
 fail=true;assert.equal(sb.NaYanSourceSpans.prepare(d,id).sidecar.__unavailable,true);assert.equal(sb.__actualParses,4);
});
test('Foreign plugin callback is not memoized',()=>{
 const sb=context(),d=decision(text);sb.NaYanSourceSpans.prepare(d,id);let callbacks=0;
 sb.__nayanSourceMapMD.core.ruler.push('test-callback',()=>{callbacks++;});
 sb.NaYanSourceSpans.prepare(d,id);sb.NaYanSourceSpans.prepare(d,id);assert.equal(callbacks,2);assert.equal(sb.__actualParses,3);
});
test('Source cap and large token tree retain uncached behavior',()=>{
 for(const text of ['a'.repeat(1024*1024+1),'# H\n\n'.repeat(4000),'**a** '.repeat(6000)]){
  const sb=context(),d=decision(text);sb.NaYanSourceSpans.prepare(d,id);sb.NaYanSourceSpans.prepare(d,id);assert.equal(sb.__actualParses,2);
 }
});
test('Reference environment remains safe and independently owned',()=>{
 const sb=context(),d=decision('[a][safe]\n\n[safe]: https://example.invalid/\n');
 const a=sb.NaYanSourceSpans.prepare(d,id),b=sb.NaYanSourceSpans.prepare(d,id);
 assert.notEqual(a.env.references,b.env.references);assert.equal(sb.__actualParses,1);
 Object.defineProperty(a.env,'__proto__',{value:{polluted:true},enumerable:true});
 assert.equal(sb.NaYanSourceSpans.prepare(d,id).env.polluted,undefined);
});
test('Large frozen ordinary fixture cached; dense fixture stays uncached',()=>{
 const base='docs/implementation-plan-2026-09-23/batches/P1-B06-PERF-01/evidence';
 const man=JSON.parse(fs.readFileSync(base+'/fixtures-manifest.json','utf8'));
 for(const label of ['ordinary-1048576','dense-1048576']){
  const idx=man.fixtures.findIndex(f=>f.label===label),sb=context(),d=decision(fs.readFileSync(base+'/fixture-'+idx+'-'+label+'.txt','utf8'));
  const a=sb.NaYanSourceSpans.prepare(d,id),b=sb.NaYanSourceSpans.prepare(d,id);
  assert.equal(sb.__actualParses,label.startsWith('ordinary')?1:2);assert.equal(JSON.stringify(a.sidecar.entries()),JSON.stringify(b.sidecar.entries()));
 }
});
test('Optional bootstrap failure leaves mapping available after parser recovery',()=>{
 const sb={console,__actualParses:0,atob:s=>Buffer.from(s,'base64').toString('binary')};sb.window=sb;sb.self=sb;vm.createContext(sb);
 vm.runInContext(fs.readFileSync('app/ui/vendor/markdown-it.umd.min.js','utf8'),sb);
 const original=sb.markdownit;sb.markdownit=()=>{throw Error('bootstrap fault');};
 vm.runInContext(instrumented,sb);assert.equal(typeof sb.NaYanSourceSpans.prepare,'function');
 sb.markdownit=original;assert.equal(sb.NaYanSourceSpans.prepare(decision(text),id).sidecar.check(decision(text),id),true);
});
fs.writeFileSync(path.join(out,'parse-cache-results.json'),JSON.stringify({ok:true,rows,sourceSha:crypto.createHash('sha256').update(source).digest('hex'),boundary:'VM imports actual product source and bundled parser. One exact call-site counter inserted only in this test; no public cache API or parser wrapper. Real renderer/performance tests separate.'},null,2));
