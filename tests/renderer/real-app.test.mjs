// tests/renderer/real-app.test.mjs —— P1-T05 真实 App 详情路径端到端断言
// 真实 Rust App（测试档案 + 测试端口）+ 真实 index.html 详情页：
// legacy 行与信封行各开详情，断言 #aibody textContent 与 canonical 逐 codepoint 一致、
// 敌意标记不执行、DB 存储原表示不动（CRLF 仍在 quote 里）。
// 用法：node tests/renderer/real-app.test.mjs [--out DIR]
// 前提：app/src-tauri/target/debug/nayan 已构建（cargo build --offline）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { synthEnvelope, REPO, UI_DIR, APP_BIN } from './fixtures.mjs';
import { startChrome, CDP } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-real-app-'));
fs.mkdirSync(outDir, { recursive: true });

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`);
}

if (!fs.existsSync(APP_BIN)) {
  console.error('找不到 App debug 二进制：' + APP_BIN + '（先 cd app/src-tauri && cargo build --offline）');
  process.exit(2);
}

// ---------- 隔离档案 + 起 App ----------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-p1b05-realapp-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const RUN = 'p1b05-real-' + Date.now();
const appLog = path.join(outDir, 'realapp-app.log');
const app = spawn(APP_BIN, [], {
  cwd: os.tmpdir(),
  env: { ...process.env, NAYAN_TEST_PROFILE: root, NAYAN_TEST_UI_DIR: UI_DIR, NAYAN_TEST_PORT: String(port), NAYAN_TEST_RUN_ID: RUN },
  stdio: ['ignore', fs.openSync(appLog, 'a'), fs.openSync(appLog, 'a')],
});
const base = `http://127.0.0.1:${port}`;

