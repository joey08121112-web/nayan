// Owned test resources only. Never infer ownership from a PID/name search.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const markerName = '.nayan-smoke-owned.json';
const realTmp = fs.realpathSync(os.tmpdir());
export function ownRoot(root, run = crypto.randomUUID()) {
  const canonical = fs.realpathSync(root);
  const st = fs.lstatSync(canonical);
  if (path.dirname(canonical) !== realTmp || !st.isDirectory() || st.isSymbolicLink()
      || st.uid !== process.getuid()) throw new Error('Not an owned temporary root');
  const record = { root: canonical, run, uid: st.uid, dev: st.dev, ino: st.ino, launcherPid: process.pid, pid: null };
  fs.writeFileSync(path.join(canonical, markerName), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return record;
}
export function createRoot(prefix) { return ownRoot(fs.mkdtempSync(path.join(realTmp, prefix))); }
export function bindChild(record, child) {
  record.pid = child.pid;
  fs.writeFileSync(path.join(record.root, markerName), JSON.stringify(record));
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
export function cleanRoot(record, remove = fs.rmSync) {
  if (path.dirname(record.root) !== realTmp || fs.realpathSync(record.root) !== record.root)
    throw new Error('Root alias or path mismatch');
  const st = fs.lstatSync(record.root);
  const marker = path.join(record.root, markerName), mst = fs.lstatSync(marker);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== record.uid || st.dev !== record.dev || st.ino !== record.ino
      || !mst.isFile() || mst.isSymbolicLink() || mst.nlink !== 1 || mst.uid !== record.uid)
    throw new Error('Root/marker ownership mismatch');
  const disk = JSON.parse(fs.readFileSync(marker, 'utf8'));
  for (const key of ['root', 'run', 'uid', 'dev', 'ino', 'launcherPid', 'pid'])
    if (disk[key] !== record[key]) throw new Error('Root marker mismatch: ' + key);
  if (alive(record.pid)) throw new Error('Child still alive; refusing cleanup');
  remove(record.root, { recursive: true, force: false });
  if (fs.existsSync(record.root)) throw new Error('Cleanup did not remove root');
  record.cleaned = true;
}
export function waitChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    // close, not the timer, proves the process exited and pipes drained.
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
  });
}
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = waitChild(child, 4000);
  child.kill('SIGTERM');
  await closed;
}
export async function finishRun({ records, children = [], failed, writeEvidence, remove }) {
  let error = failed || null;
  for (const child of children) {
    try { await stopChild(child); } catch (e) { error ||= e; }
  }
  // Archive before deleting. An evidence failure must leave roots intact.
  try { writeEvidence({ ok: false, pendingCleanup: !error, records, error: error && String(error) }); }
  catch (e) { error ||= e; }
  if (!error) for (const record of records) {
    try { cleanRoot(record, remove); } catch (e) { error ||= e; break; }
  }
  const status = { ok: !error, pendingCleanup: false, records, error: error && String(error) };
  try { writeEvidence(status); } catch (e) { error ||= e; status.ok = false; status.error = String(error); }
  if (error) console.error('FAILED; evidence roots:', records.filter(r => !r.cleaned).map(r => r.root), String(error));
  return status;
}
