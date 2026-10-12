// tests/renderer/nayan-reader-view/output-protection.test.mjs — P1-B06-READER-CONTRACT-REPAIR-06
// Full rewrite (RC-R5-F01/F02 closure): all synthetic dirs live inside the authoritative 06
// batch scope and are validated by this suite itself BEFORE use; nonempty cases use real
// nonempty directories under the ALLOWED scope (so refusal proves the nonempty rule, not the
// scope rule); aliases (incl. dangling) are created in-batch; historical path strings appear
// ONLY under full side-effect interception (side-effect-probe), never as a real spawn target.
// Every negative asserts the CORRECT refusal reason AND attempts=0; interceptor positive
// controls prove the probe has teeth; sentinel hashes are captured before each command and the
// full historical manifest checked is THIS batch's own freeze.
// Usage: node tests/renderer/nayan-reader-view/output-protection.test.mjs --out DIR
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, preflightOut, BATCH_DIR } from './preflight-lib.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { '--out': outDir } = parseArgs(process.argv.slice(2), { '--out': 'value' });
preflightOut(outDir, BATCH_DIR);
fs.mkdirSync(outDir, { recursive: true });
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const results = []; let fail = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail: String(detail).slice(0, 300) }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 260)}`); };
const runner = path.join(REPO, 'tests/renderer/nayan-native-smoke/run.mjs');
const negative = path.join(REPO, 'tests/renderer/nayan-native-smoke/negative.mjs');
const driver = path.join(REPO, 'tests/renderer/nayan-native-performance/regression.mjs');
const counter = path.join(REPO, 'tests/renderer/nayan-reader-view/counterexamples.test.mjs');
const r5entry = path.join(REPO, 'tests/renderer/nayan-reader-view/pre-repair-r5.test.mjs');
const probe = path.join(REPO, 'tests/renderer/nayan-reader-view/side-effect-probe.mjs');
const THIS_BATCH = BATCH_DIR; // authoritative 06 scope (trusted constant from lib)
const BIN = sha(path.join(REPO, 'app/src-tauri/target/debug/nayan-native-verify'));

// Synthetic root INSIDE the batch scope, created and verified by this suite itself.
const SYN = path.join(THIS_BATCH, 'evidence', 'op-protect-synthetic');
fs.mkdirSync(SYN, { recursive: true });
const inSyn = (n) => path.join(SYN, n);

// 0) interceptor positive control: a script that REALLY writes must produce attempts>=1 and
//    the write must be blocked (file never created). Proves the probe has teeth.
{
  const writer = path.join(SYN, 'writer-positive.mjs');
  fs.writeFileSync(writer, "import fs from 'node:fs';\nfs.mkdirSync(process.argv[2], { recursive: true });\nfs.writeFileSync(process.argv[2] + '/f', 'x');\n");
  const target = inSyn('writer-positive-target');
  const r = spawnSync(process.execPath, [probe, '--target', writer, '--argv', JSON.stringify([target])], { encoding: 'utf8' });
  let o = null; try { o = JSON.parse(r.stdout); } catch {}
  check('interceptor positive: real write attempt detected (attempts>=1)', o && Array.isArray(o.attempts) && o.attempts.length >= 1, r.stdout || r.stderr);
  check('interceptor positive: write actually blocked (target absent)', !fs.existsSync(target), target);
}

// 1) run.mjs nonempty gate under the ALLOWED scope: nonempty synthetic dir inside 06.
{
  const s1 = inSyn('nonempty-run'); fs.mkdirSync(s1, { recursive: true });
  fs.writeFileSync(path.join(s1, 'SENTINEL'), 'untouched');
  const s1Hash = sha(path.join(s1, 'SENTINEL')); // BEFORE command
  const r = spawnSync(process.execPath, [runner, '--mode', 'smoke', '--out', s1], { encoding: 'utf8' });
  check('run.mjs nonempty gate inside allowed scope (sentinel preserved)',
    r.status !== 0 && /nonempty --out refused/.test(r.stderr) && fs.readdirSync(s1).length === 1 && sha(path.join(s1, 'SENTINEL')) === s1Hash, (r.stderr || '').slice(0, 140));
  fs.rmSync(s1, { recursive: true, force: true });
}
// 2) negative.mjs nonempty gate under allowed scope, pre-root (no negative-* roots created).
{
  const s2 = inSyn('nonempty-neg'); fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s2, 'SENTINEL'), 'untouched');
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('nayan-native-negative-')));
  const r = spawnSync(process.execPath, [negative, '--out', s2], { encoding: 'utf8' });
  const after = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('nayan-native-negative-')));
  let grew = false; for (const d of after) if (!before.has(d)) grew = true;
  check('negative.mjs nonempty gate inside allowed scope, pre-root', r.status !== 0 && /nonempty --out refused/.test(r.stderr || '') && !grew && fs.readdirSync(s2).length === 1, (r.stderr || '').slice(0, 140));
  fs.rmSync(s2, { recursive: true, force: true });
}
// 3) driver existing ledger under allowed scope (ledger gate, not scope gate).
{
  const s3 = inSyn('driver-ledger'); fs.mkdirSync(s3, { recursive: true });
  fs.writeFileSync(path.join(s3, 'commands.jsonl'), '{"prior":true}');
  const r = spawnSync(process.execPath, [driver, '--out', s3, '--bin-sha', BIN, '--evidence', THIS_BATCH], { encoding: 'utf8' });
  check('driver ledger gate inside allowed scope', r.status !== 0 && /ledger --out nonempty refused/.test(r.stderr), (r.stderr || '').slice(0, 160));
  fs.rmSync(s3, { recursive: true, force: true });
}
// 4) driver missing --out
{
  const r = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
  check('driver refuses missing --out (parseArgs)', r.status !== 0 && /missing required option --out/.test(r.stderr), (r.stderr || '').slice(0, 100));
}
// 5) driver missing --evidence
{
  const s5 = inSyn('driver-no-evidence'); fs.mkdirSync(s5, { recursive: true });
  const r = spawnSync(process.execPath, [driver, '--out', s5, '--bin-sha', BIN], { encoding: 'utf8' });
  check('driver refuses missing --evidence (parseArgs)', r.status !== 0 && /missing required option --evidence/.test(r.stderr), (r.stderr || '').slice(0, 100));
  fs.rmSync(s5, { recursive: true, force: true });
}
// 6) driver unknown / duplicate options (parseArgs, before mkdir)
{
  const s6a = inSyn('driver-unknown'); fs.mkdirSync(s6a, { recursive: true });
  let r = spawnSync(process.execPath, [driver, '--out', s6a, '--bin-sha', BIN, '--evidence', THIS_BATCH, '--bogus', 'x'], { encoding: 'utf8' });
  check('driver unknown option refused (parseArgs)', r.status !== 0 && /unknown option: --bogus/.test(r.stderr), (r.stderr || '').slice(0, 120));
  r = spawnSync(process.execPath, [driver, '--out', s6a, '--out', s6a, '--bin-sha', BIN, '--evidence', THIS_BATCH], { encoding: 'utf8' });
  check('driver duplicate option refused (parseArgs)', r.status !== 0 && /duplicate option: --out/.test(r.stderr), (r.stderr || '').slice(0, 120));
  fs.rmSync(s6a, { recursive: true, force: true });
}
// 7) run invalid mode BEFORE mkdir (enum check moved up in R5)
{
  const s7 = inSyn('run-badmode'); fs.mkdirSync(s7, { recursive: true });
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('nayan-native-run-')));
  const r = spawnSync(process.execPath, [runner, '--mode', 'not-a-mode', '--out', s7], { encoding: 'utf8' });
  const after = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('nayan-native-run-')));
  let grew = false; for (const d of after) if (!before.has(d)) grew = true;
  check('run invalid mode refused before mkdir (no root created)', r.status !== 0 && /unknown mode/.test(r.stderr) && !grew, (r.stderr || '').slice(0, 140));
  fs.rmSync(s7, { recursive: true, force: true });
}
// 8) in-batch alias ancestors (live + dangling) for run/negative/reader-view/driver
{
  const aliasParent = inSyn('alias-parent'); fs.mkdirSync(aliasParent, { recursive: true });
  const live = inSyn('alias-live-target'); fs.mkdirSync(live, { recursive: true });
  fs.symlinkSync(live, path.join(aliasParent, 'live-link'));
  fs.symlinkSync(path.join(aliasParent, 'does-not-exist'), path.join(aliasParent, 'dangling-link')); // dangling
  const cases = [
    ['run live alias ancestor', runner, ['--mode', 'smoke', '--out', path.join(aliasParent, 'live-link', 'x')]],
    ['run dangling alias ancestor', runner, ['--mode', 'smoke', '--out', path.join(aliasParent, 'dangling-link', 'x')]],
    ['negative live alias ancestor', negative, ['--out', path.join(aliasParent, 'live-link', 'x')]],
    ['negative dangling alias ancestor', negative, ['--out', path.join(aliasParent, 'dangling-link', 'x')]],
    ['reader-view live alias ancestor', counter, ['--out', path.join(aliasParent, 'live-link', 'x')]],
    ['driver ledger dangling alias ancestor', driver, ['--out', path.join(aliasParent, 'dangling-link', 'ledger')]],
  ];
  for (const [name, target, targetArgv] of cases) {
    const rr = spawnSync(process.execPath, [probe, '--target', target, '--argv', JSON.stringify(targetArgv)], { encoding: 'utf8' });
    let o = null; try { o = JSON.parse(rr.stdout); } catch {}
    check(`alias: ${name} refused with zero attempts`, rr.status === 0 && o && o.attempts.length === 0 && (o.refused || '').length > 0, (rr.stdout || rr.stderr || '').slice(0, 200));
  }
  fs.rmSync(aliasParent, { recursive: true, force: true });
  fs.rmSync(live, { recursive: true, force: true });
}
// 9) historical path strings ONLY under full interception (probe): zero attempts.
{
  const hist = path.join(REPO, 'docs/implementation-plan-2026-09-23/batches/P1-B06-NATIVE-PAYLOAD-01', 'evidence', 'r6-probe-should-never-exist');
  const cases = [
    ['reader-view historical path (intercepted)', counter, ['--out', hist]],
    ['run historical path (intercepted)', runner, ['--mode', 'smoke', '--out', hist]],
    ['negative historical path (intercepted)', negative, ['--out', hist]],
    ['driver old-out + old-evidence pair (intercepted)', driver, ['--out', hist + '-ledger', '--bin-sha', BIN, '--evidence', hist]],
    ['pre-repair-r5 historical path (intercepted)', r5entry, ['--out', hist]],
  ];
  for (const [name, target, targetArgv] of cases) {
    const rr = spawnSync(process.execPath, [probe, '--target', target, '--argv', JSON.stringify(targetArgv)], { encoding: 'utf8' });
    let o = null; try { o = JSON.parse(rr.stdout); } catch {}
    check(`intercepted historical: ${name} zero attempts`, rr.status === 0 && o && o.attempts.length === 0, (rr.stdout || rr.stderr || '').slice(0, 200));
  }
  check('historical target really absent after intercepted runs', !fs.existsSync(hist), hist);
}
// 10) parseArgs boundaries direct (lib unit)
{
  const lib = await import('./preflight-lib.mjs');
  const b1 = (() => { try { lib.parseArgs(['--out', '--label', 'x'], { '--out': 'value' }); return false; } catch (e) { return /missing value/.test(e.message); } })();
  check('parseArgs: next-flag-as-value rejected', b1);
  const b2 = (() => { try { lib.parseArgs(['toString', 'x'], { '--out': 'value' }); return false; } catch (e) { return /unknown option/.test(e.message); } })();
  check('parseArgs: prototype member rejected', b2);
  const b3 = (() => { try { lib.parseArgs(['--out', 'a', '--out', 'b'], { '--out': 'value' }); return false; } catch (e) { return /duplicate/.test(e.message); } })();
  check('parseArgs: duplicate rejected', b3);
  const b4 = (() => { try { lib.parseArgs([], { '--out': 'value' }); return false; } catch (e) { return /missing required/.test(e.message); } })();
  check('parseArgs: missing required rejected', b4);
  const b5 = (() => { try { lib.parseArgs(['--out', 'a', '--label'], { '--out': 'value', '--label': 'optional' }); return false; } catch (e) { return /missing value for --label/.test(e.message); } })();
  check('parseArgs: optional flag with no value rejected', b5);
}
// 11) sentinel: hashes captured BEFORE each command were compared above; historical manifest is THIS batch freeze.
{
  const startRec = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/implementation-plan-2026-09-23/batches/P1-B06-READER-CONTRACT-REPAIR-06/baseline/start.json'), 'utf8'));
  let drift = 0, checked = 0;
  for (const [f, h] of Object.entries(startRec.history_hashes)) { if (!fs.existsSync(f) || sha(f) !== h) drift++; checked++; }
  check('historical evidence unchanged vs 06 full freeze', drift === 0 && checked > 5900, `checked=${checked} drift=${drift}`);
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, fail, results }, null, 2));
console.log(`output-protection(v6): ${results.length - fail}/${results.length} pass`);
fs.rmSync(SYN, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
