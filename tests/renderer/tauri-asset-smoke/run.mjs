// run.mjs —— tauri-asset-smoke 驱动（P1-B06-FIVE-STEP-2026-10-01 Step5）
// 用法：node tests/renderer/tauri-asset-smoke/run.mjs --out DIR
// 步骤：① 只读复制最终 app/ui → dist-ui（逐文件 SHA-256 manifest）② cargo build --offline
// （独立 crate/lock；tauri 栈版本对账产品 lock）③ 三模式运行（clean/gate-cmd/gate-net），
// 每模式独立临时根+精确退出码断言 ④ Rust IPC 日志 ↔ JS 阶段日志交叉对账 ⑤ 清单化清理。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createRoot, bindChild, waitChild, finishRun } from './lifecycle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const UI = path.join(REPO, 'app/ui');
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const out = path.resolve(argOf('--out') || path.join(HERE, 'run-out'));
fs.mkdirSync(out, { recursive: true });

const log = [];
const note = (l) => { log.push(l); console.log(l); };
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ownedRoots = [];
const children = [];
let failure = null;
const runs = {};
function fail(msg) { throw new Error('DRIVER-FAIL: ' + msg); }

try {
  // ---------- ① 只读复制最终 app/ui → dist-ui + manifest ----------
  const dist = path.join(HERE, 'dist-ui');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const manifest = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(abs).isDirectory()) { fs.mkdirSync(path.join(dist, r), { recursive: true }); walk(abs, r); }
      else {
        fs.copyFileSync(abs, path.join(dist, r));
        manifest.push({ path: '/' + r, bytes: fs.statSync(abs).size, sha256: sha256(abs) });
      }
    }
  };
  walk(UI, '');
  fs.writeFileSync(path.join(dist, '__smoke-manifest.json'), JSON.stringify({ source: 'app/ui（本轮终态只读复制）', files: manifest }, null, 2));
  fs.writeFileSync(path.join(out, 'dist-manifest.json'), JSON.stringify({ source: 'app/ui（本轮终态只读复制）', files: manifest }, null, 2));
  note(`[1] dist-ui 复制 ${manifest.length} 文件（manifest 含逐文件 SHA-256）`);

  // ---------- ② cargo build --offline ----------
  const t0 = new Date();
  execFileSync('cargo', ['build', '--offline'], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  note(`[2] cargo build --offline 完成（${((new Date() - t0) / 1000).toFixed(1)}s）`);
  // 版本对账（tauri 栈 vs 产品 lock）
  const myLock = fs.readFileSync(path.join(HERE, 'Cargo.lock'), 'utf8');
  const prodLock = fs.readFileSync(path.join(REPO, 'app/src-tauri/Cargo.lock'), 'utf8');
  const ver = (lock, name) => { const m = lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`)); return m && m[1]; };
  const stack = ['tauri', 'tauri-build', 'wry', 'tao', 'tauri-runtime-wry', 'tauri-utils', 'tauri-codegen'];
  const compare = {};
  for (const n of stack) compare[n] = { smoke: ver(myLock, n), product: ver(prodLock, n), match: ver(myLock, n) === ver(prodLock, n) };
  fs.writeFileSync(path.join(out, 'dependency-parity.json'), JSON.stringify(compare, null, 2));
  const mismatch = stack.filter((n) => !compare[n].match);
  note(`[2] tauri 栈版本对账：${mismatch.length === 0 ? '全部一致' : '不一致 ' + mismatch.join(',')}`);
  if (mismatch.length) fail('依赖版本与产品 lock 不一致：' + mismatch.join(','));

  const bin = path.join(HERE, 'target/debug/nayan-asset-smoke');

  // ---------- ③ 三模式运行 ----------
  for (const mode of ['clean', 'gate-cmd', 'gate-net', 'gate-unknown', 'gate-path', 'gate-write', 'gate-plugin', 'gate-csp', 'observer-controls']) {
    const record = createRoot('nayan-asset-smoke-' + mode + '-');
    ownedRoots.push(record);
    const root = record.root;
    const t1 = new Date();
    const child = spawn(bin, [], { env: { ...process.env, SMOKE_MODE: mode, SMOKE_RESULT_DIR: root, SMOKE_RUN: record.run }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); bindChild(record, child);
    let so = '', se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    const termination = await waitChild(child, 120000);
    const code = termination.timedOut ? -9 : termination.code ?? -1;
    const t2 = new Date();
    fs.writeFileSync(path.join(out, `asset-smoke-${mode}.stdout.txt`), so);
    fs.writeFileSync(path.join(out, `asset-smoke-${mode}.stderr.txt`), se);
    const resultPath = path.join(root, `asset-smoke-${mode}.json`);
    const hasResult = fs.existsSync(resultPath);
    if (hasResult) fs.copyFileSync(resultPath, path.join(out, `asset-smoke-${mode}.json`));
    runs[mode] = { start: t1.toISOString(), end: t2.toISOString(), exit: code, termination, resultWritten: hasResult, root };
    note(`[3] ${mode}: exit=${code} result=${hasResult}（${((t2 - t1) / 1000).toFixed(1)}s）`);
  }
  fs.writeFileSync(path.join(out, 'run-meta.json'), JSON.stringify({ runs, ownedRoots }, null, 2));

  const clean = JSON.parse(fs.readFileSync(path.join(out, 'asset-smoke-clean.json'), 'utf8'));
  const j = clean.jsResult;

  // ---------- ④ 驱动侧断言（clean） ----------
  const A = (name, ok, detail = '') => { note(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`); if (!ok) fail('断言未过：' + name); };
  A('clean 模式探针 exit 0', runs.clean.exit === 0, `exit=${runs.clean.exit}`);
  A('页面真实就绪（renderDetail/state）', j.pageReady === true);
  A('真实 App URL 与自定义协议', j.protocol === 'tauri:', JSON.stringify(j.protocol));
  A('vendor 从本地资源加载（markdown-it/DOMPurify）', j.vendor.markdownIt === 'function' && j.vendor.DOMPurify === 'function');
  A('新 mapper 模块经真实资源链加载', j.sourceMapModule === 'object');
  // CSP/nonce（真实 Tauri 构建期+服务期证据）
  const csp = String(j.servedCSPHeader || '');
  A('服务期响应 CSP 可读取且含 style-src-attr', csp.includes("style-src-attr 'unsafe-inline'"), csp.slice(0, 120));
  A('服务期 style-src 含真实 nonce（非手工注入）', /'nonce-[^']+'/.test(csp), csp.slice(0, 160));
  A('style 元素带 nonce 属性 ≥3（WebKit nonce-hiding 下用 hasAttribute 取证）', j.styleNonceCount >= 3, JSON.stringify({ count: j.styleNonceCount, total: j.styleTotal, valuesReadable: j.styleNonceValuesReadable }));
  A('内联 style 属性生效（style-src-attr 语义）', j.inlineStyleApplied === true);
  // 敌意清洗 + S04 链
  A('敌意 MD：rich 渲染+标题+围栏逐字符', j.hostileDetail.richClass && j.hostileDetail.headings === 1 && j.hostileDetail.codeFenceText === 'code 原文 · Unicode ✓\n  缩进保留\tTab\n');
  A('敌意 MD：script/on*/style/远程图/javascript: 全零', j.hostileDetail.scriptTags === 0 && j.hostileDetail.onAttrs === 0 && j.hostileDetail.styleAttrs === 0 && j.hostileDetail.remoteImgs === 0 && j.hostileDetail.jsLinks === 0);
  A('敌意 HTML：strong 精确保留+段落+安全外链', j.hostileHtmlDetail.strongText === '白名单标签保留' && j.hostileHtmlDetail.pTags === 1 && j.hostileHtmlDetail.safeLinks === 1);
  A('敌意 HTML：script/img/iframe/on*/style/js 链接全零', j.hostileHtmlDetail.scriptTags === 0 && j.hostileHtmlDetail.imgTags === 0 && j.hostileHtmlDetail.iframeTags === 0 && j.hostileHtmlDetail.onAttrs === 0 && j.hostileHtmlDetail.styleAttrs === 0 && j.hostileHtmlDetail.jsLinks === 0);
  A('S04 sidecar（真实 Tauri 页面）：挂载+条目', j.sidecar.present && j.sidecar.entryCount > 0);
  A('S04 sidecar：身份=信封 request_id、revision 如实 null', j.sidecar.identity && j.sidecar.identity.requestId === 'probe-md' && j.sidecar.identity.revision === null);
  A('S04 sidecar：完整源块 slice 逐字符', j.sidecar.blockExact === true);
  A('S04 sidecar：payload 可用且逐字符', j.sidecar.payloadAvail === true && j.sidecar.payloadSlice === 'code 原文 · Unicode ✓\n  缩进保留\tTab');
  A('fixture 非空（canonical 长度>300/HTML 正文>10）', j.fixtureCheck.mdCanonicalLen > 300 && j.fixtureCheck.htmlBodyTextLen > 10 && j.fixtureCheck.strongExact === true);
  A('树交互（双树/折叠/选择）', j.tree.segButtons === 2 && j.tree.projModeActive && j.tree.foldToggled && j.tree.selectSetsView);
  A('敌意窗口封闭：Rust 分桶未授权原生调用=0 / JS 外部尝试=0', clean.gate.hostileWindowUnauthorized.length === 0 && j.hostileSealed.external.length === 0, JSON.stringify(clean.gate.hostileWindowUnauthorized));
  const controls = JSON.parse(fs.readFileSync(path.join(out,'asset-smoke-observer-controls.json'),'utf8'));
  const cj=controls.jsResult, controlViols=cj.violations || [];
  A('clean: no CSP violations (controls in a separate process)',(j.violations || []).length===0);
  A('isolated controls exit 0',runs['observer-controls'].exit===0);
  A('isolated positive CSP controls cover script/img/connect', ['script-src-elem','img-src','connect-src'].every(d=>controlViols.some(v=>v.directive===d)));
  A('isolated positive network controls: fetch and img observed',cj.sentinel.netControlsPlanted && ['fetch','img-src'].every(t=>cj.phaseNetExternal.some(e=>e.type===t&&e.phase==='observer-controls')));
  A('no page errors / no IPC fallback (observation boundary)', !(j.consoles || []).some(c=>c.startsWith('pageerror:')||c.includes('IPC custom protocol failed')));
  const authorized = e => ['js_log','own_icon','app_icon','smoke_phase','smoke_result'].includes(e.cmd)
    || e.cmd==='api' && e.method==='GET' && (/^\/api\/(suggestions|projects|session-aliases)$/.test(e.path || '')
      || /^\/api\/suggestions\/[1-9][0-9]*\/(content|attachments)$/.test(e.path || '') && Number.isSafeInteger(Number(e.path.split('/')[3])));
  A('clean actual transport hostile attempts independently authorized',j.hostileIpc.length>0 && j.hostileIpc.every(authorized));
  // Rust ↔ JS 交叉对账
  const rustPhases = clean.rustPhases.map((e) => e.phase);
  const wantSeq = ['init', 'body-normal', 'hostile-window', 'user-click', 'observer-controls', 'teardown'];
  A('Rust 侧阶段标记序列完整（真实 IPC smoke_phase 往返）', rustPhases.length===wantSeq.length && wantSeq.every((w, i) => rustPhases[i] === w), JSON.stringify(rustPhases));
  const rustApi = clean.rustLog.filter((e) => e.cmd === 'api');
  A('内容 GET 实际往返 Rust（条目3/5 content）', rustApi.some((e) => e.path === '/api/suggestions/3/content') && rustApi.some((e) => e.path === '/api/suggestions/5/content'), JSON.stringify(rustApi.map((e) => e.path)));
  const hostileApi = rustApi.filter((e) => e.phase === 'hostile-window');
  A('敌意窗口确有真实读取往返（条目3/5 content 在 Rust 日志 hostile-window 分桶）', hostileApi.some((e) => e.path === '/api/suggestions/3/content') && hostileApi.some((e) => e.path === '/api/suggestions/5/content'), JSON.stringify(hostileApi.map((e) => e.path)));
  A('Rust 侧 clean 零未授权探针/零分桶未授权', clean.gate.rustUnauthorizedProbes === 0 && clean.gate.hostileWindowUnauthorized.length === 0);

  // ---------- 门控断言 ----------
  const gc = JSON.parse(fs.readFileSync(path.join(out, 'asset-smoke-gate-cmd.json'), 'utf8'));
  A('gate-cmd：exit 7（抓住）', runs['gate-cmd'].exit === 7, `exit=${runs['gate-cmd'].exit}`);
  A('gate-cmd：命令经真实 IPC 被 Rust 记录并拒绝', gc.gate.rustUnauthorizedProbes === 1 && String(gc.jsResult.hostileInjected).startsWith('rejected'));
  A('gate-cmd：Rust 敌意窗口分桶抓住未授权命令', gc.gate.hostileWindowUnauthorized.some((e) => e.cmd === 'smoke_unauthorized_probe'), JSON.stringify(gc.gate.hostileWindowUnauthorized));
  const gn = JSON.parse(fs.readFileSync(path.join(out, 'asset-smoke-gate-net.json'), 'utf8'));
  A('gate-net：exit 8（抓住）', runs['gate-net'].exit === 8, `exit=${runs['gate-net'].exit}`);
  A('gate-net：瞬时 img（已移除）+fetch 双留痕', gn.jsResult.hostileSealed.external.filter((e) => e.type === 'img-src').length >= 1 && gn.jsResult.hostileSealed.external.filter((e) => e.type === 'fetch').length >= 1);

  for (const [mode,cmd] of [['gate-unknown','open_path'],['gate-path','api'],['gate-write','api'],['gate-plugin','plugin:nayan_absent|probe']]) {
    const r=JSON.parse(fs.readFileSync(path.join(out,`asset-smoke-${mode}.json`),'utf8'));
    A(mode+': actual denied attempt independently fails',runs[mode].exit===7 && r.jsResult.hostileInjected.startsWith('rejected')
      && r.jsResult.hostileIpc.some(e=>e.cmd===cmd&&!authorized(e)));
    if(mode!=='gate-plugin') A(mode+': Rust pre-dispatch receipt present',r.rustLog.some(e=>e.cmd===cmd&&e.phase==='hostile-window')&&r.gate.hostileWindowUnauthorized.length>0);
  }
  const cspNegative=JSON.parse(fs.readFileSync(path.join(out,'asset-smoke-gate-csp.json'),'utf8'));
  A('non-control inline CSP attempt cannot be exempted',runs['gate-csp'].exit===10 && cspNegative.jsResult.violations.length>0);
  // Every hostile application transport attempt has a matching native ingress, not merely a zero counter.
  for (const e of j.hostileIpc.filter(e=>e.cmd!=='smoke_phase')) A('transport/native receipt: '+e.seq,clean.rustLog.some(r=>r.phase==='hostile-window'&&r.cmd===e.cmd&&r.method===e.method&&r.path===e.path));

  note('[5] 全部断言通过；写入 summary');
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ok: true, runs, checkedAt: new Date().toISOString() }, null, 2));
} catch (e) {
  failure = e;
  note(String(e && e.stack || e));
} finally {
  const status = await finishRun({ records: ownedRoots, children, failed: failure,
    writeEvidence: result => {
      fs.writeFileSync(path.join(out, 'owned-temp-roots.json'), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(out, 'driver-run.log'), log.join('\n') + '\n' + JSON.stringify(result) + '\n');
      fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ...result, runs, checkedAt: new Date().toISOString() }, null, 2));
    }
  });
  process.exitCode = status.ok ? 0 : 1;
}
