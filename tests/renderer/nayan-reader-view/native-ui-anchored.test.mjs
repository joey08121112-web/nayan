// 真实 WKWebView + 产品静态资源；仅 TAPI/API 图标与记录为桩，不触生产数据。
// node tests/renderer/native-ui.test.mjs [--out DIR]
//
// P1-B06-VERIFY-02 断言面（在 VERIFY-01 68 项基线/268 项套件上扩展；原断言全部保留）：
//   ① 四组合（960/1280×浅/深）：VERIFY-01 全部断言 + V1 缺口补齐——
//      敌意窗口封闭对账（hostileSealed.unauthorized/external===0 + gate 字段 + 与全量
//      阶段日志的完整性交叉核对 + runner 侧白名单复算）、侧栏 15px/详情 12px computedH
//      与加载完成、双敌意 fixture（MD+HTML）原始非空/正文存在/格式实际生效/清洗零残留。
//   ② sentinel 跑：逐观察器正向控制（含网络记录器 fetch/img 双路）。
//   ③ C 模式跑：securitypolicyviolation 观察器正向控制。
//   ④ 旧 HEAD 只读副本成对对照：巨图/违例/可拖拽复现。
//   注：V1-F01/F02 的「必败负向控制」（bridge exit 7 / transient exit 8 / JSON 注入回放）
//   在 tests/renderer/native-security-gates.test.mjs——本文件保持纯断言形态（自计数
//   标记行起的代码段可在只读 fs 注入回放中重放；注释中不出现标记原文以防切片误命中）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-native-ui-'));
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : tmp;
fs.mkdirSync(out, { recursive: true });
const bin = path.join(tmp, 'probe');
execFileSync('swiftc', [path.join(repo, 'tests/renderer/native-icon-probe/main.swift'), '-o', bin], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });

let checks = 0;
// runner 侧白名单复算（与探针 __AUTHZ__ 同口径的独立实现——封闭结算不是探针一言堂）。
// 注意：必须位于计数标记行之后——断言回放（总控 assertion-probe 式切片）自该标记
// 行起重放本文件，标记前的定义不进切片。
function authz(e) {
  if (e.cmd === 'js_log') return true;
  if (e.cmd === 'own_icon' || e.cmd === 'app_icon') return true;
  if (e.cmd === 'open_path') return e.phase === 'user-click';
  if (e.cmd === 'api') {
    if (e.method !== 'GET') return false;
    const p = String(e.path || '');
    if (p === '/api/suggestions' || p === '/api/projects' || p === '/api/session-aliases') return true;
    return /^\/api\/suggestions\/\d+\/(content|reader|attachments)$/.test(p);
  }
  return false;
}
const equal = (actual, expected, label) => { assert.equal(actual, expected, label); checks++; };
const ok = (v, label) => { assert.ok(v, label); checks++; };
const served = (r, rel) => (r.servedFiles || []).some(f => f.path === rel && f.status === 200);

