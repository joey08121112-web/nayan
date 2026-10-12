// P1-B06-VERIFY-02 —— V1-F01/V1-F02 必败负向控制（独立于断言套件的门控验证）。
// node tests/renderer/native-security-gates.test.mjs --out DIR --suite-out DIR
//
// 三个门（每个都有独立 JSON/日志/退出码记录）：
//   A. bridge：探针在敌意窗口注入一次未授权模拟原生调用（TAPI 桩本地返回，不执行
//      真实命令）→ 探针必须 exit 7（抓住）；exit 9=观察器缺陷；exit 0/其他=门控失效。
//   B. transient：敌意窗口注入瞬时外部网络尝试（img 同步插入即移除 + fetch；
//      .invalid 保留域 + CSP 拦截双保险，不外发真实请求）→ 探针必须 exit 8。
//   C. JSON 注入回放（总控 assertion-probe 同法，结果回放而非产品攻击）：对本套件
//      产出的四组合 JSON 干净回放必须通过；注入未授权调用/外部尝试后回放必须抛错
//      （断言拒绝）。「预期失败」的外层本文件以 exit 0 汇总，但内层拒绝与探针非零
//      退出码均被显式断言与记录——不以打印 FAIL 且 exit 0 充数。
// 依赖：先运行 tests/renderer/native-ui.test.mjs --out <suite-out>（C 门读取其四组合 JSON）。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-v2-gates-'));
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; };
const out = arg('--out') || tmp;
const suiteOut = arg('--suite-out');
fs.mkdirSync(out, { recursive: true });
assert.ok(suiteOut, '需要 --suite-out 指向 native-ui.test.mjs 的输出目录（C 门读取四组合 JSON）');
const log = [];
const note = (line) => { log.push(line); console.log(line); };

