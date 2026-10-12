// tests/renderer/nayan-reader-view/pre-repair-r2.test.mjs — P1-B06-READER-CONTRACT-REPAIR-02 / Step 1
// Real-page pre-repair counterexamples for RC-R1-F01/F02/F03 (run against the UNREPAIRED product
// to prove each failure is real; the same script is re-run after Step 2 with identical expectations).
// Real index.html bindEntry/fillReaderBody/renderer/sidecar run unmodified; stub fakes only data/API.
// Usage: node tests/renderer/nayan-reader-view/pre-repair-r2.test.mjs --out DIR [--label pre|post]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from '../cdp.mjs';
import { ownRoot, bindChild, finishRun } from '../tauri-asset-smoke/lifecycle.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIR = path.join(REPO, 'app/ui');
const args = process.argv.slice(2), argOf = k => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out'); if (!outDir) throw Error('--out required');
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw Error('nonempty --out refused (fail-closed)');
fs.mkdirSync(outDir, { recursive: true });
const label = argOf('--label') || 'unlabeled';
const results = []; let fail = 0;
const check = (c, n, ok, d = '') => { results.push({ case: c, name: n, ok, detail: String(d).slice(0, 400) }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${c}] ${n}${ok ? '' : '  <<< ' + String(d).slice(0, 260)}`); };

const DOC_A = '# A 文档\n\nA 正文。\n', DOC_B = '# B 文档\n\nB 正文。\n';
function env(text, req, format = 'markdown') {
  return { schema_version: 1, request_id: req, format, format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text }, fidelity: { truncated: false }, canonical: text.replace(/\r\n?/g, '\n'), canonical_unavailable_reason: null, plain_projection: { status: 'available', text: text.replace(/\r\n?/g, '\n') } };
}
function item(id, title) { return { id, title, quote: '', source_tool: 't', workspace: 'W', kind: 'plain', steps: [], created_at: '', status: 'inbox' }; }
const registry = new Map();
const route = {
  readerDelay: new Map(),        // id -> ms delay for /reader (uniform)
  script: new Map(),             // id -> [{delay,req}] consumed per call (request-slot regen)
  readerReqs: [],                // request log of {id, at, req}
  reader404Ids: new Set(),       // ids that return 404 not-found on /reader
  compatMode: 'ok',              // ok | forged | empty | badenvelope | wrongid
  contentCalls: 0,
};
registry.set(101, { item: item(101, 'row-A'), env: env(DOC_A, 'req-a') });
registry.set(102, { item: item(102, 'row-B'), env: env(DOC_B, 'req-b') });
const FORGED = env('# SOURCE 原文', 'req-forged');
const FORGED_ENV = { ...FORGED, original: { kind: 'text', text: '# SOURCE 原文' }, canonical: '# FORGED 伪造' };
registry.set(201, { item: item(201, 'forged'), env: FORGED_ENV });

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (!url.startsWith('/api/')) {
    const file = path.normalize(path.join(UI_DIR, url === '/' ? '/index.html' : url));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    const mime = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': mime }); res.end(fs.readFileSync(file)); return;
  }
  const mr = /^\/api\/suggestions\/(\d+)\/reader$/.exec(url);
  if (mr && req.method === 'GET') {
    const id = Number(mr[1]);
    const scripted = route.script.get(id);
    const step = scripted ? scripted.shift() : null;
    route.readerReqs.push({ id, at: Date.now(), req: step ? step.req : 'req-a' });
    const respond = () => {
      if (route.reader404Ids.has(id)) return send(404, { error: 'not found' });
      const r = registry.get(id); if (!r) return send(404, { error: 'reader: no such item' });
      const e = r.env;
      const rid = step ? step.req : e.request_id;
      return send(200, { reader_view_version: 1, id, request_id: rid, format: e.format, format_provenance: e.format_provenance, original_kind: e.original.kind, truncated: false, canonical: e.canonical, canonical_unavailable_reason: null });
    };
    const d = step ? step.delay : (route.readerDelay.get(id) || 0);
    if (d > 0) return setTimeout(respond, d);
    return respond();
  }
  const m = /^\/api\/suggestions\/(\d+)\/content$/.exec(url);
  if (m && req.method === 'GET') {
    route.contentCalls++;
    const id = Number(m[1]); const r = registry.get(id); if (!r) return send(404, { error: 'not found' });
    if (route.compatMode === 'empty') return send(200, {});
    if (route.compatMode === 'badenvelope') return send(200, { id, legacy: false, quote: '', envelope_json: '{not json', content: null });
    if (route.compatMode === 'wrongid') return send(200, { id: 999999, legacy: true, quote: '# X\n', envelope_json: null, content: null });
    return send(200, { id, legacy: !r.env, quote: r.env ? r.env.canonical : (r.quote || ''), envelope_json: r.env ? JSON.stringify(r.env) : null, content: null });
  }
  if (url === '/api/suggestions' && req.method === 'GET') return send(200, [...registry.values()].map((r) => r.item));
  if (url === '/api/session-aliases') return send(200, []);
  if (url === '/api/settings') return send(200, {});
  return send(200, {});
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;

const chromeProc = await startChrome();
const ownedProfile = ownRoot(chromeProc.profile); bindChild(ownedProfile, chromeProc.child);
let cdp; let thrown = null;
try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.go(base + '/index.html');
  await cdp.eval(`window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));`);
  await cdp.eval(`(async () => { for (let i = 0; i < 600 && typeof state === 'undefined'; i++) await window.__sleep(50); for (let i = 0; i < 400 && !(state.items && state.items.length); i++) await window.__sleep(5); return 1; })()`);
  const snap = `(() => { const el = document.getElementById('aibody'); const d = el && el.__nayanDecision; return { text: el ? el.textContent.slice(0, 60) : null, req: el && el.__nayanIdentity ? el.__nayanIdentity.requestId : null, itemId: el && el.__nayanIdentity ? el.__nayanIdentity.itemId : null, renderable: d && d.renderable, reason: d && d.reason, sidecar: !!(el && el.__nayanSourceMap) }; })()`;
  // same-DOM double bindEntry: bindEntry does NOT rebuild the detail DOM; gid('aibody') is the same element.
  const bodyInfo = () => cdp.eval(snap);

  // ---- X1: cross-item late arrival on the SAME bodyEl ----
  // Older item (101) binds/binds first with a delayed reader response; the newer selection
  // (102) binds second and answers fast. The late 101 must never overwrite the newer slot.
  route.readerDelay.set(101, 900); route.readerDelay.set(102, 0);
  // Build the detail pane skeleton once, then double-bindEntry on the SAME DOM (no rebuild).
  await cdp.eval(`(async () => { state.sel = 101; renderDetail(); return 1; })()`);
  await cdp.eval(`(async () => { const itA = findItem(101), itB = findItem(102); bindEntry(itA); bindEntry(itB); return 1; })()`);
  await cdp.eval(`(async () => await window.__sleep(300))()`); // 102 answered, 101 still in flight
  const mid = await bodyInfo();
  check('X1', 'control: newer item(102) published first', mid.itemId === 102 && mid.req === 'req-b', JSON.stringify(mid));
  if (mid.itemId !== 102) { /* diagnostic only */ }
  await cdp.eval(`(async () => await window.__sleep(900))()`); // 101 arrives late
  const x1 = await bodyInfo();
  check('X1', 'late 101 must NOT overwrite 102 (identity/decision/DOM/map)', x1.itemId === 102 && x1.req === 'req-b' && !/A 文档/.test(x1.text || ''), JSON.stringify(x1));
  route.readerDelay.clear();

  // ---- X2: same item, request-slot regeneration (old request answered AFTER new) ----
  const it101 = `findItem(101)`;
  route.readerReqs.length = 0;
  route.script.set(101, [{ delay: 700, req: 'req-old' }, { delay: 0, req: 'req-new' }]);
  await cdp.eval(`(async () => { const it = ${it101}; bindEntry(it); bindEntry(it); return 1; })()`); // same DOM, slot regen
  await cdp.eval(`(async () => await window.__sleep(300))()`);
  const x2mid = await bodyInfo();
  // Chrome serializes concurrent same-URL GETs, so at 300ms neither scripted response may have
  // landed; the mid snapshot only asserts the pane still shows the same item (no crash/rebuild).
  check('X2', 'control: same item still shown mid-flight', x2mid.itemId === 101, JSON.stringify(x2mid));
  await cdp.eval(`(async () => await window.__sleep(800))()`);
  const x2 = await bodyInfo();
  const reqs = route.readerReqs.filter((r) => r.id === 101);
  check('X2', 'two same-item reader calls observed (no cache merge)', reqs.length === 2 && reqs[0].req === 'req-old' && reqs[1].req === 'req-new', JSON.stringify(reqs));
  check('X2', 'late req-old must NOT overwrite the newer req-new slot', x2.itemId === 101 && x2.req === 'req-new', JSON.stringify(x2));
  route.script.delete(101);

  // ---- X3: forged compat envelope ----
  // With ambiguous-404 no longer falling back (RC-R1-F03 fix), the forged body cannot reach the
  // DOM through the live chain. The REAL product helper readerCompatDecision must independently
  // reject the inconsistent envelope (canonical≠canonicalize(original)) — tested in-page directly.
  route.reader404Ids.add(201); route.compatMode = 'forged';
  await cdp.eval(`(async () => { const it = findItem(201); bindEntry(it); return 1; })()`);
  await cdp.eval(`(async () => await window.__sleep(400))()`);
  const x3 = await bodyInfo();
  check('X3', 'reader 404 -> explicit unavailable (no forged chain)', x3.renderable === false && !/FORGED/.test(x3.text || ''), JSON.stringify(x3));
  const x3h = await cdp.eval(`(() => {
    const forged = { schema_version: 1, request_id: 'req-forged', format: 'markdown', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: '# SOURCE 原文' }, fidelity: { truncated: false }, canonical: '# FORGED 伪造', canonical_unavailable_reason: null, plain_projection: { status: 'available', text: '# FORGED 伪造' } };
    const r = readerCompatDecision({ id: 201, legacy: false, quote: '', envelope_json: JSON.stringify(forged), content: null }, 201);
    return JSON.stringify({ renderable: r.decision.renderable, reason: r.decision.reason || '', req: r.requestId });
  })()`);
  const x3o = JSON.parse(x3h);
  check('X3', 'product helper rejects inconsistent envelope', x3o.renderable === false && /资格/.test(x3o.reason) && x3o.req === null, x3h);
  const x3legacy = await cdp.eval(`(() => {
    const r = readerCompatDecision({ id: 201, legacy: true, quote: 'legacy quote line', envelope_json: JSON.stringify({ schema_version: 1 }), content: null }, 201);
    return JSON.stringify({ renderable: r.decision.renderable, mode: r.decision.mode });
  })()`);
  const x3lo = JSON.parse(x3legacy);
  check('X3', 'legacy=true with structured envelope rejected', x3lo.renderable === false, x3legacy);
  route.reader404Ids.delete(201); route.compatMode = 'ok';

  // ---- X4: ambiguous 404 must be explicit unavailable WITHOUT /content fallback ----
  route.reader404Ids.add(101); route.contentCalls = 0;
  await cdp.eval(`(async () => { const it = findItem(101); bindEntry(it); return 1; })()`);
  await cdp.eval(`(async () => await window.__sleep(400))()`);
  const x4 = await bodyInfo();
  check('X4', 'ambiguous 404 -> explicit unavailable, NO /content fallback', x4.renderable === false && route.contentCalls === 0, JSON.stringify({ ...x4, contentCalls: route.contentCalls }));
  route.reader404Ids.delete(101);

  // ---- pure adapter negatives (real rich-text.js in VM) ----
  const src = fs.readFileSync(path.join(REPO, 'app/ui/rich-text.js'), 'utf8');
  const sb = { window: {}, console, Number, String, Object, Array, JSON, parseInt };
  sb.window = sb; vm.createContext(sb);
  vm.runInContext(src + '\n;globalThis.__x={readerViewToDecision};', sb);
  const rvd = sb.__x.readerViewToDecision;
  const GOOD = { reader_view_version: 1, id: 1, request_id: 'r', format: 'markdown', format_provenance: 'declared', original_kind: 'text', truncated: false, canonical: '# A\n', canonical_unavailable_reason: null };
  check('adapter', 'declared/text with request=null must be rejected', (() => { const d = rvd({ ...GOOD, request_id: null }); return d.renderable === false; })());
  check('adapter', 'prototype-inherited fields must be rejected', (() => { const o = Object.create({ reader_view_version: 1, id: 1, request_id: 'r', format: 'markdown', format_provenance: 'declared', original_kind: 'text', truncated: false, canonical: '# A\n', canonical_unavailable_reason: null }); const d = rvd(o); return d.renderable === false; })());
  check('adapter', 'missing reason field with null canonical rejected', (() => { const c = { ...GOOD, canonical: null }; delete c.canonical_unavailable_reason; const d = rvd(c); return d.renderable === false; })());
  check('adapter', 'normal control still renders', (() => { const d = rvd({ ...GOOD }); return d.renderable === true && d.text === '# A\n'; })());
  check('adapter', 'empty canonical still legal', (() => { const d = rvd({ ...GOOD, canonical: '' }); return d.renderable === true && d.text === ''; })());
} catch (e) { thrown = e; fail++; console.error(e); } finally {
  try { if (cdp) await cdp.close(); } catch (_) {}
  const status = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown, writeEvidence: (r2) => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(r2, null, 2)) });
  if (!status.ok) fail++;
  await new Promise((resolve) => server.close(resolve));
}
fs.writeFileSync(path.join(outDir, `results-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), total: results.length, fail, results }, null, 2));
console.log(`pre-repair-r2[${label}]: ${results.length - fail}/${results.length} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
