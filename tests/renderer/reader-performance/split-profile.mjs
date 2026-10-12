// tests/renderer/reader-performance/split-profile.mjs —— P1-B06-PERF-01 / Step 2 拆测
// 目的：对四份冻结夹具（P1-B06-FIVE-STEP-REPAIR-01 只读复制）拆分计量完整链各阶段，
// 并验证「顶层结构元素切片 render / 分片 sanitize 拼接」与整串逐字节等价（Step 3 方案依据）。
// 全部计时为测试侧 wrapper（产品无遥测）。真实产品 CSS + 真实产品函数
// （rich-text.js / rich-source-map.js / vendor 两库经 <script src> 真实加载）。
// 用法：node tests/renderer/reader-performance/split-profile.mjs --out DIR
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChrome, CDP } from '../cdp.mjs';
import { ownRoot, bindChild, finishRun } from '../tauri-asset-smoke/lifecycle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIR = path.join(REPO, 'app/ui');
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out');
if (!outDir) { console.error('需要 --out DIR'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

// 四份夹具：优先本批 evidence 的只读复制；缺失时回退上批源（仍只读）。
const BATCH_FIX_DIR = path.join(REPO, 'docs/implementation-plan-2026-09-23/batches/P1-B06-PERF-01/evidence');
let fixtures;
{
  const manPath = path.join(BATCH_FIX_DIR, 'fixtures-manifest.json');
  if (fs.existsSync(manPath)) {
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    fixtures = man.fixtures.map((m, i) => {
      const text = fs.readFileSync(path.join(BATCH_FIX_DIR, `fixture-${i}-${m.label}.txt`), 'utf8');
      return { label: m.label, bytes: m.utf8_bytes, dense: m.label.startsWith('dense'), blocks: m.blocks_declared, sha256: m.sha256, text };
    });
  } else {
    const prev = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/implementation-plan-2026-09-23/batches/P1-B06-FIVE-STEP-REPAIR-01/evidence/source-map-dom-final/performance-fixtures.json'), 'utf8'));
    fixtures = prev.map((f, i) => ({ label: (f.dense ? 'dense' : 'ordinary') + '-' + f.bytes, bytes: f.bytes, dense: f.dense, blocks: f.blocks, text: f.text }));
  }
}

const productCSS = [...fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (url === '/__harness') {
    const html = `<!doctype html><meta charset="utf-8"><style>${productCSS}</style><style>
      body{margin:0;padding:16px;font-family:-apple-system,'PingFang SC',sans-serif;background:#fff;}
      .stage{width:480px;}
      .aibody{white-space:pre-wrap;font-size:13px;line-height:1.7;}
      .aibody.rich{white-space:normal;}
      .aibody.rich pre{white-space:pre;}
    </style><div class="stage"><div class="aibody" id="body-el"></div></div>
    <script src="/vendor/markdown-it.umd.min.js"></script>
    <script src="/vendor/purify.min.js"></script>
    <script src="/rich-text.js"></script>
    <script src="/rich-source-map.js"></script>`;
    return send(200, 'text/html; charset=utf-8', html);
  }
  const file = path.normalize(path.join(UI_DIR, url));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'text/plain', 'not found');
  const mime = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain';
  return send(200, mime, fs.readFileSync(file));
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;

const chromeProc = await startChrome();
const ownedProfile = ownRoot(chromeProc.profile); bindChild(ownedProfile, chromeProc.child);
let cdp; let thrown = null;
const t0 = new Date().toISOString();
let profile = null;
try {
  cdp = await CDP.connect(chromeProc.cdpPort);
  await cdp.go(base + '/__harness');

  // 页内拆测函数：真实产品函数 + 测试侧分段计时。
  const fn = async function (fixtures) {
    const el = document.getElementById('body-el');
    const md = markdownit({ html: false, breaks: false, linkify: false, typographer: false }); // 与 MD_INSTANCE 同选项
    const TRIALS = 5;
    const out = [];
    const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0], med: s[(s.length / 2) | 0], max: s[s.length - 1] }; };
    // 顶层结构元素切片（契约：完整已清洗顶层节点；不拆嵌套容器、不按字符切）
    const topLevelRanges = (tokens) => {
      const ranges = []; let depth = 0, start = 0;
      for (let i = 0; i < tokens.length; i++) {
        depth += tokens[i].nesting;
        if (depth === 0) { ranges.push([start, i + 1]); start = i + 1; }
      }
      return ranges;
    };
    for (const f of fixtures) {
      const decision = { format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: f.text };
      const identity = { itemId: 1, requestId: 'split', revision: null };
      const ph = {}; // phase -> [ms]
      for (const k of ['canonical', 'parse', 'renderFull', 'mdToHtml', 'sanitizeFull', 'domMount', 'layout', 'projection', 'mapper']) ph[k] = [];
      let fullHtml = null, fullClean = null, tokensRef = null, envRef = null, chunkEq = null, chunkSanEq = null, elemCost = null, batchSan = null, rangesCount = 0;
      for (let t = 0; t < TRIALS; t++) {
        let a = performance.now();
        const canon = canonicalNewlines(f.text); ph.canonical.push(performance.now() - a); // 产品函数（与决策内 text 同口径）
        a = performance.now();
        const env = {}; tokensRef = md.parse(canon, env); envRef = env; ph.parse.push(performance.now() - a);
        a = performance.now();
        fullHtml = md.renderer.render(tokensRef, md.options, env); ph.renderFull.push(performance.now() - a);
        a = performance.now();
        markdownToHtml(f.text); ph.mdToHtml.push(performance.now() - a); // 产品函数（parse+render 复合对照）
        a = performance.now();
        fullClean = sanitizeRichHtml(fullHtml); ph.sanitizeFull.push(performance.now() - a); // 产品清洗器
        a = performance.now();
        el.classList.add('rich'); el.innerHTML = fullClean; ph.domMount.push(performance.now() - a);
        a = performance.now(); el.offsetHeight; ph.layout.push(performance.now() - a);
        a = performance.now();
        plainProjection(el); ph.projection.push(performance.now() - a); // 产品投影
        a = performance.now();
        NaYanSourceSpans.build(decision, identity); ph.mapper.push(performance.now() - a); // 冻结 mapper（含自身 parse+entries）
        // —— 切片等价证明（每夹具一次即可）——
        if (t === TRIALS - 1) {
          const ranges = topLevelRanges(tokensRef); rangesCount = ranges.length;
          const parts = []; const costs = [];
          let ok = true;
          for (const [s, e] of ranges) {
            const b = performance.now();
            const h = md.renderer.render(tokensRef.slice(s, e), md.options, envRef);
            costs.push(performance.now() - b);
            parts.push(h);
          }
          chunkEq = { equal: parts.join('') === fullHtml, fullLen: fullHtml.length, sumLen: parts.reduce((x, y) => x + y.length, 0), ranges: ranges.length };
          elemCost = stats(costs);
          const sanParts = []; let sanOk = true;
          for (const [s, e] of ranges) sanParts.push(sanitizeRichHtml(md.renderer.render(tokensRef.slice(s, e), md.options, envRef)));
          chunkSanEq = { equal: sanParts.join('') === fullClean, parts: sanParts.length };
          // 分批计量（修正：v1 只按 render 计时致批大小失真；改为固定 512 元素/批，
          // 模拟实现的真实分批流程 render→sanitize→insertAdjacentHTML；投影按完成时一次性 31.9ms<100ms 单块另计）。
          const BATCH = 512;
          const batches = [];
          for (let i = 0; i < ranges.length; i += BATCH) batches.push(ranges.slice(i, i + BATCH));
          const sanTimes = [], mountTimes = [], renderTimes = [];
          el.innerHTML = ''; el.classList.add('rich');
          const simStart = performance.now();
          for (const batch of batches) {
            let b = performance.now();
            const html2 = batch.map(([s, e]) => md.renderer.render(tokensRef.slice(s, e), md.options, envRef)).join('');
            renderTimes.push(performance.now() - b);
            b = performance.now();
            const clean2 = sanitizeRichHtml(html2);
            sanTimes.push(performance.now() - b);
            b = performance.now();
            el.insertAdjacentHTML('beforeend', clean2);
            mountTimes.push(performance.now() - b);
          }
          const simTotal = performance.now() - simStart;
          batchSan = { batches: batches.length, perBatchElems: BATCH,
            renderMs: stats(renderTimes), sanitizeMs: stats(sanTimes), mountMs: stats(mountTimes),
            simBatchedTotalMs: simTotal };
        }
      }
      out.push({ label: f.label, bytes: f.bytes, phases: Object.fromEntries(Object.entries(ph).map(([k, v]) => [k, stats(v)])), chunkEq, chunkSanEq, elemCost, batchSan, rangesCount });
    }
    return out;
  };

  profile = await cdp.eval(`(${fn.toString()})(${JSON.stringify(fixtures)})`);
} catch (e) { thrown = e; console.error(e); } finally {
  try { if (cdp) await cdp.close(); } catch (_) {}
  const status = await finishRun({ records: [ownedProfile], children: [chromeProc.child], failed: thrown,
    writeEvidence: (result) => fs.writeFileSync(path.join(outDir, 'browser-cleanup.json'), JSON.stringify(result, null, 2)) });
  await new Promise((res) => server.close(res));
  const okClean = status.ok;
  const payload = { at_utc: t0, end_utc: new Date().toISOString(), env: { node: process.version, loadavg: os.loadavg(), cpu: os.cpus()[0].model }, profile, cleanup_ok: okClean };
  fs.writeFileSync(path.join(outDir, 'split-profile.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload.profile, null, 1));
  if (thrown || !okClean) process.exit(1);
}