// 本批唯一临时根清单（finally 只清理清单内确认归属的根/进程）
const ownedRoots = [tmp];
const bin = path.join(tmp, 'probe');
execFileSync('swiftc', [path.join(repo, 'tests/renderer/native-icon-probe/main.swift'), '-o', bin], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
const ui = path.join(repo, 'app/ui');

try {
  // ---------- A. bridge 必败 ----------
  {
    const t0 = new Date();
    const json = path.join(out, 'gate-bridge.json');
    const run = spawnSync(bin, [ui, 'N', '1024', json, '1280', 'light', '', '', 'bridge'], { timeout: 30000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const t1 = new Date();
    fs.writeFileSync(path.join(out, 'gate-bridge.stdout.txt'), run.stdout || '');
    fs.writeFileSync(path.join(out, 'gate-bridge.stderr.txt'), run.stderr || '');
    const r = JSON.parse(fs.readFileSync(json, 'utf8'));
    note(`[A bridge] start=${t0.toISOString()} end=${t1.toISOString()} probeExit=${run.status}（要求 7=抓住）`);
    assert.equal(run.status, 7, `A bridge: 探针退出码必须为 7（抓住未授权调用），实际 ${run.status}`);
    assert.equal(r.hostileInjected, 'bridge', 'A bridge: 注入标记');
    assert.ok(r.hostileSealed.unauthorized.length >= 1, 'A bridge: 敌意窗口封闭结算记录到未授权调用');
    assert.equal(r.hostileSealed.unauthorized[0].cmd, 'open_path', 'A bridge: 抓到的正是注入的 open_path');
    assert.equal(r.hostileSealed.unauthorized[0].phase, 'hostile-window', 'A bridge: 阶段归属正确');
    assert.equal(r.gate.result.includes('AS-DESIGNED'), true, 'A bridge: 门控结论为按设计判负');
    note(`[A bridge] PASS：未授权模拟调用被敌意窗口对账抓住，探针 exit 7（非零）`);
  }

  // ---------- B. transient 必败 ----------
  {
    const t0 = new Date();
    const json = path.join(out, 'gate-transient.json');
    const run = spawnSync(bin, [ui, 'N', '1024', json, '1280', 'light', '', '', 'transient'], { timeout: 30000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const t1 = new Date();
    fs.writeFileSync(path.join(out, 'gate-transient.stdout.txt'), run.stdout || '');
    fs.writeFileSync(path.join(out, 'gate-transient.stderr.txt'), run.stderr || '');
    const r = JSON.parse(fs.readFileSync(json, 'utf8'));
    note(`[B transient] start=${t0.toISOString()} end=${t1.toISOString()} probeExit=${run.status}（要求 8=抓住）`);
    assert.equal(run.status, 8, `B transient: 探针退出码必须为 8（抓住瞬时外部尝试），实际 ${run.status}`);
    assert.equal(r.hostileInjected, 'transient', 'B transient: 注入标记');
    const ext = r.hostileSealed.external;
    assert.ok(ext.length >= 2, 'B transient: img 与 fetch 两条外部尝试均留痕');
    assert.ok(ext.some(e => e.type === 'img-src'), 'B transient: 已移除的 img 仍留痕（记录先于移除）');
    assert.ok(ext.some(e => e.type === 'fetch'), 'B transient: fetch 尝试留痕');
    assert.ok(ext.every(e => e.phase === 'hostile-window'), 'B transient: 阶段归属正确');
    note(`[B transient] PASS：瞬时外部尝试（含插入即移除的 img）被抓到，探针 exit 8（非零）`);
  }

  // ---------- C. JSON 注入回放（断言拒绝门；总控 assertion-probe 同法） ----------
  {
    const source = fs.readFileSync(path.join(repo, 'tests/renderer/native-ui.test.mjs'), 'utf8');
    const assertions = source.slice(source.indexOf('let checks = 0;'));
    const results = [];
    for (const inject of [false, true]) {
      let injected = 0;
      const prints = [];
      const readOnlyFs = {
        ...fs,
        mkdirSync() {},
        writeFileSync() {},
        readFileSync(file, encoding) {
          const raw = fs.readFileSync(file, encoding);
          if (inject && /native-ui-(960|1280)-(light|dark)\.json$/.test(String(file))) {
            const d = JSON.parse(raw);
            // 与总控回放同目的：向结果数据塞入“不应出现”的安全事件
            d.hostileSealed.unauthorized.push({ phase: 'hostile-window', seq: 99999, cmd: 'unexpected_body_native_command' });
            d.hostileSealed.external.push({ phase: 'hostile-window', seq: 99998, type: 'img-src', url: 'https://evil.invalid/transient.png' });
            d.gate.hostileUnauthorized = d.hostileSealed.unauthorized.length;
            d.gate.hostileExternal = d.hostileSealed.external.length;
            injected++;
            return JSON.stringify(d);
          }
          return raw;
        }
      };
      const context = {
        repo, tmp: '/tmp/v2-gates-replay-not-created', out: suiteOut,
        bin: 'native-probe-not-executed', path, fs: readOnlyFs, assert,
        console: { log: (...args) => prints.push(args.join(' ')) },
        execFileSync(cmd, args2) {
          if (cmd === 'git' && args2.includes('ls-tree')) return 'app/ui/index.html\n';
          if (cmd === 'git' && args2.includes('rev-parse')) return 'replay-only-head\n';
          return Buffer.from('');
        }
      };
      try {
        vm.runInNewContext(assertions, context);
        results.push({ inject, injected, assertionsAccepted: true, prints });
      } catch (e) {
        results.push({ inject, injected, assertionsAccepted: false, error: String(e).slice(0, 300), prints });
      }
    }
    fs.writeFileSync(path.join(out, 'gate-replay-result.json'), JSON.stringify({
      method: '断言代码回放（只读 fs + 结果注入；非产品攻击、非原生执行）', results
    }, null, 2));
    note(`[C replay] clean=${results[0].assertionsAccepted} inject=${results[1].assertionsAccepted} injected=${results[1].injected}`);
    assert.equal(results[0].assertionsAccepted, true, 'C replay: 干净数据回放必须通过');
    assert.ok(results[1].injected >= 1, 'C replay: 至少注入一次（严格断言在首个注入文件即抛错，故可能 <4——这正是拒绝语义）');
    assert.equal(results[1].assertionsAccepted, false, 'C replay: 注入未授权调用/外部尝试后断言必须拒绝（非零语义）');
    note('[C replay] PASS：注入后断言抛错拒绝——V1 盲区（注入仍全过）已闭合');
  }

  note('native-security-gates: 3 门全部按设计工作（bridge exit7 / transient exit8 / 注入回放拒绝）');
} finally {
  fs.writeFileSync(path.join(out, 'gates-run.log'), log.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'owned-temp-roots.json'), JSON.stringify({ roots: ownedRoots }, null, 2));
  // 只清理本文件确认归属的临时根（唯一 mkdtemp 记录在案；失败也保留证据文件于 out）
  try { execFileSync('rm', ['-rf', ...ownedRoots], { stdio: 'ignore' }); } catch (_) {}
}