// ---------- ① 当前终态四组合 ----------
for (const width of [960, 1280]) {
  for (const theme of ['light', 'dark']) {
    const label = `${width}-${theme}`;
    const file = path.join(out, `native-ui-${label}.json`);
    const shot = path.join(out, `native-ui-${label}.png`);
    execFileSync(bin, [path.join(repo, 'app/ui'), 'N', '1024', file, String(width), theme, shot], { stdio: 'pipe', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    equal(r.measureError, undefined, `${label}: JavaScript 执行`);
    equal(r.fatal, undefined, `${label}: 导航`);
    // —— 配置/服务形态 ——
    equal(r.configSource.readOk, true, `${label}: 产品配置实读成功`);
    ok(r.csp.includes("style-src-attr 'unsafe-inline'"), `${label}: 响应 CSP 含 style-src-attr`);
    ok(r.csp.includes("'nonce-nayan-probe-style'"), `${label}: 响应 CSP style-src 含 nonce`);
    ok(String(r.cspInjection.scriptHash).startsWith("'sha256-"), `${label}: 脚本 hash 为实算非兜底`);
    equal(r.cspInjection.nonceInjected, r.cspInjection.styleBlocksTotal, `${label}: nonce 注入全命中`);
    ok(r.cspInjection.styleBlocksTotal >= 3, `${label}: 样式块≥3`);
    ok(served(r, '/vendor/markdown-it.umd.min.js'), `${label}: markdown-it 经本地 scheme 服务`);
    ok(served(r, '/vendor/purify.min.js'), `${label}: DOMPurify 经本地 scheme 服务`);
    equal(r.vendor.markdownIt, 'function', `${label}: markdown-it 全局可用`);
    equal(r.vendor.DOMPurify, 'function', `${label}: DOMPurify 全局可用`);
    // —— 图标可解码与负向控制 ——
    equal(r.iconDecode.main.decodeOk, true, `${label}: 合成图标独立解码成功`);
    equal(r.iconDecode.main.width, 1024, `${label}: 独立解码宽 1024`);
    equal(r.iconDecode.main.height, 1024, `${label}: 独立解码高 1024`);
    ok(typeof r.iconDecode.main.sha256 === 'string' && r.iconDecode.main.sha256.length === 64, `${label}: 图标 SHA-256 在案`);
    equal(r.iconDecode.corruptControl.decodeOk, false, `${label}: 损坏图标被解码器拒绝`);
    equal(r.corruptImgControl.error, true, `${label}: 损坏图标页内加载报错`);
    equal(r.corruptImgControl.naturalWidth, 0, `${label}: 损坏图标 naturalWidth=0`);
    // —— 几何（宽+高+加载完成）——
    equal(r.brand.img.computedW, '24px', `${label}: 品牌图标`);
    equal(r.brand.img.computedH, '24px', `${label}: 品牌图标高`);
    equal(r.brand.img.complete, true, `${label}: 品牌图标已加载完成`);
    equal(r.brand.img.naturalWidth, 1024, `${label}: 品牌图标为真实大图（1024 自然尺寸）`);
    equal(r.brand.img.rectW, 24, `${label}: 品牌图标不越界（rect=24）`);
    equal(r.icwFirst.img.computedW, '15px', `${label}: 侧栏图标`);
    equal(r.icwFirst.img.computedH, '15px', `${label}: 侧栏图标高`);
    equal(r.icwFirst.img.complete, true, `${label}: 侧栏图标已加载完成`);
    equal(r.uiChecks.chipIcon.img.computedW, '12px', `${label}: 来源图标`);
    equal(r.uiChecks.chipIcon.img.computedH, '12px', `${label}: 来源图标高`);
    equal(r.uiChecks.chipIcon.img.complete, true, `${label}: 来源图标已加载完成`);
    equal(r.uiChecks.resize, 'none', `${label}: 取消拖拽尺寸`);
    equal(r.violations.length, 0, `${label}: CSP 零违例`);
    for (const key of ['sourceName', 'grows', 'capped', 'shrinks', 'noHorizontalOverflow', 'addTextareaResize', 'newQuoteVisible', 'hiddenFocusStrip', 'uniformFields', 'inlineStyleApplied']) {
      equal(r.uiChecks[key], true, `${label}: ${key}`);
    }
    // —— 敌意正文清洗 + 保真（MD + HTML 双入口）——
    equal(r.hostileDetail.aibodyPresent, true, `${label}: 敌意MD条目 aibody 存在`);
    equal(r.hostileDetail.richClass, true, `${label}: 敌意MD条目走 rich 渲染`);
    equal(r.hostileDetail.headings, 1, `${label}: 声明 Markdown 标题渲染`);
    equal(r.hostileDetail.codeFencePresent, true, `${label}: 围栏代码渲染`);
    equal(r.hostileDetail.codeFenceExact, true, `${label}: 围栏代码逐字符相等`);
    equal(r.hostileDetail.scriptTags, 0, `${label}: 敌意MD script 零残留`);
    equal(r.hostileDetail.onAttrs, 0, `${label}: 敌意MD on* 零残留`);
    equal(r.hostileDetail.styleAttrs, 0, `${label}: 敌意MD style 属性零残留`);
    equal(r.hostileDetail.remoteImgs, 0, `${label}: 敌意MD 远程图零残留`);
    equal(r.hostileDetail.jsLinks, 0, `${label}: 敌意MD javascript: 链接零残留`);
    equal(r.hostileHtmlDetail.aibodyPresent, true, `${label}: 敌意HTML条目 aibody 存在`);
    equal(r.hostileHtmlDetail.richClass, true, `${label}: 敌意HTML条目走 rich 渲染`);
    equal(r.hostileHtmlDetail.pTags, 1, `${label}: 声明 HTML 段落渲染（格式实际生效）`);
    equal(r.hostileHtmlDetail.strongText, '白名单标签保留', `${label}: 白名单 strong 精确保留`);
    equal(r.fixtureCheck.htmlStrongExact, true, `${label}: strong 文本与期望逐字符相等`);
    equal(r.hostileHtmlDetail.safeLinks, 1, `${label}: 白名单 https 外链保留`);
    equal(r.hostileHtmlDetail.scriptTags, 0, `${label}: 敌意HTML script 零残留`);
    equal(r.hostileHtmlDetail.imgTags, 0, `${label}: 敌意HTML img 零残留`);
    equal(r.hostileHtmlDetail.iframeTags, 0, `${label}: 敌意HTML iframe 零残留`);
    equal(r.hostileHtmlDetail.onAttrs, 0, `${label}: 敌意HTML on* 零残留`);
    equal(r.hostileHtmlDetail.styleAttrs, 0, `${label}: 敌意HTML style 零残留`);
    equal(r.hostileHtmlDetail.jsLinks, 0, `${label}: 敌意HTML javascript: 链接零残留`);
    // —— fixture 非空（不能空正文安全通过）——
    ok(r.fixtureCheck.mdCanonicalLen > 300, `${label}: MD fixture 原始非空（${r.fixtureCheck.mdCanonicalLen} 字符）`);
    ok(r.fixtureCheck.htmlCanonicalLen > 300, `${label}: HTML fixture 原始非空（${r.fixtureCheck.htmlCanonicalLen} 字符）`);
    ok(r.fixtureCheck.mdBodyTextLen > 100, `${label}: MD 正文存在（${r.fixtureCheck.mdBodyTextLen} 字符）`);
    ok(r.hostileHtmlDetail.bodyTextLen > 10, `${label}: HTML 正文存在（${r.hostileHtmlDetail.bodyTextLen} 字符）`);
    // —— V1-F01/V1-F02 敌意窗口封闭对账（JSON 层；探针另有 exit 码门控）——
    equal(r.hostileInjected, null, `${label}: 正常跑无注入`);
    equal(r.gate.hostileUnauthorized, 0, `${label}: 敌意窗口未授权原生调用=0`);
    equal(r.gate.hostileExternal, 0, `${label}: 敌意窗口外部网络尝试=0`);
    equal(r.hostileSealed.unauthorized.length, 0, `${label}: 封闭结算 unauthorized=0`);
    equal(r.hostileSealed.external.length, 0, `${label}: 封闭结算 external=0`);
    ok(r.hostileSealed.native.length >= 2, `${label}: 敌意窗口确有正常读取调用（窗口覆盖真实渲染）`);
    equal(r.hostileSealed.native.filter(e => e.phase === 'hostile-window').length, r.hostileSealed.native.length, `${label}: 封闭条目全部属敌意窗口`);
    equal(r.phaseNative.filter(e => e.phase === 'hostile-window').length, r.hostileSealed.native.length, `${label}: 封闭结算与全量日志交叉核对一致`);
    equal(r.phaseNative.filter(e => e.phase === 'hostile-window').filter(e => !authz(e)).length, 0, `${label}: runner 侧白名单复算全部放行`);
    equal(r.phaseNetExternal.filter(e => e.phase === 'hostile-window').length, 0, `${label}: 全量外部尝试记录敌意窗口=0`);
    equal(r.hostile.pwnedScript, false, `${label}: 无脚本执行副作用`);
    equal(r.hostile.pwnedImg, false, `${label}: 无 onerror 执行副作用`);
    equal(r.hostile.pwnedHtml, false, `${label}: HTML fixture 脚本未执行`);
    equal(r.hostile.onerrorNodes, 0, `${label}: 正文 onerror/onload 节点为 0`);
    equal(r.hostile.remoteImgs, 0, `${label}: 正文远程图为 0`);
    // —— 树交互 / 图标回退与缓存 ——
    equal(r.tree.segButtons, 2, `${label}: 软件/项目分段存在`);
    equal(r.tree.projModeActive, true, `${label}: 项目树切换生效`);
    ok(r.tree.projRows >= 1, `${label}: 项目树渲染行`);
    equal(r.tree.foldToggled, true, `${label}: 树折叠交互生效`);
    equal(r.tree.selectSetsView, true, `${label}: 选择交互生效`);
    ok(r.iconPaths.icwSlotsProbeToolA >= 2, `${label}: 同工具多槽位`);
    equal(r.iconPaths.emptySlotImg, 0, `${label}: 无图标条目不落 img`);
    ok(r.iconPaths.emptySlotFallbackSvg >= 1, `${label}: 无图标条目回退 svg`);
    ok(r.iconPaths.cacheKeys.includes('nayan-ic-v2-probe-tool-a'), `${label}: 图标缓存 v2 键命中`);
    // —— 截图 ——
    ok(fs.existsSync(shot) && fs.statSync(shot).size > 20000, `${label}: 截图落盘非空`);
    equal(r.screenshot.bytes, fs.statSync(shot).size, `${label}: 截图字节数对账`);
    console.log(`PASS ${label}`);
  }
}

// ---------- ② sentinel 正向控制 ----------
{
  const file = path.join(out, 'native-sentinel-1280-light.json');
  execFileSync(bin, [path.join(repo, 'app/ui'), 'N', '1024', file, '1280', 'light', path.join(out, 'native-sentinel-1280-light.png'), 'sentinel'], { stdio: 'pipe', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  equal(r.measureError, undefined, 'sentinel: JavaScript 执行');
  equal(r.sentinelMode, true, 'sentinel: 模式标记');
  equal(r.sentinel.inlineScriptBlocked, true, 'sentinel: 动态内联脚本被 CSP 拦截');
  equal(r.sentinel.pwnedReadout, true, 'sentinel: 脚本执行读出通道有效');
  equal(r.sentinel.nativeCallLogged, true, 'sentinel: 原生调用观察器有效（阶段化）');
  equal(r.sentinel.remoteAndStylePlanted, true, 'sentinel: DOM 哨兵节点植入');
  equal(r.sentinel.netControlsPlanted, true, 'sentinel: 网络正向控制植入');
  equal(r.hostile.__sentinelRemoteImgSeen, 1, 'sentinel: 远程图 DOM 扫描观察器有效');
  equal(r.hostile.__sentinelStyleAttrSeen, 1, 'sentinel: style 属性扫描观察器有效');
  equal(r.hostile.__sentinelConsoleSeen, true, 'sentinel: console 捕获观察器有效');
  const ctlNet = r.phaseNet.filter(e => String(e.url || '').includes('nayan-sentinel.invalid'));
  ok(ctlNet.some(e => e.type === 'fetch' && e.phase === 'observer-controls'), 'sentinel: fetch 记录器有效');
  ok(ctlNet.some(e => e.type === 'img-src' && e.phase === 'observer-controls'), 'sentinel: img-src 记录器有效');
  equal(r.gate.hostileUnauthorized, 0, 'sentinel: 敌意窗口仍零未授权（哨兵在 observer-controls 阶段，不污染）');
  console.log('PASS sentinel-1280-light（观察器正向控制）');
}

// ---------- ③ C 模式：violation 观察器正向控制 ----------
{
  const file = path.join(out, 'native-csp-C.json');
  execFileSync(bin, [path.join(repo, 'app/ui'), 'C', '1024', file, '1280', 'light'], { stdio: 'pipe', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  equal(r.measureError, undefined, 'C: JavaScript 执行');
  ok(r.violations.length > 0, `C: securitypolicyviolation 观察器有效（实测 ${r.violations.length} 条）`);
  ok(r.violations.some(v => String(v.directive).startsWith('style-src')), 'C: 违例含 style-src 族指令');
  console.log(`PASS C 模式（违例观察器正向控制，${r.violations.length} 条）`);
}

// ---------- ④ 旧 HEAD 只读副本成对对照 ----------
{
  const before = path.join(tmp, 'head-copy');
  const beforeCommit = 'cd2eff47d53f79cefcf93bb7ccba8fd66a883169'; /* READER-CONTRACT-REPAIR-01: pinned legacy-UI baseline (HEAD moved externally mid-batch); expectations unchanged */
  const files = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', beforeCommit, 'app/ui'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).concat(['app/src-tauri/tauri.conf.json']);
  for (const f of files) {
    const dest = path.join(before, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, execFileSync('git', ['-C', repo, 'show', `${beforeCommit}:${f}`], { maxBuffer: 64 * 1024 * 1024 }));
  }
  fs.writeFileSync(path.join(out, 'head-copy-manifest.json'), JSON.stringify({
    note: 'git show HEAD:<path> 只读重建的旧资产副本（不触碰工作树）',
    head: beforeCommit,
    files,
  }, null, 2));
  const file = path.join(out, 'native-before-HEAD-N.json');
  execFileSync(bin, [path.join(before, 'app/ui'), 'N', '1024', file, '1280', 'light', path.join(out, 'native-before-HEAD-N.png')], { stdio: 'pipe', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  equal(r.measureError, undefined, 'before: JavaScript 执行');
  equal(r.fatal, undefined, 'before: 导航');
  equal(r.brand.img.computedW, '1024px', 'before: 旧 UI 品牌图标复现 1024px 巨图');
  equal(r.brand.img.rectW, 1024, 'before: 旧 UI 巨图越界（rect=1024）');
  ok(r.violations.length > 0, `before: 旧形态 style 违例 >0（实测 ${r.violations.length}）`);
  equal(r.uiChecks.resize, 'vertical', 'before: 旧 UI textarea 可拖拽（vertical）');
  ok(!r.csp.includes('style-src-attr'), 'before: 旧配置确无 style-src-attr');
  equal(r.cspInjection.nonceInjected, r.cspInjection.styleBlocksTotal, 'before: 旧副本 nonce 注入同样全命中（同型性）');
  console.log(`PASS before-HEAD-N（旧 UI 失败形态复现：1024px 巨图 + ${r.violations.length} 违例 + 可拖拽）`);
}

console.log(`native-ui(verify-02): ${checks} 项通过，0 项失败`);
