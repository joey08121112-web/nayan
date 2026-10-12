// tests/renderer/nayan-reader-view/side-effect-probe.mjs — P1-B06-READER-CONTRACT-REPAIR-04 / Step 2
// Runs a target script with fs/child_process write methods PATCHED before import: every write/
// root-creation/spawn attempt is RECORDED and THROWN (never executed). Prints JSON:
// { target, attempts: [{method, arg0}], refused: <first error message or null> }.
// Used to prove parameter/preflight refusals happen BEFORE the first side effect.
const args = process.argv.slice(2);
const tIdx = args.indexOf('--target');
const aIdx = args.indexOf('--argv');
if (tIdx < 0 || aIdx < 0) { console.error('usage: --target <script> --argv <json array>'); process.exit(2); }
import { fileURLToPath } from 'node:url';
const target = args[tIdx + 1].startsWith('/') ? fileURLToPath('file://' + args[tIdx + 1]) : fileURLToPath(new URL('./' + args[tIdx + 1], 'file://' + process.cwd() + '/').href);
const targetArgv = JSON.parse(args[aIdx + 1]);

import path from 'node:path';
const attempts = [];
class SideEffect extends Error { constructor(m, a) { super('SIDE-EFFECT-BLOCKED: ' + m + ' ' + String(a)); this.sideEffect = true; } }
// ESM namespaces are frozen; the CJS exports object returned by getBuiltinModule is writable and
// is the SAME object ESM named bindings resolve against at evaluation time (target is imported
// after patching), so wrapping here intercepts `import { mkdirSync } from 'node:fs'` too.
const fsC = process.getBuiltinModule('node:fs');
const cpC = process.getBuiltinModule('node:child_process');
const wrap = (mod, name, guard) => {
  const orig = mod[name];
  mod[name] = function (...a) {
    if (guard && !guard(...a)) return orig.apply(this, a); // read-only passthrough calls the original
    attempts.push({ method: name, arg0: String(a[0]) });
    throw new SideEffect(name, a[0]);
  };
};
const writeOpen = (p, flags) => typeof flags === 'string' ? !/^[rs]/.test(flags) : true; // 'r'/'rs' = read
for (const m of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'copyFileSync', 'rmSync', 'mkdtempSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'cpSync']) wrap(fsC, m);
wrap(fsC, 'openSync', writeOpen);
wrap(fsC, 'writeSync', () => true);
if (fsC.promises) for (const m of ['mkdir', 'writeFile', 'appendFile', 'copyFile', 'rm']) { if (typeof fsC.promises[m] === 'function') wrap(fsC.promises, m); }
for (const m of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) wrap(cpC, m);

let refused = null;
try {
  process.argv = [process.argv[0], target, ...targetArgv];
  const targetUrl = 'file://' + target + '?probe=' + Date.now();
  await import(targetUrl);
} catch (e) {
  if (!e || !e.sideEffect) refused = String((e && e.message) || e);
}
console.log(JSON.stringify({ target, targetArgv, attempts, refused, blockedCount: attempts.length }));
process.exit(0);
