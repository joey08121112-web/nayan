// tests/renderer/real-app-v4.test.mjs —— 第四版新功能在真实 App 后端上的端到端走查
// 真实 Rust App（测试档案 + 隔离 SQLite + 测试端口）+ 真实 index.html（无头 Chrome，CDP 真键盘/鼠标/输入法事件）：
//   S  搜索：⌘F 打开并聚焦、中文输入法拼字中不重画、多词同时出现、筛选、结果里 J 逐条读、「回到搜索」保留词与筛选
//   C  最近待看右键菜单：右键弹出、重命名、钉住/取消、钉住的移到清单（状态回 inbox）、到日期清单「等什么」、
//      改归属项目、归档、复制原文（旧行 / 信封行）、删除要点两下
//   T  「记一条」长文本：标题按统一规则、原文完整
//   P  R7 说一句计划：芯片、⌘⏎ 确认卡、钉到钉板（我写的 + 已钉住 + 步骤带时间）、卡片时间列
//   A  AI 来源：不用 AI 时拆步零请求；开了 AI 首次提示、AI 不可用回退按时间点拆
//   K  设置 › AI 页填 Key：测试连接前先保存、保存设置可用
//   D  钉板到期提醒条：出现、「钉住，开始做」、「再等等 → 明天」
// 用法：node tests/renderer/real-app-v4.test.mjs [--out DIR]   （不传 --out 时写到系统临时目录，绝不写进仓库）
// 前提：app/src-tauri/target/debug/nayan 已构建（cargo build）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { synthEnvelope, REPO, UI_DIR, APP_BIN } from './fixtures.mjs';
import { startChrome, CDP } from './cdp.mjs';
import { checkOnboarding } from './onboarding-checks.mjs';

const require = createRequire(import.meta.url);
const { shortTitle } = require(path.join(REPO, 'app/ui/title-rule.js'));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-realapp-v4-out-'));
fs.mkdirSync(outDir, { recursive: true });

