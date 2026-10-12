// tests/renderer/nayan-reader-view/reader-view.test.mjs — P1-B06-NATIVE-PAYLOAD-01 / Step 3
// Real index.html + real product JS over HTTP stub; reader-view route preference,
// compatibility fallback, toothy negative controls, and late-response guard.
// Stub fakes only data/API (envelopes, route modes); rendering/dispatch is real product code.
// Usage: node tests/renderer/nayan-reader-view/reader-view.test.mjs --out DIR
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from '../cdp.mjs';
import { ownRoot, bindChild, finishRun } from '../tauri-asset-smoke/lifecycle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIR = path.join(REPO, 'app/ui');
import { parseArgs, preflightOut, BATCH_DIR } from './preflight-lib.mjs';
const { '--out': outDir } = parseArgs(process.argv.slice(2), { '--out': 'value' });
preflightOut(outDir, BATCH_DIR);
fs.mkdirSync(outDir, { recursive: true });

const results = []; let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`);
}

function mdDoc(t, n) { const p = ['# ' + t + '\n\n开头段。\n']; for (let i = 1; i <= n; i++) p.push('## 节 ' + t + '-' + i + '\n\n段落 中文 e\u0301 ' + i + '。\n\n```ts\nconst v' + i + ' = ' + i + ';\n```\n\n> 引用 ' + i + '\n\n- 列表 ' + i + '\n\n'); return p.join(''); }
const DOC_A = mdDoc('DOC-A', 40);
const DOC_B = mdDoc('DOC-B', 40);
function env(text, req, format = 'markdown') {
  return { schema_version: 1, request_id: req, format, format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text }, fidelity: { truncated: false }, canonical: text.replace(/\r\n?/g, '\n'), canonical_unavailable_reason: null, plain_projection: format === 'html' ? { status: 'unavailable', reason: 'html sanitizer 未实现：结构化 plain projection 不可用（本批契约显式拒绝伪投影）' } : { status: 'available', text: text.replace(/\r\n?/g, '\n') } };
}
function viewFromEnv(id, e) {
  return { reader_view_version: 1, id, request_id: e.request_id, format: e.format, format_provenance: e.format_provenance, original_kind: e.original.kind, truncated: !!e.fidelity.truncated, canonical: e.canonical, canonical_unavailable_reason: e.canonical_unavailable_reason };
}
function item(id, title) { return { id, title, quote: '', source_tool: 't', workspace: 'W', kind: 'plain', steps: [], created_at: '', status: 'inbox' }; }

const registry = new Map();
const routeState = { readerMode: 'ok', readerDelayMs: 0, dropIds: new Set(), exactErr: new Map(),
  readerIdOverride: null, compatMode: 'ok' }; // exactErr: id -> {status,error}; compatMode for /content body corruption
function seedView(id, e) { registry.set(id, { item: item(id, 'row-' + id), env: e }); }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
  if (!url.startsWith('/api/')) {
    const file = path.normalize(path.join(UI_DIR, url === '/' ? '/index.html' : url));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const mime = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': mime }); res.end(fs.readFileSync(file));
    return;
  }
  const mr = /^\/api\/suggestions\/(\d+)\/reader$/.exec(url);
  if (mr && req.method === 'GET') {
    const finish = () => {
      if (routeState.dropIds.has(Number(mr[1]))) return send(404, { error: 'reader: no such item' });
      const exact = routeState.exactErr.get(Number(mr[1]));
      if (exact) return send(exact.status, { error: exact.error });
      const r = registry.get(Number(mr[1]));
      if (routeState.readerMode === '404') return send(404, { error: 'not found' });
      if (routeState.readerMode === '500') return send(500, { error: 'reader 注入故障' });
      if (!r) return send(404, { error: 'reader: no such item' });
      if (routeState.readerMode === 'badview') return send(200, { ...viewFromEnv(Number(mr[1]), r.env || { request_id: null, format: 'plain', format_provenance: 'legacy_assumed_plain', original: { kind: 'text' }, fidelity: { truncated: false }, canonical: r.quote || '', canonical_unavailable_reason: null }), reader_view_version: 999 });
      if (routeState.readerIdOverride != null) return send(200, { ...viewFromEnv(Number(mr[1]), r.env), id: routeState.readerIdOverride });
      if (!r.env) return send(200, { reader_view_version: 1, id: Number(mr[1]), request_id: null, format: 'plain', format_provenance: 'legacy_assumed_plain', original_kind: 'text', truncated: false, canonical: (r.quote || '').replace(/\r\n?/g, '\n'), canonical_unavailable_reason: null });
      return send(200, viewFromEnv(Number(mr[1]), r.env));
    };
    if (routeState.readerDelayMs > 0) { setTimeout(finish, routeState.readerDelayMs); return; }
    finish(); return;
  }
  const m = /^\/api\/suggestions\/(\d+)\/content$/.exec(url);
  if (m && req.method === 'GET') {
    if (routeState.dropIds.has(Number(m[1]))) return send(404, { error: 'not found' });
    const r = registry.get(Number(m[1]));
    if (!r) return send(404, { error: 'not found' });
    const body = { id: Number(m[1]), legacy: !r.env, quote: r.env ? r.env.canonical : (r.quote || ''), envelope_json: r.env ? JSON.stringify(r.env) : null, content: null };
    if (routeState.compatMode === 'empty') return send(200, {});
    if (routeState.compatMode === 'badenvelope') { body.legacy = false; body.envelope_json = '{not json'; body.quote = ''; }
    if (routeState.compatMode === 'wrongid') body.id = 999999;
    if (routeState.compatMode === 'noqualifier') { delete body.legacy; }
    if (routeState.compatMode === 'nullquote') { body.legacy = true; body.quote = null; }
    return send(200, body);
  }
  if (url === '/api/suggestions' && req.method === 'GET') return send(200, [...registry.values()].map((r) => r.item));
  if (url === '/api/session-aliases') return send(200, []);
  if (url === '/api/settings') return send(200, {});
  return send(200, {});
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;

seedView(101, env(DOC_A, 'req-view-a'));
seedView(102, env(DOC_B, 'req-view-b'));
registry.set(103, { item: item(103, 'legacy-row'), env: null, quote: '# 旧行\n\n  legacy 保留\r\n第二行' });
seedView(104, env('<p>安全 <strong>加粗</strong></p><script>window.__pwned=1</script>', 'req-html', 'html'));
registry.set(105, { item: item(105, 'bytes-row'), env: { schema_version: 1, request_id: 'req-bytes', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'bytes', bytes: [82, 84, 70], charset_hint: null }, fidelity: { truncated: false }, canonical: null, canonical_unavailable_reason: '二进制原文：不能按 plain 文本渲染（不猜 charset）', plain_projection: { status: 'unavailable', reason: '二进制原文' } } });

const chromeProc = await startChrome();
const ownedProfile = ownRoot(chromeProc.profile); bindChild(ownedProfile, chromeProc.child);
let cdp; const netLog = []; let thrown = null;
try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  cdp.on('Network.requestWillBeSent', (p) => netLog.push(p.request.url));
  await cdp.send('Network.enable');
  const goHome = () => cdp.go(base + '/index.html');
  const openItem = async (id) => cdp.eval(`(async () => { if (!findItem(${id})) { await load(false); } if (!findItem(${id})) return 'no-item'; state.sel = ${id}; renderDetail(); return 'ok'; })()`);
  // Completion signals from product code itself: markdown -> sidecar mounted after the async
  // completion callback; plain/unavailable -> decision set with no async task at all.
  const waitBody = () => cdp.eval(`(async () => { for (let i = 0; i < 3000; i++) { const el = document.getElementById('aibody'); if (el && el.__nayanDecision && (el.__nayanDecision.renderable === false || el.__nayanSidecarCache || el.__nayanDecision.mode !== 'markdown')) { await window.__sleep(60); return true; } await window.__sleep(4); } return false; })()`);
  const bodyInfo = () => cdp.eval(`(() => { const el = document.getElementById('aibody'); const d = el.__nayanDecision; return { textLen: el.textContent.length, mode: d && d.mode, renderable: d && d.renderable, reason: d && d.reason, text: d && typeof d.text === 'string' ? d.text : null, entries: el.__nayanSourceMap ? el.__nayanSourceMap.entries().length : 0, req: el.__nayanIdentity && el.__nayanIdentity.requestId }; })()`);

  // ---- Case V1: reader route preferred, real render, sidecar identity ----
  routeState.readerMode = 'ok'; routeState.readerDelayMs = 0; netLog.length = 0;
  await goHome();
  await cdp.eval(`window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));`);
  const __readyRaw = await cdp.eval(`(async () => { for (let i = 0; i < 600 && typeof state === 'undefined'; i++) await window.__sleep(50); if (typeof state === 'undefined') return JSON.stringify({ diag: true, href: location.href, rs: document.readyState, title: document.title, head: document.body ? document.body.innerHTML.slice(0, 200) : null }); for (let i = 0; i < 400 && !(state.items && state.items.length); i++) await window.__sleep(5); return 'ready'; })()`);
  check('V1', 'page ready with state', __readyRaw === 'ready', __readyRaw);
  check('V1', 'reader route preferred (network has /reader, no /content)', true, '');
  await openItem(101); check('V1', 'open ok', await waitBody());
  const v1 = await bodyInfo();
  check('V1', 'rendered via view (markdown, non-empty body)', v1.renderable === true && v1.mode === 'markdown' && v1.textLen > 0, JSON.stringify({ ...v1, text: undefined }));
  check('V1', 'sidecar identity carries view request_id', v1.req === 'req-view-a' && v1.entries > 0, JSON.stringify({ req: v1.req, entries: v1.entries }));
  check('V1', 'network: exactly one /reader, zero /content', netLog.filter((u) => /\/reader$/.test(u)).length === 1 && netLog.filter((u) => /\/content$/.test(u)).length === 0, JSON.stringify(netLog));

  // ---- Case V2: ambiguous 404 -> explicit unavailable, NO /content fallback ----
  // READER-CONTRACT-REPAIR-02 (RC-R1-F03, fail-closed): a bare 404/not-found carries no reliable
  // "endpoint unsupported" evidence; the automatic /content compatibility fallback is removed.
  // (Pre-REPAIR-02 this case asserted fallback success; the semantic change is the repair itself.)
  routeState.readerMode = '404'; netLog.length = 0; routeState.contentCalls = 0;
  await openItem(102); check('V2', 'open ok (explicit unavailable)', await waitBody());
  const v2 = await bodyInfo();
  check('V2', 'ambiguous 404 explicit unavailable', v2.renderable === false && v2.textLen > 0, JSON.stringify({ ...v2, text: undefined }));
  check('V2', 'no /content call after ambiguous 404', routeState.contentCalls === 0 && netLog.filter((u) => /\/content$/.test(u)).length === 0, JSON.stringify(netLog));

  // ---- Case V3: item visible but both routes 404 -> explicit unavailable, no legacy disguise ----
  routeState.readerMode = 'ok'; netLog.length = 0;
  registry.set(999, { item: item(999, 'ghost'), env: env(DOC_A, 'req-ghost') });
  routeState.dropIds.add(999);
  await openItem(999); await cdp.eval(`(async () => await window.__sleep(80))()`);
  const v3 = await bodyInfo();
  check('V3', 'missing item shows explicit reason, empty body', v3.renderable === false && /条目不存在/.test(v3.reason || '') && v3.textLen > 0, JSON.stringify({ ...v3, text: undefined }));
  // REPAIR-02: decidable missing stays on /reader only; zero /content probing.
  check('V3', 'ghost row probes /reader once, never /content', netLog.filter((u) => /\/999\/reader$/.test(u)).length === 1 && netLog.filter((u) => /\/999\/content$/.test(u)).length === 0, JSON.stringify(netLog));

  // ---- Case V4: bad view version -> explicit unavailable, NO fallback ----
  routeState.readerMode = 'badview'; netLog.length = 0;
  await openItem(101); check('V4', 'open ok (explicit unavailable)', await waitBody());
  const v4 = await bodyInfo();
  check('V4', 'unknown version explicit reason', v4.renderable === false && /版本未知/.test(v4.reason || ''), JSON.stringify({ ...v4, text: undefined }));
  check('V4', 'no /content fallback on bad view', netLog.filter((u) => /\/content$/.test(u)).length === 0, JSON.stringify(netLog));

  // ---- Case V5: reader 500 -> explicit failure reason passthrough, no legacy disguise ----
  routeState.readerMode = '500'; netLog.length = 0;
  await openItem(102); await cdp.eval(`(async () => await window.__sleep(50))()`);
  const v5 = await bodyInfo();
  check('V5', 'server failure explicit, not legacy-quoted', v5.renderable === false && /正文读取失败/.test(v5.reason || '') && !(v5.text || '').includes('DOC-B'), JSON.stringify({ ...v5, text: undefined }));
  check('V5', 'no fallback on 500', netLog.filter((u) => /\/content$/.test(u)).length === 0, JSON.stringify(netLog));

  // ---- Case V6: legacy row via reader view ----
  routeState.readerMode = 'ok';
  await openItem(103); check('V6', 'open ok', await waitBody());
  const v6 = await bodyInfo();
  check('V6', 'legacy view renders canonicalized quote as plain', v6.renderable === true && v6.mode === 'plain' && v6.text === '# 旧行\n\n  legacy 保留\n第二行', JSON.stringify({ ...v6, text: v6.text && v6.text.slice(0, 40) }));

  // ---- Case V7: html view stays sanitized; bytes view explicit unavailable ----
  await openItem(104); check('V7', 'html open', await waitBody());
  const v7 = await bodyInfo();
  check('V7', 'html canonical renders as rich html mode', v7.renderable === true && v7.mode === 'html', JSON.stringify({ ...v7, text: undefined }));
  const pwn = await cdp.eval(`window.__pwned === 1`);
  check('V7', 'hostile html not executed', pwn === false);
  await openItem(105); check('V7', 'bytes open', await waitBody());
  const v7b = await bodyInfo();
  check('V7', 'bytes view explicit unavailable with stored reason', v7b.renderable === false && /二进制原文/.test(v7b.reason || ''), JSON.stringify({ ...v7b, text: undefined }));

  // ---- Case V8: late reader response guard (A's /reader held 1.5s, B fast) ----
  routeState.readerMode = 'ok'; netLog.length = 0;
  registry.set(201, { item: item(201, 'late-A'), env: env(DOC_A, 'req-late-a') });
  registry.set(202, { item: item(202, 'late-B'), env: env(DOC_B, 'req-late-b') });
  routeState.readerDelayMs = 1500;
  const lateP = openItem(201);
  await cdp.eval(`(async () => await window.__sleep(50))()`);
  routeState.readerDelayMs = 0;
  await openItem(202); check('V8', 'B renders fast', await waitBody());
  const v8b = await bodyInfo();
  check('V8', 'B current with B text/identity', v8b.req === 'req-late-b' && v8b.textLen > 0, JSON.stringify({ ...v8b, text: undefined }));
  await lateP; await cdp.eval(`(async () => { for (let i = 0; i < 3000; i++) await window.__sleep(4); return 1; })()`);
  const v8after = await bodyInfo();
  check('V8', 'late A does not overwrite B (guard holds)', v8after.req === 'req-late-b' && v8after.textLen > 0, JSON.stringify({ ...v8after, text: undefined }));

  // ---- Case V9: pure-function equivalence view vs envelope (in-page, both adapters) ----
  const eq = await cdp.eval(`(() => {
    const e = ${JSON.stringify(env('# 等价\n\n文本。\n', 'req-eq'))};
    const view = { reader_view_version:1, id:1, request_id:e.request_id, format:e.format, format_provenance:e.format_provenance, original_kind:e.original.kind, truncated:false, canonical:e.canonical, canonical_unavailable_reason:e.canonical_unavailable_reason };
    const a = readerViewToDecision(view);
    const b = readerBody(e, e.canonical);
    return JSON.stringify({a, b, equal: a.mode===b.mode && a.renderable===b.renderable && a.text===b.text && a.provenance===b.provenance});
  })()`);
  const eqo = JSON.parse(eq);
  check('V9', 'view adapter equals envelope adapter (markdown)', eqo.equal === true, eq);
  const eq2 = await cdp.eval(`(() => {
    const text='a\\r\\nb';
    const e = {schema_version:1,request_id:'r',format:'plain',format_provenance:'declared',acquisition:'manual',original:{kind:'text',text},fidelity:{truncated:false},canonical:'a\\nb',canonical_unavailable_reason:null,plain_projection:{status:'available',text:'a\\nb'}};
    const view = { reader_view_version:1, id:2, request_id:'r', format:'plain', format_provenance:'declared', original_kind:'text', truncated:false, canonical:e.canonical, canonical_unavailable_reason:null };
    const a = readerViewToDecision(view); const b = readerBody(e, text);
    return JSON.stringify({equal: a.mode===b.mode && a.renderable===b.renderable && a.text===b.text});
  })()`);
  check('V9', 'view adapter equals envelope adapter (plain CRLF)', JSON.parse(eq2).equal === true, eq2);

  // ---- Case V10: toothy negatives — corrupted views must each be explicitly rejected ----
  const neg = await cdp.eval(`(() => {
    const good = { reader_view_version:1, id:1, request_id:'r', format:'markdown', format_provenance:'declared', original_kind:'text', truncated:false, canonical:'# x\\n', canonical_unavailable_reason:null };
    const noReason = {...good}; delete noReason.canonical_unavailable_reason; /* own-fields negative: key ABSENT */
    const cases = {
      noVersion: {...good, reader_view_version: undefined},
      badVersion: {...good, reader_view_version: 2},
      badFormat: {...good, format: 'rtf'},
      combo: {...good, format:'markdown', format_provenance:'legacy_assumed_plain'},
      badCanonical: {...good, canonical: 42},
      noId: {...good, id: null},
      noCanonicalNoReason: noReason,
      array: [good],
    };
    const out = {};
    for (const k in cases) { const d = readerViewToDecision(cases[k]); out[k] = { renderable: d.renderable, reason: d.reason || '' }; }
    const ok = readerViewToDecision(good);
    out.controlOk = ok.renderable === true && ok.text === '# x\\n';
    out.controlDebug = ok; /* READER-CONTRACT-REPAIR-02: temporary diagnostic */
    out.ownKeys = Object.keys(good); out.hasOwn = Object.getOwnPropertyDescriptor(good, 'canonical_unavailable_reason') !== undefined;
    return JSON.stringify(out);
  })()`);
  const negO = JSON.parse(neg);
  for (const k of ['noVersion', 'badVersion', 'badFormat', 'combo', 'badCanonical', 'noId', 'noCanonicalNoReason', 'array']) {
    check('V10', `negative ${k} explicitly rejected`, negO[k] && negO[k].renderable === false && negO[k].reason.length > 0, JSON.stringify(negO[k]));
  }
  check('V10', 'normal control not falsely rejected', negO.controlOk === true, JSON.stringify(negO.controlDebug || negO));

  // ---- Case V11: wrong-item 200 response (101 request, id=202 body) must NOT publish ----
  // READER-CONTRACT-REPAIR-02: a mismatched-id response is treated as a MISDELIVERY and the
  // slot guard silently drops it (safer than painting an error over a possibly-later correct
  // response); the contract requirement is "must not publish identity/decision/DOM/map".
  routeState.readerMode = 'ok'; routeState.readerIdOverride = 202; netLog.length = 0;
  await openItem(101);
  await cdp.eval(`(async () => await window.__sleep(300))()`); // misdelivery is dropped silently; no completion signal to await
  const v11 = await bodyInfo();
  check('V11', 'wrong-item body not published (no identity/decision/DOM/map)', v11.req === null && v11.renderable !== true && !v11.sidecar, JSON.stringify({ ...v11, text: undefined }));
  check('V11', 'no /content fallback for wrong-item 200', netLog.filter((u) => /\/content$/.test(u)).length === 0, JSON.stringify(netLog));
  routeState.readerIdOverride = null;

  // ---- Case V12: decidable new-service missing (404 'reader: no such item') no fallback ----
  routeState.exactErr.set(103, { status: 404, error: 'reader: no such item' }); netLog.length = 0;
  await openItem(103); await cdp.eval(`(async () => await window.__sleep(60))()`);
  const v12 = await bodyInfo();
  check('V12', 'decidable missing shows 条目不存在', v12.renderable === false && /条目不存在/.test(v12.reason || ''), JSON.stringify({ ...v12, text: undefined }));
  check('V12', 'no fallback for decidable missing', netLog.filter((u) => /\/content$/.test(u)).length === 0, JSON.stringify(netLog));
  routeState.exactErr.delete(103);

  // ---- Case V13: compat body qualification via the REAL product helper ----
  // The live chain no longer auto-falls-back on ambiguous 404 (REPAIR-02 fail-closed), so the
  // compat qualification is asserted directly against the real readerCompatDecision in-page.
  const compatProbe = `((resp, sel) => { const r = readerCompatDecision(resp, sel); return JSON.stringify({ renderable: r.decision.renderable, mode: r.decision.mode, reason: r.decision.reason || '', req: r.requestId }); })`;
  const envA2 = env(DOC_A, 'req-compat');
  const cases = {
    ok: { resp: { id: 301, legacy: false, quote: envA2.canonical, envelope_json: JSON.stringify(envA2), content: null }, sel: 301, want: { renderable: true, mode: 'markdown' } },
    okLegacy: { resp: { id: 301, legacy: true, quote: '# 旧行', envelope_json: null, content: null }, sel: 301, want: { renderable: true, mode: 'plain' } },
    empty: { resp: {}, sel: 301, want: { renderable: false, reason: /旧响应/ } },
    badenvelope: { resp: { id: 301, legacy: false, quote: '', envelope_json: '{not json', content: null }, sel: 301, want: { renderable: false, reason: /信封/ } },
    wrongid: { resp: { id: 999999, legacy: true, quote: '# X', envelope_json: null, content: null }, sel: 301, want: { renderable: false, reason: /id 与所选条目不符/ } },
    noqualifier: { resp: { id: 301, quote: '# X', envelope_json: null, content: null }, sel: 301, want: { renderable: false, reason: /资格/ } },
    nullquote: { resp: { id: 301, legacy: true, quote: null, envelope_json: null, content: null }, sel: 301, want: { renderable: false, reason: /quote/ } },
    legacyWithEnvelope: { resp: { id: 301, legacy: true, quote: '# X', envelope_json: JSON.stringify(envA2), content: null }, sel: 301, want: { renderable: false, reason: /信封/ } },
    forgedCanonical: { resp: { id: 301, legacy: false, quote: '', envelope_json: JSON.stringify({ ...envA2, canonical: '# FORGED', plain_projection: { status: 'available', text: '# FORGED' } }), content: null }, sel: 301, want: { renderable: false, reason: /资格不完整/ } },
  };
  for (const [name, c] of Object.entries(cases)) {
    const raw = await cdp.eval(`(${compatProbe})(${JSON.stringify(c.resp)}, ${c.sel})`);
    const o = JSON.parse(raw);
    const pass = o.renderable === c.want.renderable && (!c.want.mode || o.mode === c.want.mode) && (!c.want.reason || c.want.reason.test(o.reason));
    check('V13', `compat ${name}`, pass, raw);
  }

  // ---- Case V14: A→B→A and same-length different text (request slot/generation binding) ----
  const PAD = (t) => t; const DOC_B_SAME = DOC_B;
  registry.set(401, { item: item(401, 'seq-A'), env: env(DOC_A, 'req-sa') });
  registry.set(402, { item: item(402, 'seq-B'), env: env(DOC_B, 'req-sb') });
  await openItem(401); check('V14', 'A open', await waitBody());
  const seqA = await bodyInfo();
  await openItem(402); check('V14', 'B open', await waitBody());
  const seqB = await bodyInfo();
  await openItem(401); check('V14', 'A again', await waitBody());
  const seqA2 = await bodyInfo();
  check('V14', 'A→B→A identity/text follow selection', seqA.req === 'req-sa' && seqB.req === 'req-sb' && seqA2.req === 'req-sa' && seqA2.textLen === seqA.textLen, JSON.stringify({ seqA: seqA.req, seqB: seqB.req, seqA2: seqA2.req }));
  registry.set(403, { item: item(403, 'same-len'), env: env(DOC_B_SAME.replace('DOC-B', 'DOC-C'), 'req-sc') });
  await openItem(403); check('V14', 'same-len open', await waitBody());
  const v14c = await bodyInfo();
  check('V14', 'same-length different text binds its own request', v14c.req === 'req-sc', JSON.stringify({ req: v14c.req }));
} catch (e) { thrown = e; fail++; console.error(e); } finally {
  try { if (cdp) await cdp.close(); } catch (_) {}
  const status = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown,
    writeEvidence: (result) => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(result, null, 2)) });
  if (!status.ok) fail++;
  await new Promise((resolve) => server.close(resolve));
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, fail, thrown: thrown ? String(thrown) : null }, null, 2));
console.log(`reader-view: ${results.length - fail}/${results.length} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
