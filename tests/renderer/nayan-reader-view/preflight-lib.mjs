// tests/renderer/nayan-reader-view/preflight-lib.mjs — P1-B06-READER-CONTRACT-REPAIR-06 / Step 2
// Shared strict argument parsing + read-only output preflight for every entry point this batch
// actually launches. No mkdir/write/root-creation/spawn may happen before preflightOut passes.
// Side effects are counted by side-effect-probe.mjs wrapping fs/child_process in a child process.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
export function parseArgs(argv, spec) {
  // spec: { '--out': 'value'|'optional', ... }. RC-R5-F01: own-property checks only
  // (prototype members like 'toString' are NOT options); a following flag token is
  // never accepted as a value.
  const out = {}; const seen = new Set();
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isFlag = (t) => typeof t === 'string' && t.startsWith('--');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!hasOwn(spec, a)) throw Error(`unknown option: ${a}`);
    if (seen.has(a)) throw Error(`duplicate option: ${a}`);
    const val = argv[i + 1];
    if (val === undefined || isFlag(val) || hasOwn(spec, val)) throw Error(`missing value for ${a} (next token must be the value)`);
    out[a] = val; seen.add(a); i++;
  }
  for (const k of Object.keys(spec)) {
    if (spec[k] === 'optional') continue; // may be absent; when present it still needs a value
    if (!hasOwn(out, k)) throw Error(`missing required option ${k}`);
  }
  return out;
}
export function noSymlinkAncestors(abs) {
  let cur = path.dirname(abs);
  while (true) {
    // lstat even when existsSync is false: a dangling symlink ancestor is still an alias.
    const t = lstatNoFollow(cur);
    if (!t.absent && t.st.isSymbolicLink()) throw Error(`preflight: symlink ancestor (possibly dangling) refused: ${cur}`);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}
export function lstatNoFollow(abs) {
  // RC-R5-F02: lstat detects dangling symlinks that existsSync misses; only ENOENT passes.
  try { return { st: fs.lstatSync(abs) }; }
  catch (e) { if (e.code === 'ENOENT') return { absent: true }; throw Error(`preflight: lstat failed for ${abs}: ${e.message}`); }
}
export function preflightOut(outRaw, batchDir) {
  const abs = path.resolve(outRaw);
  const rel = path.relative(path.resolve(batchDir), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error(`preflight: --out must be inside the batch directory (${batchDir}) — refused: ${abs}`);
  noSymlinkAncestors(abs);
  const t = lstatNoFollow(abs);
  if (!t.absent) {
    if (t.st.isSymbolicLink()) throw Error(`preflight: --out is a symlink: ${abs}`);
    if (!t.st.isDirectory()) throw Error(`preflight: --out not a directory: ${abs}`);
    if (fs.readdirSync(abs).length) throw Error(`preflight: nonempty --out refused: ${abs}`);
  }
  return abs;
}
export const BATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs/implementation-plan-2026-09-23/batches/P1-B06-READER-CONTRACT-REPAIR-06');
