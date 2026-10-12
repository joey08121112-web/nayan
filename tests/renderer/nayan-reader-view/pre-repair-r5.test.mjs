// tests/renderer/nayan-reader-view/pre-repair-r5.test.mjs — P1-B06-READER-CONTRACT-REPAIR-05 / Step 1
// Pre-repair counterexamples for RC-R4-F01 (adapter/envelope资格反向与 serde 缺省过度模拟).
// Script archived+hashed BEFORE execution; the post-repair rerun must satisfy the SAME invariants.
// Real markdown-it (same vendored version) injected via CJS require; frozen mapper loaded.
// Usage: node tests/renderer/nayan-reader-view/pre-repair-r5.test.mjs --out DIR --label pre|post
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/* READER-CONTRACT-REPAIR-06 / RC-R5-F01: the final R5 entry now uses the shared strict
   parser and scope preflight (own-property options, next-flag-as-value rejected,
   authoritative batch scope). Invariant set unchanged. */
import { parseArgs, preflightOut, BATCH_DIR } from './preflight-lib.mjs';
const { '--out': outDir, '--label': labelOpt } = parseArgs(process.argv.slice(2), { '--out': 'value', '--label': 'optional' });
preflightOut(outDir, BATCH_DIR);
fs.mkdirSync(outDir, { recursive: true });
const label = labelOpt || 'unlabeled';
const results = []; let fail = 0;
const check = (c, n, ok, d = '') => { results.push({ case: c, name: n, ok, detail: String(d).slice(0, 300) }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${c}] ${n}${ok ? '' : '  <<< ' + String(d).slice(0, 240)}`); };

const src = fs.readFileSync(path.join(REPO, 'app/ui/rich-text.js'), 'utf8');
const smSrc = fs.readFileSync(path.join(REPO, 'app/ui/rich-source-map.js'), 'utf8');
const sb = { window: {}, console, Number, String, Object, Array, JSON, parseInt };
sb.window = sb; vm.createContext(sb);
{ const req = (await import('node:module')).createRequire(import.meta.url);
  sb.window.markdownit = req(path.join(REPO, 'app/ui/vendor/markdown-it.umd.min.js')); }
vm.runInContext(smSrc, sb);
vm.runInContext(src + '\n;globalThis.__x={readerViewToDecision,readerEnvelopeQualifies};', sb);
const rvd = sb.__x.readerViewToDecision, reqf = sb.__x.readerEnvelopeQualifies;

const GOOD = { reader_view_version: 1, id: 1, request_id: 'r', format: 'markdown', format_provenance: 'declared', original_kind: 'text', truncated: false, canonical: '# A\n', canonical_unavailable_reason: null };
check('adapter', 'control declared ok', (() => { const d = rvd({ ...GOOD }); return d.renderable === true && d.invalid !== true; })());
const BYTES_R = '二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）';

// ---- R4-F01.1: legacy/plain/bytes + null request must be invalid (was accepted) ----
{
  const d = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', original_kind: 'bytes', request_id: null, canonical: null, canonical_unavailable_reason: BYTES_R });
  check('adapter', 'legacy bytes + null request -> invalid', d.renderable === false && d.invalid === true, JSON.stringify(d));
}
// ---- R4-F01.2: structured legacy (legacy + NON-empty request) bytes/plain must be legal unavailable ----
{
  const d = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', request_id: 'req-sleg-bytes', original_kind: 'bytes', canonical: null, canonical_unavailable_reason: BYTES_R });
  check('adapter', 'structured legacy bytes + non-empty request -> legal unavailable with real reason+identity', d.renderable === false && d.invalid !== true && /二进制/.test(d.reason || ''), JSON.stringify(d));
  const d2 = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', request_id: 'req-sleg', canonical: '旧行\n' });
  check('adapter', 'structured legacy text + non-empty request -> legal readable', d2.renderable === true && d2.provenance === 'legacy', JSON.stringify(d2));
}
// ---- controls: unsealed legacy null request still legal (text only) ----
{
  const d = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', request_id: null });
  check('adapter', 'unsealed legacy/plain/text + null request still legal', d.renderable === true && d.provenance === 'legacy', JSON.stringify(d));
}

// ---- helper boundaries ----
const textEnv = (over = {}) => ({ schema_version: 1, request_id: 'r', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: 'x' }, fidelity: { truncated: false }, canonical: 'x', canonical_unavailable_reason: null, plain_projection: { status: 'available', text: 'x' }, ...over });
check('helper', 'control text ok', reqf(textEnv()).ok === true);
// R4-F01.3: fidelity:null must be REJECTED (null ≠ absent default)
check('helper', 'fidelity:null rejected', reqf(textEnv({ fidelity: null })).ok === false);
// R4-F01.4: HTML with plain_projection OMITTED must be rejected (required field, no invention)
const htmlNoProj = { schema_version: 1, request_id: 'r', format: 'html', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: '<p>x</p>' }, fidelity: { truncated: false }, canonical: '<p>x</p>', canonical_unavailable_reason: null };
check('helper', 'html missing plain_projection rejected (no invented default)', reqf(htmlNoProj).ok === false);
// R4-F01.5: bytes with plain_projection OMITTED must be rejected
const bytesNoProj = { schema_version: 1, request_id: 'r', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'bytes', bytes: [1, 2], charset_hint: null }, fidelity: { truncated: false }, canonical: null, canonical_unavailable_reason: '二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）' };
check('helper', 'bytes missing plain_projection rejected', reqf(bytesNoProj).ok === false);
// preserved passing controls
check('helper', 'fidelity omitted (absent) still legal', reqf(textEnv({ fidelity: undefined })).ok === true);
check('helper', 'canonical_unavailable_reason omitted still legal', (() => { const e = textEnv(); delete e.canonical_unavailable_reason; return reqf(e).ok === true; })());
check('helper', 'fidelity:{} truncated-default still legal', reqf(textEnv({ fidelity: {} })).ok === true);
check('helper', 'fidelity:{} truncated missing ok (default false)', reqf({ ...textEnv({ fidelity: {} }) }).ok === true);
check('helper', 'html with frozen projection reason ok', reqf({ ...htmlNoProj, plain_projection: { status: 'unavailable', reason: 'html sanitizer 未实现：结构化 plain projection 不可用（本批契约显式拒绝伪投影）' } }).ok === true);
check('helper', 'u8 negative still rejected', reqf({ schema_version: 1, request_id: 'r', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'bytes', bytes: [-1], charset_hint: null }, fidelity: { truncated: false }, canonical: null, canonical_unavailable_reason: BYTES_R, plain_projection: { status: 'unavailable', reason: '二进制 original 无文本投影' } }).ok === false);
check('helper', 'forged canonical still rejected', reqf(textEnv({ canonical: 'FORGED' })).ok === false);

fs.writeFileSync(path.join(outDir, `results-${label}.json`), JSON.stringify({ label, script: 'pre-repair-r5.test.mjs', at: new Date().toISOString(), total: results.length, fail, results }, null, 2));
console.log(`pre-repair-r5[${label}]: ${results.length - fail}/${results.length} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
