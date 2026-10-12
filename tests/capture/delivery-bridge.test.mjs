#!/usr/bin/env node
// tests/capture/delivery-bridge.test.mjs —— P1-B03-REPAIR-02 交付桥测试（R2-F01/R2-F02）。
//
// 目的：把「Rust 交付控制」与「实际页面应用函数」用真实代码连接起来验证闭环
// （总控 Missing Evidence 3），不靠两个互不连接的成功桩推断。
//
// 构成与真实性声明：
//   * Rust 段 = 产品 main.rs 内的桥发射器测试（bridge_emit_scenarios_for_page_bridge）
//     经真实 cargo 编译执行（REPAIR-03 起原子 stage 依赖 serde_json，弃 rustc 单文件提取，
//     产品代码本体直接跑，零提取偏差）；交错全部为顺序调用注入（确定性，无随机压力）。
//   * 页面段 = 从 app/ui/capture-mini.html 原样提取的 applyCapture 函数，
//     在 node vm 中以最小 DOM/TAPI 桩执行（同总控 page-redelivery-probe 方法）。
//   * 连接 = Rust 段产出的「实际发射载荷序列」按到达顺序直接灌给真实 applyCapture。
//     这不是 WKWebView 端到端实测（NV：真机合体），但两侧均为产品真代码。
//
// 用法：node tests/capture/delivery-bridge.test.mjs [--out DIR]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-delivery-bridge-'));
fs.mkdirSync(OUT, { recursive: true });

