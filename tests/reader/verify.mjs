#!/usr/bin/env node
// tests/reader/verify.mjs —— P0-T03 断言器 v2（P0-B01-REPAIR-01 按 R1-F01 重写为期望驱动）。
//
// 与上一版的本质差异（评审 R1-F01：上一版把 0 正文+孤儿附件+空清单+旧 sink+缺结束快照判为全过）：
//   * 全部检查以 fixtures.mjs 的期望集合为驱动——每条 fixture 必须存在且唯一，多余/缺失/
//     改名/重复/改 quote 一律 FAIL；不再遍历现状反推结论。
//   * 附件按 sid 精确绑定（name+path 逐条），孤儿引用/错绑/行数不符 FAIL；不做总数式检查。
//   * 文件清单必须与期望文件集完全一致（非空），哈希从 fixture 内容常量独立计算，
//     不只信任 manifest（manifest 缺失/为空/与实际不符 FAIL）。
//   * copy 比对要求 DB 行存在且唯一 + sink 记录属于本次 run（拒绝旧 run）+ 逐字符相等。
//   * 缺 prod-after（最终验收模式）= FAIL；--mid-run 时报 PENDING 且 exit 3（仍非 0）。
//
// 退出码：0=全部通过；1=存在 FAIL；3=存在 PENDING（--mid-run 且无 FAIL）。
//
// 用法：node tests/reader/verify.mjs --root DIR [--phase seed|after-ui|after-restart]
//          [--run-id ID] [--port N] [--mid-run]
//   --run-id 缺省时读 root/current-run.json 的 run 字段。

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ATTACH_FILES, COPY_EXPECTED, SUGGESTIONS, fileNameOf } from './fixtures.mjs';

const args = process.argv.slice(2);
function argOf(k) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; }
const root = argOf('--root');
const phase = argOf('--phase') || 'after-ui';
const midRun = args.includes('--mid-run');
const port = argOf('--port') ? Number(argOf('--port')) : null;
if (!root) { console.error('用法: verify.mjs --root DIR [--phase …] [--run-id ID] [--port N] [--mid-run]'); process.exit(2); }
if (!['seed', 'after-ui', 'after-restart'].includes(phase)) { console.error('未知 phase: ' + phase); process.exit(2); }

