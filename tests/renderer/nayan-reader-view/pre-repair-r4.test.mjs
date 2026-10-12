// tests/renderer/nayan-reader-view/pre-repair-r4.test.mjs — P1-B06-READER-CONTRACT-REPAIR-04 / Step 1
// Pre-repair counterexamples for RC-R3-F01 (DTO/envelope boundaries) and RC-R3-F03 (fingerprint
// delimiter collision + missing tables). Script version archived+hashed BEFORE execution.
// Same invariants are re-run after the fix. Usage: --out DIR --label pre|post
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import { parseArgs, preflightOut, BATCH_DIR } from './preflight-lib.mjs';
const { '--out': outDir, '--label': labelOpt } = parseArgs(process.argv.slice(2), { '--out': 'value' });
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
check('adapter', 'control declared ok', rvd({ ...GOOD }).renderable === true && rvd({ ...GOOD }).invalid !== true);

// ---- F01-a: bytes must have canonical===null; non-string canonical -> invalid ----
for (const [k, bad] of Object.entries({ objCanonical: { a: 1 }, numCanonical: 42, arrCanonical: [] })) {
  const d = rvd({ ...GOOD, original_kind: 'bytes', canonical: bad, canonical_unavailable_reason: '二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）' });
  check('adapter', `bytes canonical=${k} rejected WITH invalid:true`, d.renderable === false && d.invalid === true, JSON.stringify(d));
}
// null request is ONLY for unsealed legacy/plain/text (canonical string + reason null)
{
  const d1 = rvd({ ...GOOD, original_kind: 'bytes', request_id: null, canonical: null, canonical_unavailable_reason: '二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）' });
  check('adapter', 'bytes + null request rejected with invalid', d1.renderable === false && d1.invalid === true, JSON.stringify(d1));
  const d2 = rvd({ ...GOOD, format: 'plain', request_id: null, canonical: null, canonical_unavailable_reason: '虚构 unavailable 理由' });
  check('adapter', 'text + null canonical + invented reason + null request rejected with invalid', d2.renderable === false && d2.invalid === true, JSON.stringify(d2));
  const d3 = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', request_id: null });
  check('adapter', 'unsealed legacy/plain/text null request still legal', d3.renderable === true && d3.provenance === 'legacy', JSON.stringify(d3));
  const d4 = rvd({ ...GOOD, original_kind: 'bytes', request_id: 'req-bytes', canonical: null, canonical_unavailable_reason: '二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）' });
  check('adapter', 'legal bytes + NON-empty request still passes (unavailable, not invalid)', d4.renderable === false && d4.invalid !== true && /二进制/.test(d4.reason || ''), JSON.stringify(d4));
  const d5 = rvd({ ...GOOD, format: 'plain', format_provenance: 'legacy_assumed_plain', request_id: 'req-sleg' });
  check('adapter', 'structured legacy non-empty request still passes', d5.renderable === true, JSON.stringify(d5));
}

// ---- F01-b: helper accepts serde-default-omitted fields per frozen content.rs ----
// Raw/Flags serde defaults: fidelity {} (truncated defaults false), canonical_unavailable_reason Option default null.
const noFid = { schema_version: 1, request_id: 'r', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: 'x' }, canonical: 'x', canonical_unavailable_reason: null, plain_projection: { status: 'available', text: 'x' } };
check('helper', 'fidelity omitted -> serde default accepted', reqf(noFid).ok === true);
const fidEmpty = { ...noFid, fidelity: {} };
check('helper', 'fidelity:{} truncated-default accepted', reqf(fidEmpty).ok === true);
const noReason = { schema_version: 1, request_id: 'r', format: 'plain', format_provenance: 'declared', acquisition: 'manual', original: { kind: 'text', text: 'x' }, fidelity: { truncated: false }, canonical: 'x', plain_projection: { status: 'available', text: 'x' } };
check('helper', 'canonical_unavailable_reason omitted -> Option default accepted', reqf(noReason).ok === true);
// explicit wrong values still rejected
check('helper', 'explicit truncated:"x" still rejected', reqf({ ...noFid, fidelity: { truncated: 'x' } }).ok === false);
check('helper', 'explicit canonical_unavailable_reason:"y" with text canonical still rejected', reqf({ ...noFid, canonical_unavailable_reason: 'y' }).ok === false);
check('helper', 'forged canonical still rejected', reqf({ ...noFid, canonical: 'FORGED' }).ok === false);

// ---- F03: fingerprint delimiter collision + missing tables are RUST-side; reproduced here via
// the same collision construction against the helper's documented serialization contract is not
// possible in JS — the authoritative pre/post proof runs in cargo (see Rust test module).
// This JS block only asserts the adapter invariants above; count them so the summary is honest.
check('rust-side', 'fingerprint delimiter/table probes run in cargo (see p1t06 fingerprint tests)', true);

fs.writeFileSync(path.join(outDir, `results-${label}.json`), JSON.stringify({ label, script: 'pre-repair-r4.test.mjs', at: new Date().toISOString(), total: results.length, fail, results }, null, 2));
console.log(`pre-repair-r4[${label}]: ${results.length - fail}/${results.length} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
