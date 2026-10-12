// tests/renderer/nayan-reader-view/handler-bytes-link.test.mjs — P1-B06-READER-CONTRACT-REPAIR-06
// Structured legacy BYTES handler→page chain (RC-R5-F04): consumes the REAL handle_api /reader
// response for a legal LegacyAssumedPlain/Plain/Bytes row (written by the Rust test
// reader_view_structured_legacy_bytes_artifact via NAYAN_R6_BYTES_ARTIFACT), serves it
// byte-for-byte, and proves: explicit unrenderable + frozen reason shown, correct item/request
// identity, NO body text / NO source map published. Usage: --artifact <path> --out DIR
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from '../cdp.mjs';
import { ownRoot, bindChild, finishRun } from '../tauri-asset-smoke/lifecycle.mjs';
import { parseArgs, preflightOut, BATCH_DIR } from './preflight-lib.mjs';
const { '--out': outDir, '--artifact': artifactPath } = parseArgs(process.argv.slice(2), { '--out': 'value', '--artifact': 'value' });
preflightOut(outDir, BATCH_DIR);
fs.mkdirSync(outDir, { recursive: true });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIR = path.join(REPO, 'app/ui');
const rawBytes = fs.readFileSync(artifactPath); // UTF-8 bytes of the artifact file
const artifactSha = crypto.createHash('sha256').update(rawBytes).digest('hex');
const artifactUtf8Bytes = Buffer.byteLength(rawBytes); // RC-R4-F04: real UTF-8 byte count
const raw = rawBytes.toString('utf8');
const view = JSON.parse(raw);
const item = { id: view.id, title: 'structured-legacy-bytes-artifact', quote: '', source_tool: 't', workspace: 'W', kind: 'plain', steps: [], created_at: '', status: 'inbox' };
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
  if (mr) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(raw); return; } // byte-for-byte artifact
  if (/^\/api\/suggestions\/\d+\/content$/.test(url)) { send(404, { error: 'reader: no such item' }); return; }
  if (url === '/api/suggestions') { send(200, [item]); return; }
  if (url === '/api/session-aliases') { send(200, []); return; }
  if (url === '/api/settings') { send(200, {}); return; }
  send(200, {});
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;
const results = []; let fail = 0; let thrown = null;
const check = (name, cond, d = '') => { results.push({ name, ok: cond, detail: String(d).slice(0, 300) }); if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <<< ' + String(d).slice(0, 240)}`); };
const chromeProc = await startChrome();
const ownedProfile = ownRoot(chromeProc.profile); bindChild(ownedProfile, chromeProc.child);
let cdp;
try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.go(base + '/index.html');
  await cdp.eval(`window.__sleep=(ms)=>new Promise(r=>setTimeout(r,ms));`);
  await cdp.eval(`(async () => { for (let i = 0; i < 600 && typeof state === 'undefined'; i++) await window.__sleep(50); for (let i = 0; i < 400 && !(state.items && state.items.length); i++) await window.__sleep(5); return 1; })()`);
  await cdp.eval(`(async () => { state.sel = ${view.id}; renderDetail(); return 1; })()`);
  let settled = false;
  for (let i = 0; i < 3000; i++) {
    const st = await cdp.eval(`(() => { const el = document.getElementById('aibody'); const d = el && el.__nayanDecision; return d && (d.renderable === false || d.mode !== 'markdown'); })()`);
    if (st) { settled = true; break; }
    await cdp.eval(`(async () => await window.__sleep(4))()`);
  }
  const info = await cdp.eval(`(() => { const el = document.getElementById('aibody'); const d = el.__nayanDecision; const sc = el.__nayanSourceMap; return JSON.stringify({ renderable: d.renderable, invalid: d.invalid === true, reason: d.reason || '', bodyText: el.textContent, req: el.__nayanIdentity.requestId, itemId: el.__nayanIdentity.itemId, sidecar: !!el.__nayanSourceMap }); })()`);
  const o = JSON.parse(info);
  check('artifact sha recorded', artifactSha.length === 64, artifactSha);
  check('bytes view unrenderable with frozen reason (not invalid)', o.renderable === false && o.invalid !== true && /二进制 original 无文本 canonical/.test(o.reason), info);
  check('frozen reason actually displayed in body', o.bodyText.includes('二进制 original 无文本 canonical'), info);
  check('identity binds correct item and non-empty request', o.itemId === view.id && o.req === view.request_id && o.req === 'req-structured-legacy-bytes', info);
  check('no source map published for bytes row', o.sidecar === false, info);
  check('no raw bytes leaked as text body', !/RTF/.test(o.bodyText) && o.bodyText.length < 200, info);
  check('artifact size recorded as UTF-8 bytes', artifactUtf8Bytes > 0 && Number.isInteger(artifactUtf8Bytes), String(artifactUtf8Bytes));
} catch (e) { thrown = String(e && e.stack || e); fail++; console.error(e); } finally {
  try { if (cdp) await cdp.close(); } catch (_) {}
  const status = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown, writeEvidence: (r2) => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(r2, null, 2)) });
  if (!status.ok) fail++;
  await new Promise((r) => server.close(r));
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ artifact: artifactPath, artifact_sha256: artifactSha, artifact_utf8_bytes: artifactUtf8Bytes, artifact_js_chars: raw.length, note: 'artifact_utf8_bytes = file size in UTF-8 bytes (Buffer.byteLength); artifact_js_chars = JS string length; serde/IPC layer, NOT wire', fail, results }, null, 2));
console.log(`handler-bytes-link: ${results.length - fail}/${results.length} pass`);
process.exit(fail ? 1 : 0);