let PASS = 0, FAIL = 0;
const logLines = [];
function log(s) { logLines.push(s); console.log(s); }
function check(name, ok, detail) {
  if (ok) { PASS++; log(`PASS ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
  else { FAIL++; log(`FAIL ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// ---------- 段 1：Rust 产品代码本体 → 实际发射序列（cargo 驱动，零提取偏差） ----------
// P1-B03-REPAIR-03 起：原子 stage 依赖 serde_json（json! 宏），rustc 单文件提取不再可行；
// 改为在产品 main.rs 的桥发射器测试（bridge_emit_scenarios_for_page_bridge）上跑，
// 经 NAYAN_BRIDGE_OUT 环境变量取序列文件——Rust 段即产品代码本体（真实 cargo 编译执行，
// 场景断言在测试内，任一失败即非零退出）。故障注入点 = 发射/准入闭包内的确定性时序。
function runRustBridge() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-bridge-rust-'));
  try {
    const stdout = execFileSync('cargo', [
      'test', '--offline', '--manifest-path', path.join(REPO, 'app/src-tauri/Cargo.toml'),
      'bridge_emit_scenarios_for_page_bridge', '--', '--nocapture',
    ], { env: { ...process.env, NAYAN_BRIDGE_OUT: work }, encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    fs.copyFileSync(path.join(work, 'rust-emitted.txt'), path.join(OUT, 'rust-emitted.txt'));
    fs.writeFileSync(path.join(OUT, 'cargo-bridge-run.log'), stdout);
    const scenarios = fs.readFileSync(path.join(work, 'rust-emitted.txt'), 'utf8')
      .trim().split('\n').filter((l) => l.startsWith('SCENARIO|')).map((l) => {
        const parts = l.split('|');
        return { scenario: parts[1], outcome: parts[2], emitted: parts[3] ? parts[3].split(';;') : [], pending_after: parts[4] === '-' || parts[4] === undefined ? null : parts[4] };
      });
    if (scenarios.length !== 5) throw new Error('桥发射器应产出 5 个场景，实际 ' + scenarios.length);
    return { compile: 'cargo-ok', json: { scenarios } };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------- 段 2：真实 applyCapture（vm 提取） ----------
function pageContext() {
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', title: '', disabled: false, style: {}, classList: { remove() {}, add() {}, contains() { return false; } }, focus() {},
      removeAttribute() {}, setAttribute() {} }); // 2026-10-11：框选原图预览（screenImg）用到属性增删
    return elements.get(id);
  }
  const acks = [];
  const jsLogs = [];
  return {
    ctx: {
      REQ: null, ENVELOPE: null, SAVED: false, APPLIED_GEN: 0, text: '', app: '', ws: '', sr: '', wid: 0, channel: '',
      userEdited: false, projSource: null, MAX_CHARS: 100000, CHANNEL_LABEL: { ax: 'AX' }, el,
      TAPI: {
        invoke(cmd, args) {
          if (cmd === 'capture_delivered_ack') { acks.push(args.requestId); return Promise.resolve(null); }
          if (cmd === 'js_log') { jsLogs.push(args.msg); return Promise.resolve(null); }
          return new Promise(() => {}); // enrich 等永挂（不影响本测试断言）
        },
      },
      readerBody(env, text) { return { text }; },
      renderReaderBody(e, r) { e.textContent = r.text; },
      codepoints(s) { return [...String(s)].length; },
      lastSeg(s) { return String(s).split('/').pop(); },
      projSourceSet() {},
      setProj(v) { el('proj').value = v; },
      drawChips() {},
      checkMore() {},
      PUT: 0, loadLists() {}, okLabel() { return '收进收件箱'; }, closeProjEditor() {}, paintHint() {}, // 2026-10-11：v3「放到哪里」每次采集重置为收件箱
      localStorage: { getItem() { return null; }, setItem() {} },
      setTimeout() {},
      window: {},
    },
    acks, jsLogs, el,
  };
}

function loadApplyCapture(ctx) {
  const source = fs.readFileSync(path.join(REPO, 'app/ui/capture-mini.html'), 'utf8');
  const start = source.indexOf('function applyCapture(d) {');
  const end = source.indexOf('\nwindow.applyCapture = applyCapture;', start);
  if (start < 0 || end < 0) throw new Error('capture-mini.html 提取锚点缺失');
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return ctx.applyCapture;
}

// ---------- 段 3：桥接断言 ----------
const rust = runRustBridge();
log({ ev: 'rust-bridge', compile: rust.compile, scenarios: rust.json.scenarios.map((s) => ({ s: s.scenario, out: s.outcome, n: s.emitted.length })) });
const S = Object.fromEntries(rust.json.scenarios.map((s) => [s.scenario, s]));

// 场景 1：准入拒绝 → 零外投 → 页面无从收到 A
{
  const s = S.s1_admission_rejects_stale_a;
  check('S1[Rust] A 快照后 B 完成全生命周期 → A 准入拒绝（NotPending）', s.outcome === 'NotPending');
  check('S1[Rust] 零外投（A 不得越过已确认的 B）', s.emitted.length === 0);
  check('S1[Rust] B 已确认，后端无待交付稿', s.pending_after === null);
  const p = pageContext();
  const apply = loadApplyCapture(p.ctx);
  for (const payload of s.emitted) apply(JSON.parse(payload)); // 无载荷到达
  check('S1[页面] 页面保持初始（REQ=null，无确认发出）', p.ctx.REQ === null && p.acks.length === 0);
}

// 场景 2：残余窗口 A 已发射 → 页面按世代拒绝晚到 A，最终 B
{
  const s = S.s2_residual_window_emits_both;
  check('S2[Rust] 残余窗口内 A 事实发射（如实：RetriedDelivered）', s.outcome === 'RetriedDelivered');
  check('S2[Rust] 到达序 = [B, A]（B 先应用，A 晚到）', s.emitted.length === 2 && JSON.parse(s.emitted[0]).request_id === 'B' && JSON.parse(s.emitted[1]).request_id === 'A');
  const p = pageContext();
  const apply = loadApplyCapture(p.ctx);
  apply(JSON.parse(s.emitted[0])); // B 先到达并应用
  p.el('note').value = 'user note'; p.el('proj').value = '/chosen'; p.ctx.userEdited = true; // B 的编辑
  apply(JSON.parse(s.emitted[1])); // A 晚到
  check('S2[页面] 最终 REQ=B（晚到 A 不得覆盖 B）', p.ctx.REQ === 'B');
  check('S2[页面] 正文仍 B（A 不得重新成为可保存稿）', p.el('bubble').textContent === 'B body');
  check('S2[页面] 用户编辑保留（note/proj/userEdited 不被 A 重置）', p.el('note').value === 'user note' && p.el('proj').value === '/chosen' && p.ctx.userEdited === true);
  check('S2[页面] 不为晚到 A 发确认（acks 只含 B）', JSON.stringify(p.acks) === '["B"]');
  check('S2[页面] 拒收有日志（可审计，世代为原子分配的实际值）', p.jsLogs.some((l) => l.includes('拒绝过期交付') && l.includes('gen=') && l.includes('当前 gen=')));
}

// 场景 3：同稿重放（ack 丢失 → watchdog 重投同 gen 同 rid）→ 只补确认，编辑不动
{
  const s = S.s3_replay_same_draft_twice;
  check('S3[Rust] watchdog 两次重投均发射、稿本保留至确认', s.emitted.length === 2 && s.pending_after !== null);
  const p = pageContext();
  const apply = loadApplyCapture(p.ctx);
  apply(JSON.parse(s.emitted[0]));
  p.el('note').value = 'user note'; p.el('proj').value = '/chosen'; p.ctx.userEdited = true;
  p.ctx.SAVED = false;
  apply(JSON.parse(s.emitted[1])); // 同 gen 同 rid 重放
  check('S3[页面] 备注/项目/手选标记保留', p.el('note').value === 'user note' && p.el('proj').value === '/chosen' && p.ctx.userEdited === true);
  check('S3[页面] 保存状态不被重置（SAVED 仍 false，本轮未保存）', p.ctx.SAVED === false);
  check('S3[页面] 两次确认如实回传（同 rid ×2，Rust 幂等忽略）', JSON.stringify(p.acks) === '["A","A"]');
  check('S3[页面] 正文仍在（草稿未丢）', p.el('bubble').textContent === 'A body');
  // 保存成功后的重放：SAVED 不重置
  p.ctx.SAVED = true;
  apply(JSON.parse(s.emitted[1]));
  check('S3[页面] 已保存后重放不重置 SAVED', p.ctx.SAVED === true);
  // 保存进行中的重放：按钮禁用不被解除
  p.el('okBtn').disabled = true;
  apply(JSON.parse(s.emitted[1]));
  check('S3[页面] 保存进行中重放不解禁按钮', p.el('okBtn').disabled === true);
}

// 场景 4：成对正常路径 A→B
{
  const s = S.s4_normal_a_then_b;
  const p = pageContext();
  const apply = loadApplyCapture(p.ctx);
  apply(JSON.parse(s.emitted[0]));
  const reqAfterA = p.ctx.REQ, bodyAfterA = p.el('bubble').textContent;
  apply(JSON.parse(s.emitted[1]));
  check('S4[页面] A 正常应用', reqAfterA === 'A' && bodyAfterA === 'A body');
  check('S4[页面] 真实新 B 正常替换 A', p.ctx.REQ === 'B' && p.el('bubble').textContent === 'B body');
  check('S4[页面] 两次确认各一条', JSON.stringify(p.acks) === '["A","B"]');
}

// 场景 5（R3-F01）：反序发布——后发布者 A 世代更高；即使 B 曾先抵达页面，
// A 以更高世代后到也正常替换（世代序=发布序=应用序，全程一致）。
{
  const s = S.s5_reverse_publish_highest_gen_live;
  check('S5[Rust] 反序发布：B 零外投、A（最高世代）发射', s.outcome === 'RetriedDelivered' && s.emitted.length === 1 && JSON.parse(s.emitted[0]).request_id === 'A');
  const genA = JSON.parse(s.emitted[0]).gen;
  check('S5[Rust] A 载荷携带原子注入的世代（gen>0）', typeof genA === 'number' && genA > 0);
  const p = pageContext();
  const apply = loadApplyCapture(p.ctx);
  // B 曾先抵达页面并应用（世代低于 A——反序交错下的早期到达）
  apply({ request_id: 'B', gen: genA - 1, text: 'B body', content: {} });
  apply(JSON.parse(s.emitted[0])); // A 后到但世代最高 → 正常替换
  check('S5[页面] 更高世代 A 正常替换先到的 B（最终 A，无死稿）', p.ctx.REQ === 'A' && p.el('bubble').textContent === 'A body');
  check('S5[页面] 两次确认如实回传', JSON.stringify(p.acks) === '["B","A"]');
}

// 提取物落盘（供复核：两侧均为产品原样代码）
fs.writeFileSync(path.join(OUT, 'page-extracted-applyCapture.js.txt'),
  (() => { const source = fs.readFileSync(path.join(REPO, 'app/ui/capture-mini.html'), 'utf8'); const a = source.indexOf('function applyCapture(d) {'); const b = source.indexOf('\nwindow.applyCapture = applyCapture;', a); return source.slice(a, b); })());
fs.writeFileSync(path.join(OUT, 'bridge-result.json'), JSON.stringify({ pass: PASS, fail: FAIL, rust: rust.json }, null, 2));
fs.writeFileSync(path.join(OUT, 'bridge.log'), logLines.join('\n') + '\n');
log(`delivery-bridge: ${PASS} 项通过，${FAIL} 项失败`);
process.exitCode = FAIL ? 1 : 0;