async function apiGet(p) { return (await fetch(base + p)).json(); }
async function apiPost(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${t}`);
  return JSON.parse(t);
}

const chromeProc = await startChrome();
let cdp;
const cleanup = () => {
  try { cdp && cdp.close(); } catch (_) {}
  try { chromeProc.child.kill(); } catch (_) {}
  try { app.kill(); } catch (_) {}
};
process.on('exit', cleanup);

try {
  // 等 App HTTP 就绪
  let up = false;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/api/suggestions'); if (r.ok) { up = true; break; } } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error('App HTTP 未就绪（见 ' + appLog + '）');
  check('R0-app', '真实 App 启动（隔离档案 ' + path.basename(root) + '，端口 ' + port + '）', true);

  // ---------- 造两条行：legacy（含 CRLF/CR/缩进/emoji/中点/敌意标记/字面 <br>）+ 信封行 ----------
  const legacyOriginal = 'B05 legacy 首行\r\n第二行 · 中点保留 · 不拆列表\r'
    + '\r\n\n    四空格缩进\r\nemoji 👨‍👩‍👧‍👦 组合 é 保留\n'
    + '<script>window.__PWNED_REAL__=1</script>\n字面 <br> 与 <img src=x onerror="window.__PWNED_REAL__=2">';
  const legacyCanonical = legacyOriginal.replace(/\r\n?/g, '\n');
  const envOriginal = 'B05 envelope 行一（declared plain）\r\n\t制表缩进\n\n第二段 · 中点 · 保留\n' + 'Z'.repeat(2500) + '\n收尾';
  const envelope = synthEnvelope(envOriginal, 'p1b05-real-req-1');
  const envCanonical = envelope.canonical;

  const rowL = await apiPost('/api/suggestions', { title: 'B05 REAL legacy 行', quote: legacyOriginal, source_tool: 'other', kind: 'suggestion' });
  const rowE = await apiPost('/api/suggestions', { title: 'B05 REAL envelope 行', request_id: 'p1b05-real-req-1', content: envelope });
  check('R1-seed', '两行入库（legacy #' + rowL.id + ' / envelope #' + rowE.id + '）', rowL.id > 0 && rowE.id > 0);

  // ---------- 浏览器开详情 ----------
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.go(base + '/');
  async function openDetail(title) {
    return cdp.eval(`(async () => {
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes(${JSON.stringify(title)}));
      if (!card) return { err: 'card not found' };
      card.click();
      const t0 = performance.now();
      while (performance.now() - t0 < 5000) {
        const b = document.getElementById('aibody');
        if (b && b.textContent.length > 0) {
          return { text: b.textContent, elements: b.childElementCount,
                   onlyText: [...b.childNodes].every(n => n.nodeType === 3),
                   waitedMs: performance.now() - t0 };
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return { err: 'aibody 未在 5s 内出现内容' };
    })()`);
  }
  const rL = await openDetail('B05 REAL legacy 行');
  check('R2-legacy-dom', 'legacy 详情 #aibody===canonical（逐 codepoint）', !rL.err && rL.text === legacyCanonical,
    rL.err || `len ${[...rL.text].length} vs ${[...legacyCanonical].length}`);
  check('R2-legacy-nodes', 'legacy 详情只含文本节点', !rL.err && rL.onlyText && rL.elements === 0);
  check('R2-legacy-hostile', '敌意标记未执行（window.__PWNED_REAL__ 未定义）', await cdp.eval(`typeof window.__PWNED_REAL__ === 'undefined'`));
  await cdp.screenshot(path.join(outDir, 'realapp-detail-legacy.png'));

  const rE = await openDetail('B05 REAL envelope 行');
  check('R3-envelope-dom', 'envelope 详情 #aibody===canonical（declared plain 分派）', !rE.err && rE.text === envCanonical,
    rE.err || `len ${[...rE.text].length} vs ${[...envCanonical].length}`);
  check('R3-envelope-nodes', 'envelope 详情只含文本节点', !rE.err && rE.onlyText && rE.elements === 0);
  await cdp.screenshot(path.join(outDir, 'realapp-detail-envelope.png'));

  // 迟到守卫烟雾：A 打开后立刻点 B，A 的迟到回填不得盖到 B（B 内容正确即证）
  const race = await cdp.eval(`(async () => {
    const cards = [...document.querySelectorAll('.card')];
    const a = cards.find(c => c.textContent.includes('B05 REAL legacy 行'));
    const b = cards.find(c => c.textContent.includes('B05 REAL envelope 行'));
    a.click(); b.click();
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      const el = document.getElementById('aibody');
      if (el && el.textContent.startsWith('B05 envelope')) return { ok: true, text: el.textContent.slice(0, 30) };
      await new Promise(r => setTimeout(r, 50));
    }
    return { ok: false };
  })()`);
  check('R4-race', 'A→B 快速切换：迟到回填不污染 B（B 正文正确）', race.ok, JSON.stringify(race));

  // ---------- DB 原表示不动 ----------
  const db = new DatabaseSync(path.join(root, 'inbox.db'), { readOnly: true });
  const qL = db.prepare('SELECT quote FROM suggestions WHERE id=?').get(rowL.id).quote;
  const qE = db.prepare('SELECT quote, content_envelope FROM suggestions WHERE id=?').get(rowE.id);
  db.close();
  check('R5-db-raw', 'legacy 存储 quote 原样（CRLF/CR 仍在，未被显示规范化回写）', qL === legacyOriginal,
    `CR 计数 ${(qL.match(/\r/g) || []).length} vs ${(legacyOriginal.match(/\r/g) || []).length}`);
  check('R5-db-raw', 'envelope 行 quote=canonical 兼容投影（LF）', qE.quote === envCanonical);
  const envInDb = JSON.parse(qE.content_envelope);
  check('R5-db-raw', 'envelope 原文逐字符入库（含 \\r\\n）', envInDb.original.text === envOriginal);

  cleanup();
} catch (e) {
  cleanup();
  console.error('real-app.test.mjs 异常:', e);
  process.exit(1);
}

const summary = { suite: 'real-app', total: results.length, pass: results.length - fail, fail, at: new Date().toISOString(), profile: root, port };
fs.writeFileSync(path.join(outDir, 'realapp-results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\nreal-app.test.mjs: ${summary.pass}/${summary.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
