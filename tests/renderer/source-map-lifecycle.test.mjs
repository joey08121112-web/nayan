import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRoot, bindChild, cleanRoot, waitChild, finishRun } from './tauri-asset-smoke/lifecycle.mjs';

if (process.argv[2] === '--child') {
  const mode = process.argv[3], out = process.argv[4];
  const r = createRoot('nayan-lifecycle-');
  fs.writeFileSync(out, JSON.stringify({ record: r }));
  let waited = null;
  if (mode === 'timeout' || mode === 'live-pid') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    bindChild(r, child);
    if (mode === 'live-pid') {
      assert.throws(() => cleanRoot(r), /still alive/);
      waited = await waitChild(child, 20);
    } else waited = await waitChild(child, 20);
  }
  if (mode === 'alias') {
    const link=r.root+'-alias'; fs.symlinkSync(r.root,link);
    assert.throws(()=>cleanRoot({...r,root:link}),/alias/); fs.unlinkSync(link);
  }
  if (mode === 'hardlink') {
    const link=path.join(r.root,'marker-copy'); fs.linkSync(path.join(r.root,'.nayan-smoke-owned.json'),link);
    assert.throws(()=>cleanRoot(r),/ownership/); fs.unlinkSync(link);
  }
  if (mode === 'marker') {
    const p = path.join(r.root, '.nayan-smoke-owned.json');
    const m = JSON.parse(fs.readFileSync(p)); m.run = 'wrong'; fs.writeFileSync(p, JSON.stringify(m));
  }
  const status = await finishRun({ records: [r],
    failed: mode === 'assertion' ? new Error('assertion failed') : waited?.timedOut && mode === 'timeout' ? new Error('timeout') : null,
    remove: mode === 'cleanup' ? () => { throw new Error('synthetic EACCES'); } : undefined,
    writeEvidence: s => {
      if (mode === 'evidence') throw new Error('synthetic evidence failure');
      fs.writeFileSync(out, JSON.stringify({ ...s, waited }));
    }
  });
  process.exitCode = status.ok ? 0 : 1;
} else {
  const outArg = process.argv.indexOf('--out');
  if (outArg < 0) throw new Error('--out is required');
  const out = path.resolve(process.argv[outArg + 1]); fs.mkdirSync(out, { recursive: true });
  const results = [];
  for (const mode of ['normal','assertion','cleanup','timeout','evidence','marker','live-pid','alias','hardlink']) {
    const output = path.join(out, mode + '.json');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode, output]);
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    const exit = await waitChild(child, 10000);
    const data = JSON.parse(fs.readFileSync(output)), record = data.records?.[0] || data.record;
    const retained = fs.existsSync(record.root), expectedOk = ['normal','live-pid','alias','hardlink'].includes(mode);
    const ok = exit.code === (expectedOk ? 0 : 1) && retained === !expectedOk;
    results.push({ mode, exit, retained, ok, stdout, stderr, data });
    // Parent knows the exact root/run/inode created by this test. Restore only the deliberately altered marker.
    if (retained) {
      fs.writeFileSync(path.join(record.root, '.nayan-smoke-owned.json'), JSON.stringify(record));
      cleanRoot(record);
    }
  }
  fs.writeFileSync(path.join(out,'lifecycle-results.json'), JSON.stringify(results,null,2));
  assert(results.every(r => r.ok), JSON.stringify(results));
  console.log('lifecycle: '+results.length+'/'+results.length+' (real child exits, aliases, links and retained roots checked)');
}