let fail = 0, pass = 0;
function check(c, name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${c}] ${name}${ok ? '' : '  <<< ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

if (!fs.existsSync(APP_BIN)) { console.error('找不到 App debug 二进制：' + APP_BIN); process.exit(2); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-realapp-v4-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const appLog = path.join(outDir, 'realapp-v4-app.log');
const app = spawn(APP_BIN, [], {
  cwd: os.tmpdir(),
  env: { ...process.env, NAYAN_TEST_PROFILE: root, NAYAN_TEST_UI_DIR: UI_DIR, NAYAN_TEST_PORT: String(port), NAYAN_TEST_RUN_ID: 'v4-' + Date.now() },
  stdio: ['ignore', fs.openSync(appLog, 'a'), fs.openSync(appLog, 'a')],
});
const base = `http://127.0.0.1:${port}`;
async function api(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}
const item = async (id) => (await api('GET', '/api/suggestions')).find((x) => x.id === id) || null;

const chromeProc = await startChrome([], {logFile:path.join(outDir,'chrome.log')});
chromeProc.child.on('exit', (code, signal) => console.log(`Chrome 测试进程退出：code=${code}, signal=${signal}`));
let cdp;
process.on('exit', () => { try { cdp && cdp.close(); } catch (_) {} try { chromeProc.child.kill(); } catch (_) {} try { app.kill(); } catch (_) {} });

// ---- 真实输入：键盘 / 鼠标 / 输入法 ----
async function key(k, { meta = false, code, vk } = {}) {
  const p = { key: k, code: code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), windowsVirtualKeyCode: vk || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0), modifiers: meta ? 4 : 0 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  if (k.length === 1 && !meta) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: k, ...p });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
}
const enter = () => key('Enter', { code: 'Enter', vk: 13 });
async function rectOf(sel) {
  return cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`);
}
async function click(sel, button = 'left') {
  const r = await rectOf(sel);
  if (!r) throw new Error('找不到元素 ' + sel);
  const b = { x: r.x, y: r.y, button, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b });
  await sleep(120);
}
async function waitFor(expr, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cdp.eval(expr)) return true; await sleep(60); }
  return false;
}
const reload = async () => { await cdp.eval('load(false)'); await sleep(250); };

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/suggestions')).ok; } catch (_) {} if (!up) await sleep(200); }
  if (!up) throw new Error('App HTTP 未就绪（见 ' + appLog + '）');
  check('R0', '真实 App 启动（隔离档案 ' + path.basename(root) + '）', true);
  cdp = await CDP.connect(chromeProc.cdpPort);
  await checkOnboarding({cdp,api,base,check,click,waitFor,sleep});

  // ---------- 造数据 ----------
  const lists = await api('GET', '/api/lists');
  const later = lists.find((l) => l.mode === 'date'), ref = lists.find((l) => l.mode === 'none');
  check('R0', 'v3 预置清单在（到日期提醒 + 不提醒）', !!later && !!ref, lists);
  const mk = (b) => api('POST', '/api/suggestions', { kind: 'suggestion', source_tool: 'claude', ...b });
  const legacyQuote = '旧行原文第一行\r\n第二行 · 纳言 搜索 关键词';
  const a = await mk({ title: '纳言 搜索入口设计', quote: '侧栏加一行搜索，⌘F 打开整页搜索。', workspace: '/p/纳言' });
  const b = await mk({ title: '右键菜单方案', quote: '最近待看右键：重命名、钉住、移到清单。纳言 的菜单复用 .menu。', workspace: '/p/纳言' });
  const c = await mk({ title: '旧行条目', quote: legacyQuote, workspace: '/p/别的' });
  const envOriginal = '信封原文\r\n保留 CRLF 与\t制表\n纳言';
  const d = await mk({ title: '信封条目', request_id: 'v4-env-1', content: synthEnvelope(envOriginal, 'v4-env-1') });
  const e = await mk({ title: '要删掉的条目', quote: '删除测试' });
  const pinned = await mk({ title: '钉住的条目', quote: '钉住后移到清单应回到 inbox' });
  await api('PATCH', '/api/suggestions/' + pinned.id, { status: 'todo' });
  const arch = await mk({ title: '归档里的 纳言 条目', quote: '归档也能搜到 纳言' });
  await api('PATCH', '/api/suggestions/' + arch.id, { status: 'done' });
  check('R1', '造 7 条数据', [a, b, c, d, e, pinned, arch].every((x) => x && x.id > 0));

  await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: base }).catch(() => {});
  await cdp.go(base + '/');
  check('R1', '页面加载并取到数据', await waitFor('state.items.length>=7', 8000));

  // ======================= S 搜索 =======================
  await cdp.eval('document.body.focus()');
  await key('f', { meta: true });
  check('S1', '⌘F（真键盘事件）打开搜索页', await waitFor(`state.view.t==='search'`));
  check('S1', '搜索框获得焦点', await waitFor(`document.activeElement && document.activeElement.id==='sq'`));
  // 输入法：拼字中（未上屏）不重画结果
  await cdp.send('Input.imeSetComposition', { text: 'nayan', selectionStart: 5, selectionEnd: 5 });
  await sleep(350);
  check('S2', '输入法拼字中不触发搜索（state.search.q 仍为空）', await cdp.eval(`state.search.q===''`), await cdp.eval('state.search.q'));
  await cdp.send('Input.insertText', { text: '纳言' });
  await sleep(350);
  const s2 = await cdp.eval(`({ v: gid('sq').value, q: state.search.q, focus: document.activeElement.id, n: document.querySelectorAll('#sres [data-sopen]').length, marks: document.querySelectorAll('#sres mark').length })`);
  check('S2', '上屏后搜索「纳言」：输入框值正确、焦点还在', s2.v === '纳言' && s2.q === '纳言' && s2.focus === 'sq', s2);
  check('S2', '跨状态命中（含归档里的那条）', s2.n === 5 && s2.marks > 0, s2);
  await cdp.send('Input.insertText', { text: ' 菜单' });
  await sleep(350);
  const s3 = await cdp.eval(`[...document.querySelectorAll('#sres [data-sopen]')].map(x=>Number(x.getAttribute('data-sopen')))`);
  check('S3', '多词「纳言 菜单」须同时出现 → 只剩右键菜单方案', s3.length === 1 && s3[0] === b.id, s3);
  // 回到单词，切到「收件箱」筛选
  await cdp.eval(`(() => { const i = gid('sq'); i.value = '纳言'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  await click('[data-sf="inbox"]');
  const s4 = await cdp.eval(`({ f: state.search.f, n: document.querySelectorAll('#sres [data-sopen]').length })`);
  check('S4', '筛选「收件箱」生效', s4.f === 'inbox' && s4.n === 4, s4);
  await click('#sres [data-sopen]');
  const pos1 = await cdp.eval(`({ t: state.view.t, pos: (document.querySelector('.rbar .pos')||{}).textContent, back: (document.querySelector('[data-nav="back"]')||{}).textContent })`);
  check('S5', '点结果进入 sread，显示「1 / 4」与「回到搜索」', pos1.t === 'sread' && pos1.pos === '1 / 4' && /回到搜索/.test(pos1.back || ''), pos1);
  await cdp.eval('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  await key('j');
  check('S5', 'J（真键盘）在搜索结果里走到「2 / 4」', await waitFor(`(document.querySelector('.rbar .pos')||{}).textContent==='2 / 4'`), await cdp.eval(`(document.querySelector('.rbar .pos')||{}).textContent`));
  await click('[data-nav="back"]');
  const s6 = await cdp.eval(`({ t: state.view.t, v: gid('sq').value, f: state.search.f, on: (document.querySelector('.schip.on')||{}).getAttribute && document.querySelector('.schip.on').getAttribute('data-sf') })`);
  check('S6', '「回到搜索」：搜索词与筛选都还在', s6.t === 'search' && s6.v === '纳言' && s6.f === 'inbox' && s6.on === 'inbox', s6);
  await cdp.screenshot(path.join(outDir, 'v4-search.png'));

  // ======================= C 右键菜单 =======================
  await cdp.eval(`state.view={t:'board'}; renderAll(false)`);
  await sleep(200);
  const openCtx = async (id) => { await click(`#recentList [data-rid="${id}"]`, 'right'); return waitFor('!!CTX.el', 1500); };
  const ctxItem = (act) => `.ctxmenu [data-cx="${act}"]`;

  check('C1', '右键（真鼠标右键）弹出菜单', await openCtx(a.id));
  const items = await cdp.eval(`[...CTX.el.querySelectorAll('[data-cx]')].map(x=>x.getAttribute('data-cx'))`);
  check('C1', '菜单项齐全（无来源时不出现「回到来源」）', JSON.stringify(items) === JSON.stringify(['rename', 'pin', 'move', 'arch', 'copy', 'proj', 'del']), items);
  await cdp.screenshot(path.join(outDir, 'v4-ctxmenu.png'));
  await key('Escape', { code: 'Escape', vk: 27 });
  check('C1', 'Esc 关闭菜单', await waitFor('!CTX.el', 1000));

  // 重命名
  await openCtx(a.id); await click(ctxItem('rename'));
  check('C2', '重命名：侧栏行变成输入框并聚焦', await waitFor(`document.activeElement && document.activeElement.classList.contains('recent-edit')`));
  await cdp.eval(`document.activeElement.select()`);
  await cdp.send('Input.insertText', { text: '改过的搜索入口' });
  await enter();
  await sleep(400);
  check('C2', '⏎ 保存进库', (await item(a.id)).title === '改过的搜索入口', (await item(a.id)).title);

  // 钉住 / 取消钉住
  await openCtx(b.id); await click(ctxItem('pin')); await sleep(400);
  check('C3', '钉住 → status=todo', (await item(b.id)).status === 'todo', (await item(b.id)).status);
  await reload(); await openCtx(b.id);
  check('C3', '已钉住时菜单写「取消钉住」', await cdp.eval(`document.querySelector('${ctxItem('pin')}').textContent==='取消钉住'`));
  await click(ctxItem('pin')); await sleep(400);
  check('C3', '取消钉住 → status=inbox', (await item(b.id)).status === 'inbox', (await item(b.id)).status);

  // 钉住的条目移到不提醒清单：状态应回 inbox（在清单里 = inbox + list_id）
  await reload(); await openCtx(pinned.id);
  await cdp.eval(`(() => { const m = document.querySelector('${ctxItem('move')}'); m.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`);
  check('C4', '悬停「移到清单」出现子菜单', await waitFor('!!CTX.sub', 1000));
  await click(`.ctxmenu.sub [data-cxl="${ref.id}"]`); await sleep(400);
  const p4 = await item(pinned.id);
  check('C4', '钉住的条目移到「' + ref.name + '」后 status=inbox、list_id 正确', p4.status === 'inbox' && p4.list_id === ref.id, { status: p4.status, list_id: p4.list_id });

  // 到日期清单：等什么
  await reload(); await openCtx(c.id);
  await cdp.eval(`document.querySelector('${ctxItem('move')}').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await waitFor('!!CTX.sub', 1000);
  await click(`.ctxmenu.sub [data-cxl="${later.id}"]`);
  check('C5', '到日期清单先问「等什么？」', await waitFor(`document.activeElement && document.activeElement.id==='cxWait'`));
  await cdp.send('Input.insertText', { text: '11月20日' });
  await enter(); await sleep(400);
  const now = new Date(); let want = new Date(now.getFullYear(), 10, 20); if (want < new Date(now.getFullYear(), now.getMonth(), now.getDate())) want = new Date(now.getFullYear() + 1, 10, 20);
  const p5 = await item(c.id);
  check('C5', '写进 wait_note 与 remind_on', p5.list_id === later.id && p5.wait_note === '11月20日' && p5.remind_on === ymd(want), { list_id: p5.list_id, wait_note: p5.wait_note, remind_on: p5.remind_on });
  // 移回收件箱，后面还要用它测复制
  await api('PATCH', '/api/suggestions/' + c.id, { list_id: null });

  // 改归属项目
  await reload(); await openCtx(b.id); await click(ctxItem('proj'));
  check('C6', '改归属项目：菜单换成输入框', await waitFor(`document.activeElement && document.activeElement.id==='cxProj'`));
  await cdp.eval(`document.activeElement.select()`);
  await cdp.send('Input.insertText', { text: '/p/新项目' });
  await enter(); await sleep(400);
  check('C6', 'workspace 写进库', (await item(b.id)).workspace === '/p/新项目', (await item(b.id)).workspace);

  // 复制原文：旧行取 quote 原样（含 CRLF），信封行取 original.text
  const readClip = () => cdp.eval(`navigator.clipboard.readText().catch(e => 'ERR:' + e.message)`);
  await reload(); await openCtx(c.id); await click(ctxItem('copy')); await sleep(400);
  const clipC = await readClip();
  check('C7', '复制原文（旧行）= 保存的 quote 原样', clipC === legacyQuote, JSON.stringify(clipC));
  await openCtx(d.id); await click(ctxItem('copy')); await sleep(400);
  const clipD = await readClip();
  check('C7', '复制原文（信封行）= original.text（CRLF/制表保留）', clipD === envOriginal, JSON.stringify(clipD));

  // 归档
  await reload(); await openCtx(b.id); await click(ctxItem('arch')); await sleep(400);
  check('C8', '归档 → status=done', (await item(b.id)).status === 'done', (await item(b.id)).status);

  // 删除要点两下
  await reload(); await openCtx(e.id); await click(ctxItem('del')); await sleep(300);
  const armed = await cdp.eval(`({ open: !!CTX.el, cls: document.querySelector('${ctxItem('del')}').className, txt: document.querySelector('${ctxItem('del')}').textContent })`);
  check('C9', '第一下只变红「确定删除？再点一次」，不删', armed.open && /armed/.test(armed.cls) && armed.txt === '确定删除？再点一次' && !!(await item(e.id)), armed);
  await click(ctxItem('del')); await sleep(400);
  check('C9', '第二下才删除', (await item(e.id)) === null);

  // ======================= T 「记一条」标题规则 =======================
  await cdp.eval(`state.view={t:'board'}; renderAll(false)`);
  const longText = '明天下午给王老师回邮件，确认下周的课表安排和教室，顺便问一下期中考试的时间';
  await sleep(200);
  await click('#boardQuick');
  await cdp.send('Input.insertText', { text: longText });
  const t0 = await cdp.eval(`({ focus: document.activeElement && document.activeElement.id, v: gid('boardQuick').value.length, home: document.body.classList.contains('view-home') })`);
  await enter(); await sleep(800);
  const all = await api('GET', '/api/suggestions');
  const t1 = all.find((x) => x.quote === longText);
  check('T1', '「记一条」长文本：标题按统一规则、原文完整', !!t1 && t1.title === shortTitle(longText) && t1.title.endsWith('…'), t1 ? { title: t1.title, quote: t1.quote } : { before: t0, last: all.slice(-2).map((x) => [x.title, x.quote]) });

  // ======================= P 说一句计划，排成清单（R7，没配 AI） =======================
  const planText = '今天：9 点和设计组过稿，10:30 改收录弹窗，下午 3 点去医院复查，晚上整理周报';
  await cdp.eval(`state.view={t:'board'}; renderAll(false)`); await sleep(150);
  await click('#boardQuick');
  await cdp.send('Input.insertText', { text: planText });
  await sleep(200);
  check('P1', '写到两个以上时间点出现「排成清单」芯片', await cdp.eval(`!gid('boardPlan').hidden`));
  await key('Enter', { meta: true, code: 'Enter', vk: 13 });
  check('P2', '⌘⏎ 打开确认卡（4 步）', await waitFor(`!gid('planSheet').hidden && gid('planSheet').querySelectorAll('.prow').length===4`));
  await cdp.screenshot(path.join(outDir, 'v4-plansheet.png'));
  await click('[data-pact="pin"]'); await sleep(800);
  const plan = (await api('GET', '/api/suggestions')).find((x) => x.quote === planText);
  check('P3', '钉到钉板：我写的、已钉住、步骤带时间', !!plan && plan.source_tool === 'me' && plan.status === 'todo'
    && JSON.stringify((plan.steps || []).map((x) => x.content)) === JSON.stringify(['09:00 和设计组过稿', '10:30 改收录弹窗', '15:00 去医院复查', '晚上 整理周报']),
    plan && { source: plan.source_tool, status: plan.status, steps: (plan.steps || []).map((x) => x.content) });
  const card = await cdp.eval(`(() => { const c = [...document.querySelectorAll('.bcard')].find(x => x.textContent.includes('今天的计划')); return c ? [...c.querySelectorAll('.bstep .tm')].map(x => x.textContent) : null; })()`);
  check('P4', '钉板卡片出现时间列', JSON.stringify(card) === JSON.stringify(['09:00', '10:30', '15:00', '晚上']), card);
  await cdp.screenshot(path.join(outDir, 'v4-plancard.png'));

  // ======================= A AI 来源：没开 AI 不发请求；开了但 AI 不可用时回退 =======================
  await cdp.eval(`window.__aiReq=[]; (function(){ var o=window.fetch; window.fetch=function(u,opt){ if(String(u).indexOf('/api/ai/')>=0||String(u).indexOf('/ai-split')>=0) window.__aiReq.push(String(u)); return o.apply(this,arguments); }; })()`);
  const sp = await mk({ title: '拆步测试', quote: '第一步打开设置\n第二步填 Key\n第三步测试连接' });
  await reload();
  check('A1', '测试档案默认「不用 AI」', (await api('GET', '/api/settings')).ai_source === 'none');
  await cdp.eval(`openItem(${sp.id})`); await sleep(400);
  await click('[data-act="aisplit"]'); await sleep(700);
  const spSteps = ((await item(sp.id)).steps || []).map((x) => x.content);
  check('A1', '不用 AI：「＋ 拆成步骤」按行拆成 3 步', JSON.stringify(spSteps) === JSON.stringify(['第一步打开设置', '第二步填 Key', '第三步测试连接']), spSteps);
  check('A1', '不用 AI：零个 AI 请求', (await cdp.eval('window.__aiReq.length')) === 0, await cdp.eval('window.__aiReq'));
  // 打开 AI（隔离档案里的假 Key），测试模式下 /api/ai/plan 一定回退
  await api('POST', '/api/settings', { provider: 'deepseek', base_url: '', model: '', api_key: 'test-key-not-real', ai_source: 'own' });
  await cdp.eval(`api('GET','/api/settings').then(setAiState)`); await sleep(200);
  await cdp.eval(`state.view={t:'board'}; renderAll(false)`); await sleep(150);
  await click('#boardQuick');
  await cdp.send('Input.insertText', { text: '9点开会，10点写周报，11点发版' });
  await sleep(150);
  await key('Enter', { meta: true, code: 'Enter', vk: 13 });
  check('A2', '开了 AI：第一次用先弹提示，说明发给谁', await waitFor(`!!document.querySelector('.aiconsent') && /api\.deepseek\.com/.test(document.querySelector('.aiconsent').textContent)`));
  await click('.aiconsent [data-c="yes"]'); await sleep(900);
  const a2 = await cdp.eval(`({ badge: (gid('planSheet').querySelector('.badge')||{}).textContent, rows: gid('planSheet').querySelectorAll('.prow').length, req: window.__aiReq.slice() })`);
  check('A2', 'AI 不可用时回退成按时间点拆（标签照实写）', a2.badge === '按时间点拆 · 没用 AI' && a2.rows === 3 && a2.req.some((u) => u.endsWith('/api/ai/plan')), a2);
  check('A2', '同意记进设置，下次不再问', ((await api('GET', '/api/settings')).ai_consent || []).includes('plan'));
  await click('[data-pact="cancel"]');
  await cdp.eval(`gid('boardQuick').value=''`);
  await api('POST', '/api/settings', { ai_source: 'none' });
  await cdp.eval(`api('GET','/api/settings').then(setAiState)`);

  // ======================= K 设置 › AI：在 AI 页填 Key（之前点保存会因读不到捕获页的开关而整个失败） =======================
  await cdp.eval(`openSettings(); ssSetCat('ai')`); await sleep(500);
  await click('#segSource [data-src="own"]'); await sleep(400);
  check('K1', '切到「自己的 Key」后出现服务商与 Key 输入框', await waitFor(`!gid('aiOwn').hidden && !!gid('s-key')`));
  await click('#segProvider [data-v="deepseek"]'); await sleep(150);
  await click('#s-key');
  await cdp.send('Input.insertText', { text: 'sk-test-only-0001' });
  await click('#testSet'); await sleep(800);
  const k1 = await api('GET', '/api/settings');
  check('K1', '填完 Key 直接点「测试连接」：Key 和服务商先保存下来', k1.has_key === true && k1.provider === 'deepseek' && k1.ai_source === 'own', { has_key: k1.has_key, provider: k1.provider, source: k1.ai_source });
  await click('#s-model'); await cdp.eval(`gid('s-model').select()`);
  await cdp.send('Input.insertText', { text: 'deepseek-reasoner' });
  await click('#saveSet'); await sleep(600);
  const k2 = await api('GET', '/api/settings');
  check('K2', '「保存设置」在 AI 页能存（填的模型名不被预设覆盖、Key 留空不清掉已存的）', k2.model === 'deepseek-reasoner' && k2.has_key === true, { model: k2.model, has_key: k2.has_key });
  await cdp.eval(`closeSettings()`);
  await api('POST', '/api/settings', { ai_source: 'none' });
  await cdp.eval(`api('GET','/api/settings').then(setAiState)`);

  // ======================= R9 真实验收发现的设置分类与框选入口 =======================
  // 入口按原型放在钉板输入框的「⌥Z 框选」提示上（侧栏底部只留「设置」）；从别的视图点「记一条」回到钉板即可见
  for(const view of ['board']){
    await cdp.eval(`state.view={t:${JSON.stringify(view)}}; renderAll(false)`);
    check('BOX-ENTRY','框选按钮在 '+view+' 视图可见',await cdp.eval("(() => { const e=gid('screenCapture'),r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility!=='hidden'; })()"));
  }
  check('BOX-ENTRY','侧栏底部只有「设置」，说明文字不被挤成多行',await cdp.eval("(() => { const m=document.querySelector('.me'); return m.querySelectorAll('button').length===1 && !m.querySelector('#screenCapture'); })()"));
  await api('POST','/api/settings',{clipboard_watch:true});
  await cdp.eval("openSettings(); ssSetCat('capture')");
  check('SET-CAT','捕获分类如实读回监听已开启',await waitFor("!!gid('s-clip') && gid('s-clip').checked===true"));
  await click('#s-clip');
  await cdp.eval("ssSetCat('ai'); ssSetCat('general'); ssSetCat('capture')");
  await sleep(450);
  check('SET-CAT','保存期间快速切分类不报错，监听关闭在界面和后端一致',!(await api('GET','/api/settings')).clipboard_watch&&await cdp.eval("gid('s-clip').checked===false && !/null is not an object|Cannot set properties/.test(gid('err').textContent)"));
  await cdp.eval('closeSettings()');

  // ======================= D 到期提醒条 =======================
  await cdp.eval("state.view={t:'board'}; renderAll(false)");
  const today = ymd(new Date());
  const due1 = await mk({ title: '到期一', quote: 'x', list_id: later.id, wait_note: '今天', remind_on: today });
  const due2 = await mk({ title: '到期二', quote: 'y', list_id: later.id, wait_note: '今天', remind_on: today });
  await reload();
  const bar = await cdp.eval(`(() => { const b = document.querySelector('.duebar'); return b ? { id: Number(b.getAttribute('data-due')), txt: b.textContent } : null; })()`);
  check('D1', '钉板顶部出现到期提醒条（先到期、id 小的在前，提示还有 1 件）', !!bar && bar.id === due1.id && /还有 1 件/.test(bar.txt), bar);
  await cdp.screenshot(path.join(outDir, 'v4-duebar.png'));
  await click('[data-dact="start"]'); await sleep(500);
  const d1 = await item(due1.id);
  check('D2', '「钉住，开始做」→ status=todo，离开清单', d1.status === 'todo' && d1.list_id === null, { status: d1.status, list_id: d1.list_id });
  await reload();
  await click('[data-dact="snooze"]');
  check('D3', '「再等等」弹出推迟菜单', await waitFor(`!gid('snoozeMenu').hidden`, 1000));
  await click('[data-snooze="1"]'); await sleep(500);
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  check('D3', '选「明天」→ remind_on 改成明天、仍在清单里', (await item(due2.id)).remind_on === ymd(tm) && (await item(due2.id)).list_id === later.id, await item(due2.id));
  await reload();
  check('D3', '推迟后提醒条消失', await cdp.eval(`!document.querySelector('.duebar')`));

  // ======================= R9 最近删除 =======================
  await api('POST','/api/trash/empty'); // 本测试的隔离库
  const archived=await mk({title:'完成归档 · 测试样本',quote:'验收使用的假数据'});
  await api('PATCH','/api/suggestions/'+archived.id,{status:'done'});
  const trashA=await mk({title:'框选内容 · 等待整理',quote:'回收站独有关键词 R9ONLY',source_tool:'zcode'});
  await reload(); await openCtx(trashA.id); await click(ctxItem('del')); await click(ctxItem('del')); await sleep(400);
  check('TR1','普通删除移入最近删除并显示撤销',!await item(trashA.id)&&(await api('GET','/api/suggestions?trash=1')).some(x=>x.id===trashA.id)&&await cdp.eval("!!gid('trashUndo')"));
  check('TR1','最近待看和钉板都不显示已删除条目',await cdp.eval(`!document.querySelector('[data-rid="${trashA.id}"]') && !document.querySelector('#board [data-id="${trashA.id}"]')`));
  await click('#trashUndo'); await sleep(350);
  check('TR2','撤销恢复正文和原状态',(await item(trashA.id))?.quote==='回收站独有关键词 R9ONLY'&&!(await api('GET','/api/suggestions?trash=1')).some(x=>x.id===trashA.id));
  await cdp.eval(`openItem(${trashA.id})`); await sleep(300);
  const next=await cdp.eval(`adjId(${trashA.id},1)||adjId(${trashA.id},-1)`);
  await click('.dmenu summary'); await click('[data-act="del"]'); await sleep(400);
  check('TR3','阅读页删除后移到下一条并可撤销',!await item(trashA.id)&&await cdp.eval(`state.sel===${next} && !!gid('trashUndo')`));
  await cdp.eval(`state.view={t:'archive'}; renderAll(false)`); await sleep(120);
  check('TR4','归档底部显示最近删除、期限和删除时间',await cdp.eval(`!!gid('recentlyDeleted') && gid('recentlyDeleted').textContent.includes('30 天后自动清空') && gid('recentlyDeleted').textContent.includes('删除于')`));
  await cdp.screenshot(path.join(outDir,'r9-archive-with-trash.png'));
  await cdp.eval("document.body.classList.add('dark')");
  await sleep(250);
  await cdp.screenshot(path.join(outDir,'r9-archive-with-trash-dark.png'));
  await cdp.eval("document.body.classList.remove('dark')");
  await sleep(250);
  await click(`[data-trash="restore"][data-id="${trashA.id}"]`); await sleep(350);
  check('TR5','归档页恢复条目、空回收站整节隐藏',!!await item(trashA.id)&&await cdp.eval("!gid('recentlyDeleted')"));
  await cdp.screenshot(path.join(outDir,'r9-archive-without-trash.png'));
  await api('DELETE','/api/suggestions/'+trashA.id); await reload();
  await cdp.eval(`state.search={q:'R9ONLY',f:'all'}; goSearch()`); await sleep(150);
  check('TR6','全局搜索搜不到已删除条目',await cdp.eval(`searchHits().every(x=>x.id!==${trashA.id}) && !document.querySelector('#board [data-sid="${trashA.id}"]')`));
  await cdp.eval(`state.view={t:'archive'}; renderAll(false)`);
  await click(`[data-trash="purge"][data-id="${trashA.id}"]`);
  check('TR7','彻底删除第一下只确认、不删数据',(await api('GET','/api/suggestions?trash=1')).some(x=>x.id===trashA.id)&&await cdp.eval(`document.querySelector('[data-trash="purge"][data-id="${trashA.id}"]').classList.contains('armed')`));
  await click(`[data-trash="purge"][data-id="${trashA.id}"]`); await sleep(350);
  check('TR7','彻底删除第二下才永久清理',!(await api('GET','/api/suggestions?trash=1')).some(x=>x.id===trashA.id)&&await cdp.eval("!gid('recentlyDeleted')"));
  for(const title of ['测试回答 · 甲','测试回答 · 乙']){const r=await mk({title,quote:'假数据'});await api('DELETE','/api/suggestions/'+r.id);}
  await reload(); await click('[data-trash="empty"]');
  check('TR8','清空第一下只确认、两条仍在',(await api('GET','/api/suggestions?trash=1')).length===2&&await cdp.eval("document.querySelector('[data-trash=empty]').textContent==='确定清空？再点一次'"));
  await click('[data-trash="empty"]'); await sleep(350);
  check('TR8','清空第二下清理回收站并保留归档条目',(await api('GET','/api/suggestions?trash=1')).length===0&&(await item(archived.id))?.status==='done'&&await cdp.eval("!gid('recentlyDeleted')"));

  const errs = fs.readFileSync(appLog, 'utf8').split('\n').filter((l) => /\[JS\].*(error|Error|异常)/.test(l));
  check('R9', 'App 日志里没有页面脚本报错', errs.length === 0, errs.slice(0, 3));
} catch (err) {
  check('FATAL', String(err && err.stack || err), false);
}
console.log(`real-app-v4: ${pass} 项通过，${fail} 项失败（输出：${outDir}）`);
process.exit(fail ? 1 : 0);