const MARKER_OWNER = 'nayan-reader-regression';
function sha256Text(s) { return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'); }
function sha256File(f) { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function esc(s) { return JSON.stringify(s); }

// ---------- 期望状态（唯一事实来源 = fixtures.mjs；场景差量显式声明） ----------
// after-ui/after-restart 场景净效果：T1 增加运行期引用并保留；T2 增加后移除（净不变）。
const EXPECT_TITLES = SUGGESTIONS.map(s => s.title);
const EXPECT_QUOTE = Object.fromEntries(SUGGESTIONS.map(s => [s.title, s.quote]));
function expectedAttachments() {
  const m = new Map(SUGGESTIONS.map(s => [s.title, []]));
  for (const f of ATTACH_FILES) {
    if (!f.forKey) continue;
    const title = SUGGESTIONS.find(s => s.key === f.forKey).title;
    m.get(title).push(fileNameOf(f));
  }
  if (phase !== 'seed') {
    const t1 = SUGGESTIONS.find(s => s.key === 't1').title;
    m.get(t1).push(fileNameOf(ATTACH_FILES.find(f => f.forKey === null)));
  }
  for (const [k, v] of m) m.set(k, v.sort());
  return m;
}
function expectedFiles() {
  // name -> {deleted, sha256(由内容常量计算), content}
  const out = new Map();
  for (const f of ATTACH_FILES) {
    out.set(fileNameOf(f), { deleted: !!f.deleteAfterAttach, sha256: sha256Text(f.content), content: f.content });
  }
  return out;
}

const results = [];
function check(id, name, ok, detail, pending) {
  results.push({ id, name, ok, pending: !!pending, detail });
  const tag = pending ? 'PEND' : ok ? 'PASS' : 'FAIL';
  console.log(`${tag} ${id} ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- V1 所有权标记（内容校验，不只存在性） ----------
{
  const mp = path.join(root, 'nayan-test-owned.json');
  let ok = false, detail = '缺失';
  try {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    ok = m.owner === MARKER_OWNER && typeof m.run_id === 'string' && m.run_id.length > 0;
    detail = ok ? `owner=${m.owner} 创建run=${m.run_id}` : `owner/run_id 不符：${JSON.stringify(m).slice(0, 80)}`;
  } catch (e) { detail = '读取失败：' + e.message; }
  check('V1', '所有权标记（内容校验）', ok, detail);
}

// ---------- V2 正文：期望标题集合逐条存在且唯一，quote 逐字符相等 ----------
const dbPath = path.join(root, 'inbox.db');
let db = null;
if (fs.existsSync(dbPath)) {
  db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT id, title, quote FROM suggestions ORDER BY id').all();
  const byTitle = new Map();
  for (const r of rows) byTitle.set(r.title, (byTitle.get(r.title) || []).concat([r]));
  const problems = [];
  for (const t of EXPECT_TITLES) {
    const hits = byTitle.get(t) || [];
    if (hits.length === 0) { problems.push(`缺正文行「${t}」`); continue; }
    if (hits.length > 1) { problems.push(`「${t}」重复 ${hits.length} 条`); continue; }
    if (hits[0].quote !== EXPECT_QUOTE[t]) {
      problems.push(`「${t}」quote 不符：len=${hits[0].quote.length} vs 预期 ${EXPECT_QUOTE[t].length}`);
    }
  }
  const extra = rows.filter(r => !EXPECT_TITLES.includes(r.title)).map(r => `多余行#${r.id}「${r.title}」`);
  problems.push(...extra);
  check('V2', '正文：期望集合逐条存在/唯一/quote 逐字符相等', problems.length === 0,
    `${rows.length} 行（期望 ${EXPECT_TITLES.length}）` + (problems.length ? '；' + problems.join('；') : ''));
} else {
  check('V2', 'DB 存在', false, dbPath + ' 不存在');
}

// ---------- V3 附件：逐 sid 精确绑定 + 孤儿检测 ----------
if (db) {
  const attRows = db.prepare('SELECT id, suggestion_id, path, name FROM attachments ORDER BY id').all();
  const sugRows = db.prepare('SELECT id, title FROM suggestions').all();
  const titleById = new Map(sugRows.map(r => [r.id, r.title]));
  const expect = expectedAttachments();
  const problems = [];
  const orphans = attRows.filter(a => !titleById.has(a.suggestion_id));
  if (orphans.length) problems.push(`孤儿引用 ${orphans.length} 条（suggestion_id 不存在：${orphans.map(o => o.suggestion_id).join(',') }）`);
  const bySid = new Map();
  for (const a of attRows) {
    const t = titleById.get(a.suggestion_id);
    if (!t) continue;
    bySid.set(t, (bySid.get(t) || []).concat([a]));
  }
  for (const [title, expNames] of expect) {
    const got = (bySid.get(title) || []).map(a => a.name).sort();
    const exp = [...expNames].sort();
    if (JSON.stringify(got) !== JSON.stringify(exp)) {
      problems.push(`「${title.slice(0, 18)}」附件错绑：got=[${got.join(',')}] 预期=[${exp.join(',')}]`);
    }
    // 路径绑定：每行 path 必须精确指向 root/files/<name>（防错路径引用）
    for (const a of bySid.get(title) || []) {
      const expectPath = path.join(root, 'files', a.name);
      if (path.resolve(a.path) !== path.resolve(expectPath)) {
        problems.push(`附件#${a.id} path 错绑：${a.path}`);
      }
    }
  }
  check('V3', '附件：逐条目精确绑定 + 无孤儿引用', problems.length === 0,
    `共 ${attRows.length} 行` + (problems.length ? '；' + problems.join('；') : ''));
}

// ---------- V4 源文件：期望集合 + 独立哈希 + manifest 交叉核对 ----------
{
  const expect = expectedFiles();
  const filesDir = path.join(root, 'files');
  const problems = [];
  for (const [name, exp] of expect) {
    const p = path.join(filesDir, name);
    if (exp.deleted) {
      if (fs.existsSync(p)) problems.push(`${name} 应已删除（missing 场景）但仍在`);
      continue;
    }
    if (!fs.existsSync(p)) { problems.push(`${name} 不见了——移除引用不得删原文件`); continue; }
    const h = sha256File(p);
    if (h !== exp.sha256) problems.push(`${name} 内容哈希与 fixture 常量不符`);
  }
  // manifest 交叉核对：必须存在、非空、与期望集合一致
  const manifestPath = path.join(root, 'manifest-seed.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { }
  if (!manifest || !Array.isArray(manifest.files)) {
    problems.push('manifest-seed.json 缺失/损坏');
  } else if (manifest.files.length === 0) {
    problems.push('manifest-seed.json 文件清单为空（不允许空清单通过）');
  } else {
    const mNames = manifest.files.map(f => path.basename(f.abs)).sort();
    const eNames = [...expect.keys()].sort();
    if (JSON.stringify(mNames) !== JSON.stringify(eNames)) problems.push('manifest 文件集合与期望不符');
    for (const f of manifest.files) {
      const name = path.basename(f.abs);
      const exp = expect.get(name);
      if (exp && f.sha256 !== exp.sha256) problems.push(`manifest 内 ${name} 哈希与 fixture 常量不符`);
    }
  }
  check('V4', '源文件：期望集合+独立哈希+manifest 交叉核对', problems.length === 0,
    `期望 ${expect.size} 个` + (problems.length ? '；' + problems.join('；') : ' 全部一致'));
}

// ---------- V5 copy：DB 行存在且唯一 + 本次 run 的 sink + 逐字符相等 ----------
{
  const runFromFile = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'current-run.json'), 'utf8')).run; } catch { return null; }
  })();
  const runId = argOf('--run-id') || runFromFile;
  const sinkPath = path.join(root, 'copy-sink.jsonl');
  if (phase === 'seed') {
    check('V5', 'copy sink（seed 阶段尚未执行复制）', true, 'SKIP（seed 阶段不算通过证据）', /*pending*/true);
  } else {
    const problems = [];
    const det = [];
    if (!db) problems.push('DB 不可用');
    if (!runId) problems.push('无法确定本次 run（--run-id 或 current-run.json）');
    let lines = [];
    try { lines = fs.readFileSync(sinkPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { problems.push('copy-sink.jsonl 缺失/损坏'); }
    for (const c of COPY_EXPECTED) {
      // DB 行存在且唯一（标题前缀匹配 fixture 标题）
      const exact = SUGGESTIONS.find(s => s.key === c.label).title;
      let row = null;
      if (db) {
        const hits = db.prepare('SELECT id, quote FROM suggestions WHERE title = ?').all(exact);
        if (hits.length !== 1) { problems.push(`${c.label}: DB 行存在 ${hits.length} 条（须唯一）`); }
        else row = hits[0];
      }
      const mine = lines.filter(l => l.label === c.label && l.run === runId);
      if (!mine.length) { problems.push(`${c.label}: 本次 run(${runId}) 无 sink 记录（拒绝旧 run 数据）`); continue; }
      const last = mine[mine.length - 1];
      const eqFixture = last.text === c.quote;
      const eqStored = !row || row.quote === last.text;
      if (!eqFixture || !eqStored) {
        problems.push(`${c.label}: sink(${esc(last.text.slice(0, 40))}…) ≠ 预期/存储`);
      } else {
        det.push(`${c.label} 相等(len=${last.text.length}, ${esc(last.text).slice(0, 36)}…)`);
      }
    }
    check('V5', 'copy：DB 唯一行 + 本次 run sink + 逐字符相等', problems.length === 0,
      problems.length ? problems.join('；') : det.join('；'));
  }
}

// ---------- V6 生产路径快照 + 当前 run 结束证据绑定（R2-F02）----------
// after 必须带 run 身份且属于本次 run；run-exit 必须存在、同 run 且 clean。
// mid-run：任一条件不满足 → PENDING（exit 3）；final：任一不满足 → FAIL。
// 旧 run 的 after（即使内容相同）不得被当前 run 消费。
{
  const runFromFile = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'current-run.json'), 'utf8')).run; } catch { return null; }
  })();
  const curRun = argOf('--run-id') || runFromFile;
  const beforePath = path.join(root, 'prod-before.json');
  const afterPath = path.join(root, 'prod-after.json');
  const exitPath = path.join(root, 'run-exit.json');
  const pend = (msg) => midRun
    ? check('V6', '生产快照+结束证据（run 绑定）', true, 'PENDING：' + msg, /*pending*/true)
    : check('V6', '生产快照+结束证据（run 绑定）', false, msg);

  if (!curRun) { check('V6', '生产快照+结束证据', false, '无法确定本次 run'); }
  else if (!fs.existsSync(beforePath)) { check('V6', '生产快照+结束证据', false, 'prod-before.json 缺失'); }
  else if (!fs.existsSync(afterPath)) { pend('结束快照未生成（实例仍在运行）'); }
  else {
    let after = null;
    try { after = JSON.parse(fs.readFileSync(afterPath, 'utf8')); } catch (_) {}
    if (!after || typeof after !== 'object' || !after.run) {
      check('V6', '生产快照+结束证据', false, 'prod-after.json 缺少 run 身份（旧格式）——当前 run 不得消费');
    } else if (after.run !== curRun) {
      pend('prod-after 属于旧 run ' + after.run + '（当前 ' + curRun + '）——不得复用');
    } else if (!fs.existsSync(exitPath)) {
      pend('run-exit.json 未生成（结束证据不完整）');
    } else {
      let ex = null;
      try { ex = JSON.parse(fs.readFileSync(exitPath, 'utf8')); } catch (_) {}
      if (!ex || ex.run !== curRun) { pend('run-exit 不属于当前 run'); }
      else if (ex.clean !== true) { check('V6', '生产快照+结束证据', false, 'run-exit.clean=false（异常退出/超时强杀）'); }
      else {
        const b = fs.readFileSync(beforePath, 'utf8');
        const snapSame = JSON.stringify(after.snapshot) === JSON.stringify(JSON.parse(b));
        check('V6', '生产快照+结束证据（run=' + curRun + '）', snapSame,
          snapSame ? 'after(run 匹配)+run-exit(clean) 全部就绪，快照一致' : '快照存在差异（before vs after.snapshot）');
      }
    }
  }
}

// ---------- V7 在线 API（--port 提供时） ----------
if (port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/suggestions`, { signal: AbortSignal.timeout(3000) });
    const v = await r.json();
    const gotTitles = v.map(x => x.title).sort();
    const ok = r.ok && JSON.stringify(gotTitles) === JSON.stringify([...EXPECT_TITLES].sort());
    check('V7', '隔离实例在线（列表=期望标题集合）', ok, `共 ${v.length} 条` + (ok ? '' : '；集合不符'));
  } catch (e) {
    check('V7', '隔离实例在线', false, String(e));
  }
}

if (db) db.close();
const failed = results.filter(r => !r.ok);
const pending = results.filter(r => r.pending && r.ok);
if (failed.length) {
  console.log(`\nverify: ${failed.length} 项 FAIL（phase=${phase}）`);
  process.exit(1);
}
if (pending.length) {
  console.log(`\nverify: 无 FAIL，但 ${pending.length} 项 PENDING（phase=${phase}，--mid-run）——不是最终通过`);
  process.exit(3);
}
console.log(`\nverify: 全部通过（phase=${phase}）`);
process.exit(0);
