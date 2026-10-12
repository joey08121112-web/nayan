// tests/renderer/nayan-reader-view/pre-repair-r3.test.mjs — P1-B06-READER-CONTRACT-REPAIR-03 / Step 1
// Pre-repair counterexamples for RC-R2-F01/F02 against the CURRENT (unrepaired-for-R3) product.
// The script file is archived with its hash BEFORE execution (see evidence/script-archive).
// Invariants are frozen here; the post-repair rerun must satisfy the SAME invariants.
// Usage: node tests/renderer/nayan-reader-view/pre-repair-r3.test.mjs --out DIR --label pre|post
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from '../cdp.mjs';
import { ownRoot, bindChild, finishRun } from '../tauri-asset-smoke/lifecycle.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIR = path.join(REPO, 'app/ui');
const args = process.argv.slice(2), argOf = k => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out'); if (!outDir) throw Error('--out required');
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw Error('nonempty --out refused');
fs.mkdirSync(outDir, { recursive: true });
const label = argOf('--label') || 'unlabeled';
const results = []; let fail = 0;
const check = (c, n, ok, d = '') => { results.push({ case: c, name: n, ok, detail: String(d).slice(0, 400) }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${c}] ${n}${ok ? '' : '  <<< ' + String(d).slice(0, 260)}`); };

const DOC = (t) => `# ${t}\n\n${t} 正文。\n`;
function env(text, req, format = 'markdown') {
  return { schema_version: 1, request_id: req, format, format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text }, fidelity: { truncated: false }, canonical: text.replace(/\r\n?/g, '\n'), canonical_unavailable_reason: null, plain_projection: { status: 'available', text: text.replace(/\r\n?/g, '\n') } };
}
function item(id, title) { return { id, title, quote: '', source_tool: 't', workspace: 'W', kind: 'plain', steps: [], created_at: '', status: 'inbox' }; }
const registry = new Map();
const route = { delay: new Map(), requests: [] };
// 101 STALE-A, 102 ITEM-B, 201 structured-legacy row (legacy_assumed_plain + NON-empty request)
registry.set(101, { item: item(101, 'stale-A'), env: env(DOC('STALE-A'), 'req-stale-a') });
registry.set(102, { item: item(102, 'item-B'), env: env(DOC('ITEM-B'), 'req-b') });
const SLEG = env('旧行 structured legacy\r\n第二行', 'req-structured-legacy');
SLEG.format_provenance = 'legacy_assumed_plain';
SLEG.format = 'plain';
registry.set(201, { item: item(201, 'slegacy'), env: SLEG });

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
    const id = Number(mr[1]); route.requests.push({ id, at: Date.now() });
    const respond = () => {
      const r = registry.get(id); if (!r) return send(404, { error: 'reader: no such item' });
      const e = r.env;
      return send(200, { reader_view_version: 1, id, request_id: e.request_id, format: e.format, format_provenance: e.format_provenance, original_kind: e.original.kind, truncated: false, canonical: e.canonical, canonical_unavailable_reason: null });
    };
    const d = route.delay.get(id) || 0;
    if (d > 0) return setTimeout(respond, d);
    return respond();
  }
  if (/^\/api\/suggestions\/(\d+)\/content$/.test(url)) { const r = registry.get(Number(url.split('/')[3])); return send(200, { id: Number(url.split('/')[3]), legacy: !r.env, quote: r.env ? r.env.canonical : '', envelope_json: r.env ? JSON.stringify(r.env) : null, content: null }); }
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
  const snap = `(() => { const el = document.getElementById('aibody'); const d = el && el.__nayanDecision; return { text: el ? el.textContent.slice(0, 40) : null, req: el && el.__nayanIdentity ? el.__nayanIdentity.requestId : null, itemId: el && el.__nayanIdentity ? el.__nayanIdentity.itemId : null, renderable: d && d.renderable, reason: d && d.reason, sidecar: !!(el && el.__nayanSourceMap) }; })`;
  const bodyInfo = () => cdp.eval(`(${snap})()`);

  // ---- Y1: selection changes (101 -> 102) with NO new bind; stale success must not publish ----
  route.delay.set(101, 700);
  await cdp.eval(`(async () => { state.sel = 101; renderDetail(); return 1; })()`); // real renderDetail binds 101 via selection
  await cdp.eval(`(async () => await window.__sleep(60))()`);   // let the 101 request actually leave
  const sent = route.requests.filter((r) => r.id === 101).length;
  check('Y1', 'control: 101 reader request in flight', sent >= 1, JSON.stringify(route.requests));
  await cdp.eval(`(async () => { state.sel = 102; return state.sel; })()`);      // selection changes; same element, NO new bind
  await cdp.eval(`(async () => await window.__sleep(900))()`);   // stale 101 response arrives
  const y1 = await bodyInfo();
  check('Y1', 'stale success must NOT publish after selection changed (no new bind)', !(y1.itemId === 101 && /STALE-A/.test(y1.text || '')) && y1.req !== 'req-stale-a', JSON.stringify(y1));

  // ---- Y2: selection changes before an in-flight FAILURE -> no stale-selection error either ----
  route.delay.set(101, 500);
  await cdp.eval(`(async () => { state.sel = 101; renderDetail(); return 1; })()`);
  await cdp.eval(`(async () => await window.__sleep(60))()`);
  await cdp.eval(`(async () => { state.sel = 201; return state.sel; })()`);
  await cdp.eval(`(async () => await window.__sleep(800))()`);
  const y2 = await bodyInfo();
  /* The legal initial publish of 101 (from its own renderDetail) remains; the invariant is that
     the LATE in-flight failure/repaint must not change the pane after selection moved away. */
  check('Y2', 'late in-flight failure must not repaint the moved-away pane', !(/STALE-A/.test(y2.reason || '') && y2.renderable === false) && y2.req !== 'req-stale-a', JSON.stringify(y2));
  route.delay.clear();

  // ---- Y3: invalid DTO (blank request) must not publish ANY request identity ----
  registry.set(301, { item: item(301, 'blank-req'), env: { ...env(DOC('BLANK'), '  '), request_id: '  ' } });
  // blank request_id inside the stored envelope; reader view echoes it
  await cdp.eval(`(async () => { await load(false); return (state.items || []).length; })()`);
  await cdp.eval(`(async () => { state.sel = 301; renderDetail(); return 1; })()`);
  await cdp.eval(`(async () => await window.__sleep(500))()`);
  const y3 = await bodyInfo();
  check('Y3', 'invalid DTO must not publish its request identity on bodyEl', y3.req !== '  ' && (y3.req === null || y3.req === undefined), JSON.stringify(y3));

  // ---- Y4: legitimate structured legacy (legacy_assumed_plain + NON-empty request) must read ----
  await cdp.eval(`(async () => { state.sel = 201; renderDetail(); return 1; })()`);
  await cdp.eval(`(async () => await window.__sleep(500))()`);
  const y4 = await bodyInfo();
  check('Y4', 'structured legacy renders with its non-empty request kept', y4.renderable === true && y4.req === 'req-structured-legacy' && /旧行 structured legacy/.test(y4.text || ''), JSON.stringify(y4));

  // ---- pure adapter/envelope-helper boundaries (real rich-text.js in VM) ----
  const src = fs.readFileSync(path.join(REPO, 'app/ui/rich-text.js'), 'utf8');
  const smSrc = fs.readFileSync(path.join(REPO, 'app/ui/rich-source-map.js'), 'utf8');
  const sb = { window: {}, console, Number, String, Object, Array, JSON, parseInt };
  sb.window = sb; vm.createContext(sb);
  { const req = (await import('node:module')).createRequire(import.meta.url);
    sb.window.markdownit = req(path.join(REPO, 'app/ui/vendor/markdown-it.umd.min.js')); }
  vm.runInContext(smSrc, sb);
  vm.runInContext(src + '\n;globalThis.__x={readerViewToDecision,readerEnvelopeQualifies};', sb);
  const rvd = sb.__x.readerViewToDecision, req_ = sb.__x.readerEnvelopeQualifies;
  const GOOD = { reader_view_version: 1, id: 1, request_id: 'r', format: 'markdown', format_provenance: 'declared', original_kind: 'text', truncated: false, canonical: '# A\n', canonical_unavailable_reason: null };
  check('adapter', 'control declared ok', rvd({ ...GOOD }).renderable === true);
  check('adapter', 'structured legacy (legacy+plain+text+NON-empty request) accepted', (() => { const d = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', request_id: 'req-sleg' }); return d.renderable === true && d.provenance === 'legacy'; })());
  check('adapter', 'unsealed legacy null request accepted', (() => { const d = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', request_id: null }); return d.renderable === true && d.provenance === 'legacy'; })());
  // helper bytes boundaries per frozen CapturedContent: Vec<u8> = each item u8 integer 0..255; empty Vec legal; charset_hint string|null
  /* Frozen content.rs constructor copies (RC-R2-F02): canonical reason and projection reason. */
  const BYTES_CANON = '二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）';
  const BYTES_PROJ = '二进制 original 无文本投影';
  const bytesEnv = (bytes, hint, reason, projReason) => ({ schema_version: 1, request_id: 'r', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'bytes', bytes, charset_hint: hint }, fidelity: { truncated: false }, canonical: null, canonical_unavailable_reason: reason, plain_projection: { status: 'unavailable', reason: projReason } });
  check('helper', 'empty bytes vector is LEGAL (frozen model)', req_(bytesEnv([], null, BYTES_CANON, BYTES_PROJ)).ok === true);
  for (const [k, bad] of Object.entries({ neg: [-1], over: [256], float: [1.5], str: ['1'] })) {
    check('helper', `bytes ${k} rejected`, req_(bytesEnv(bad, null, BYTES_CANON, BYTES_PROJ)).ok === false);
  }
  check('helper', 'object charset_hint rejected', req_(bytesEnv([1, 2], { a: 1 }, BYTES_CANON, BYTES_PROJ)).ok === false);
  check('helper', 'invented bytes reason rejected (must equal frozen copy)', req_(bytesEnv([1, 2], null, '我编的理由', BYTES_PROJ)).ok === false);
  check('helper', 'invented bytes projection reason rejected', req_(bytesEnv([1, 2], null, BYTES_CANON, '我编的投影理由')).ok === false);
  const htmlEnv = { schema_version: 1, request_id: 'r', format: 'html', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: '<p>x</p>' }, fidelity: { truncated: false }, canonical: '<p>x</p>', canonical_unavailable_reason: null, plain_projection: { status: 'unavailable', reason: '我编的 html 理由' } };
  check('helper', 'invented html projection reason rejected', req_(htmlEnv).ok === false);
} catch (e) { thrown = e; fail++; console.error(e); } finally {
  try { if (cdp) await cdp.close(); } catch (_) {}
  const status = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown, writeEvidence: (r2) => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(r2, null, 2)) });
  if (!status.ok) fail++;
  await new Promise((resolve) => server.close(resolve));
}
fs.writeFileSync(path.join(outDir, `results-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), total: results.length, fail, results }, null, 2));
console.log(`pre-repair-r3[${label}]: ${results.length - fail}/${results.length} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
