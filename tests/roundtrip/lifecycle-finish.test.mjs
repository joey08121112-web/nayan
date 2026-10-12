// tests/roundtrip/lifecycle-finish.test.mjs — P1-T06-T07-REPAIR-01 第2步组③：
// 真实 finishRun 三态（正常/证据写失败/清理失败）——失败传播非零、证据失败保留根、
// 不删用户/历史根。用真实共享 lifecycle.mjs（算法零改动），临时根=本批 owned 合成根。
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { fileURLToPath } from 'node:url';
import { ownRoot, finishRun } from '../renderer/tauri-asset-smoke/lifecycle.mjs';
import { parseArgs, preflightOut } from '../renderer/nayan-reader-view/preflight-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { '--out': outDir } = parseArgs(process.argv.slice(2), { '--out': 'value' });
preflightOut(outDir, REPO); fs.mkdirSync(outDir, { recursive: true });
const results = []; let fail = 0;
function check(name, ok, detail = '') { ok = ok === true; results.push({ name, ok, detail }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 240)}`); }
const realTmp = fs.realpathSync(os.tmpdir());
const mkOwned = (tag) => { const d = fs.mkdtempSync(path.join(realTmp, 'nayan-rp1-fin-' + tag + '-')); fs.writeFileSync(path.join(d, 'marker.txt'), tag); return ownRoot(d); };

// 状态1：正常——证据两段落盘、根清理、status.ok=true
{
  const rec = mkOwned('normal'); const log = path.join(outDir, 'finish-normal.jsonl');
  const st = await finishRun({ records: [rec], children: [], failed: false, writeEvidence: (s) => fs.appendFileSync(log, JSON.stringify(s) + '\n') });
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('正常：status.ok=true 且根已清', st.ok === true && !fs.existsSync(rec.root), JSON.stringify({ ok: st.ok, root: fs.existsSync(rec.root) }));
  check('正常：writeEvidence 两态落盘（预清理+终态）', lines.length === 2 && lines[0].pendingCleanup === true && lines[1].pendingCleanup === false, 'lines=' + lines.length);
}
// 状态2：证据写失败——根必须保留、status.ok=false
{
  const rec = mkOwned('evfail');
  const st = await finishRun({ records: [rec], children: [], failed: false, writeEvidence: () => { throw new Error('evidence boom'); } });
  check('证据失败：status.ok=false 且根保留（先保全后删除）', st.ok === false && fs.existsSync(rec.root), JSON.stringify({ ok: st.ok, kept: fs.existsSync(rec.root) }));
  fs.rmSync(rec.root, { recursive: true, force: true }); // 检查完毕手动清本 owned 合成根
}
// 状态3：清理失败（remove 抛错）——status.ok=false、失败传播
{
  const rec = mkOwned('clfail');
  const st = await finishRun({ records: [rec], children: [], failed: false, writeEvidence: () => {}, remove: () => { throw new Error('remove boom'); } });
  check('清理失败：status.ok=false（失败传播非零由本测试 exit 汇总）', st.ok === false && String(st.error).includes('remove boom'), JSON.stringify({ ok: st.ok, err: st.error }));
  fs.rmSync(rec.root, { recursive: true, force: true });
}
// 对照：正常状态再次成立（清理失败不掩盖下一轮正常）
{
  const rec = mkOwned('again');
  const st = await finishRun({ records: [rec], children: [], failed: false, writeEvidence: () => {} });
  check('失败后正常对照恢复', st.ok === true && !fs.existsSync(rec.root), '');
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at_utc: new Date().toISOString(), total: results.length, fail, results }, null, 1));
console.log(`\nlifecycle-finish: ${results.length - fail}/${results.length} PASS`);
process.exit(fail ? 1 : 0);
