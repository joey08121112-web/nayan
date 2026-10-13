#!/usr/bin/env node
// tests/ingestion/mcp-ingestion.test.mjs —— P1-T04 MCP stdio 全矩阵（真实 mcp-server.js 子进程）。
// 覆盖：S01 结构化信封入库逐字符保真 / S02 legacy 库显式拒绝+批量零部分写入 /
// S03 上限边界（恰限/超一）显式拒绝零行 / S04 request_id 幂等跨重启 / 旧 quote-only 客户端兼容。
// 用法：node tests/ingestion/mcp-ingestion.test.mjs [--out DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO, CONTENT_FIXTURES, mkWork, rustInit, legacyDb, McpClient, toolText,
  expectEnvelope, dbOpen, codepoints, makeRecorder,
} from './helpers.mjs';

const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-mcp-ingestion-'));
const R = makeRecorder(outDir, 'mcp-ingestion');
const rec = R.rec;
const work = mkWork('mcp');

const fixtureText = (f) => fs.readFileSync(path.join(CONTENT_FIXTURES, f), 'utf8');

// ── M1: v2 库 · 信封入库逐字符保真（真实 CRLF/CR/缩进/组合字符/emoji 构造串） ────
{
  const db = rustInit(path.join(work, 'm1-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const text = '  首行缩进\t与\r\n真实 CRLF\r独立 CR\n\n空行🐱emoji é\u0301组合尾随  ';
  const r = await cli.tool('add_suggestion', {
    title: 'M1 结构化 CRLF',
    content: { schema_version: 1, request_id: 'm1-req', format: 'plain', original: { kind: 'text', text } },
  });
  const m = /id=(\d+)/.exec(toolText(r));
  const c = dbOpen(db);
  const row = c.prepare('SELECT content_envelope, quote FROM suggestions WHERE id = ?').get(Number(m && m[1]));
  c.close();
  const exp = expectEnvelope({ schema_version: 1, request_id: 'm1-req', format: 'plain', acquisition: 'mcp', original: { kind: 'text', text } });
  const env = row && JSON.parse(row.content_envelope);
  const ok = !!(row && env.original.text === text
    && row.quote === exp.quote && env.canonical === exp.envelope.canonical
    && env.canonical.includes('\n') && !env.canonical.includes('\r')
    && env.acquisition === 'mcp' && env.format_provenance === 'declared');
  rec('M1 v2 信封入库：original 逐字符（含真实 CRLF/CR）/quote=canonical/通道=mcp', ok,
    'originalLen=' + (env && env.original.text.length) + ' quote==canon=' + !!(row && row.quote === exp.quote) + ' canon 无CR=' + !!(env && !env.canonical.includes('\r')));
  cli.kill();
}

// ── M2: 幂等——同 request_id 重复提交恰一行（含跨进程重启重放） ──────────────────
{
  const db = rustInit(path.join(work, 'm2-v2.db'));
  {
    const cli = new McpClient(db);
    await cli.initialize('p1t04-probe');
    await cli.tool('add_suggestion', { title: 'M2 幂等', content: { request_id: 'm2-req', format: 'plain', original: { kind: 'text', text: 'a' } } });
    const dup = await cli.tool('add_suggestion', { title: 'M2 幂等重放', content: { request_id: 'm2-req', format: 'plain', original: { kind: 'text', text: 'a' } } });
    cli.kill();
    var firstResp = toolText(dup);
  }
  // 跨进程重启重放（新 MCP 实例、同一 DB）
  {
    const cli = new McpClient(db);
    await cli.initialize('p1t04-probe');
    const dup2 = await cli.tool('add_suggestion', { title: 'M2 幂等跨重启', content: { request_id: 'm2-req', format: 'plain', original: { kind: 'text', text: 'a' } } });
    cli.kill();
    var secondResp = toolText(dup2);
  }
  const c = dbOpen(db);
  const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE json_valid(content_envelope) AND json_extract(content_envelope, '$.request_id') = 'm2-req'").get().n;
  c.close();
  rec('M2 request_id 幂等：双发+跨进程重发 → 恰一行', n === 1 && firstResp.includes('duplicate=true') && secondResp.includes('duplicate=true'),
    'rows=' + n + ' resp1=' + firstResp.slice(0, 60) + ' resp2=' + secondResp.slice(0, 60));
}

// ── M3: 上限边界——恰 100000 codepoint 入库、超 1 显式拒绝零行 ──────────────────
{
  const db = rustInit(path.join(work, 'm3-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const at = await cli.tool('add_suggestion', { title: 'M3 恰限', content: { request_id: 'm3-at', format: 'plain', original: { kind: 'text', text: '汉'.repeat(100000) } } });
  const over = await cli.tool('add_suggestion', { title: 'M3 超一', content: { request_id: 'm3-over', format: 'plain', original: { kind: 'text', text: '汉'.repeat(100001) } } });
  const bytesAt = await cli.tool('add_suggestion', { title: 'M3 字节恰限', content: { request_id: 'm3-bat', format: 'plain', original: { kind: 'bytes', bytes: new Array(100000).fill(65) } } });
  const bytesOver = await cli.tool('add_suggestion', { title: 'M3 字节超一', content: { request_id: 'm3-bover', format: 'plain', original: { kind: 'bytes', bytes: new Array(100001).fill(65) } } });
  cli.kill();
  const c = dbOpen(db);
  const nAt = c.prepare("SELECT COUNT(*) n, MAX(LENGTH(quote)) q FROM suggestions WHERE title='M3 恰限'").get();
  const nOver = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'M3 超一' OR title LIKE 'M3 字节超一'").get().n;
  const nBAt = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title='M3 字节恰限'").get().n;
  c.close();
  rec('M3 上限边界：100000 字符/100000 字节恰限入库、超一显式拒绝零行',
    !at.error && !bytesAt.error && toolText(over).includes('ERROR') && toolText(over).includes('超限')
      && toolText(bytesOver).includes('超限') && nAt.n === 1 && nOver === 0 && nBAt === 1,
    'at=' + toolText(at).slice(0, 30) + ' over=' + toolText(over).slice(0, 50) + ' rowsAt=' + nAt.n + ' rowsOver=' + nOver + ' bytesAt=' + nBAt);
}

// ── M4: bytes 原文（RTF fixture）逐字节保真；quote 空（投影不可用） ─────────────
{
  const db = rustInit(path.join(work, 'm4-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const raw = fs.readFileSync(path.join(CONTENT_FIXTURES, 'rtf-sample.rtf'));
  const bytes = Array.from(raw);
  const r = await cli.tool('add_suggestion', {
    title: 'M4 二进制',
    content: { request_id: 'm4-req', format: 'plain', original: { kind: 'bytes', bytes, charset_hint: 'rtf' } },
  });
  const m = /id=(\d+)/.exec(toolText(r));
  cli.kill();
  const c = dbOpen(db);
  const row = c.prepare('SELECT content_envelope, quote FROM suggestions WHERE id = ?').get(Number(m && m[1]));
  c.close();
  const env = row && JSON.parse(row.content_envelope);
  rec('M4 bytes 原文逐字节保真：quote 空/ canonical null',
    !!(env && env.original.kind === 'bytes' && env.original.bytes.length === bytes.length
      && env.original.bytes.every((b, i) => b === bytes[i]) && env.original.charset_hint === 'rtf'
      && row.quote === '' && env.canonical === null),
    'bytes=' + (env && env.original.bytes.length) + ' quote=' + JSON.stringify(row && row.quote));
}

// ── M5: 非法信封（未知格式/未知字段/矛盾组合/坏字节数组）显式拒绝零行 ────────────
{
  const db = rustInit(path.join(work, 'm5-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const bads = [
    ['未知格式', { request_id: 'm5a', format: 'rtf', original: { kind: 'text', text: 'x' } }],
    ['未知字段', { request_id: 'm5b', format: 'plain', original: { kind: 'text', text: 'x' }, canonical: '伪造派生值' }],
    ['矛盾组合', { request_id: 'm5c', format: 'markdown', format_provenance: 'legacy_assumed_plain', original: { kind: 'text', text: '# x' } }],
    ['坏字节', { request_id: 'm5d', format: 'plain', original: { kind: 'bytes', bytes: [1, 300] } }],
    ['缺 request_id', { format: 'plain', original: { kind: 'text', text: 'x' } }],
    ['未知版本', { schema_version: 99, request_id: 'm5f', format: 'plain', original: { kind: 'text', text: 'x' } }],
  ];
  const errs = [];
  for (const [name, content] of bads) {
    const r = await cli.tool('add_suggestion', { title: 'M5 ' + name, content });
    errs.push([name, toolText(r)]);
  }
  cli.kill();
  const c = dbOpen(db);
  const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'M5 %'").get().n;
  c.close();
  const allErr = errs.every(([, t]) => t.startsWith('ERROR'));
  rec('M5 非法信封六型显式拒绝、零行', allErr && n === 0,
    'rows=' + n + ' 各型=' + errs.map(([k, t]) => k + ':' + (t.startsWith('ERROR') ? 'ERR' : t.slice(0, 20))).join('|'));
}

// ── M6: legacy 库（v0-4/v0-5/v1）· 旧 quote-only 兼容 + 信封显式拒绝 ────────────
for (const shape of ['v0-4', 'v0-5', 'v1']) {
  const db = legacyDb(work, shape);
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const old = await cli.tool('add_suggestion', { title: 'M6 ' + shape + ' 旧客户端', quote: '旧 quote 通道 ' + shape });
  const env = await cli.tool('add_suggestion', { title: 'M6 ' + shape + ' 结构化', content: { request_id: 'm6-' + shape, format: 'plain', original: { kind: 'text', text: 'x' } } });
  cli.kill();
  const c = dbOpen(db);
  const nOld = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = ?").get('M6 ' + shape + ' 旧客户端').n;
  const nEnv = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = ?").get('M6 ' + shape + ' 结构化').n;
  const cols = c.prepare('PRAGMA table_info(suggestions)').all().map((x) => x.name);
  c.close();
  rec('M6 MCP@' + shape + '：旧 quote-only 成功 / 信封显式拒绝零行 / 不建列',
    !old.error && nOld === 1 && toolText(env).startsWith('ERROR') && nEnv === 0 && !cols.includes('content_envelope'),
    'old=' + toolText(old).slice(0, 40) + ' env=' + toolText(env).slice(0, 70) + ' envRows=' + nEnv);
}

// ── M7: 批量 add_suggestions —— 预校验零部分写入；重复批次幂等跳过 ───────────────
{
  const db = rustInit(path.join(work, 'm7-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  // 一条非法 → 整批拒绝（合法的 1、3 也不得入库）——坏批后立即对账行数
  const badBatch = await cli.tool('add_suggestions', { items: [
    { title: 'M7 合法一', content: { request_id: 'm7-1', format: 'plain', original: { kind: 'text', text: '一' } } },
    { title: 'M7 非法', content: { request_id: 'm7-2', format: 'rtf', original: { kind: 'text', text: '坏' } } },
    { title: 'M7 合法二', quote: '旧通道' },
  ] });
  {
    const c = dbOpen(db);
    var afterBad = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'M7 %'").get().n;
    c.close();
  }
  // 全法批次 → 3 行（含 quote-only 混排）
  const okBatch = await cli.tool('add_suggestions', { items: [
    { title: 'M7 合法一', content: { request_id: 'm7-1', format: 'plain', original: { kind: 'text', text: '一' } } },
    { title: 'M7 合法二', quote: '旧通道' },
    { title: 'M7 合法三', content: { request_id: 'm7-3', format: 'markdown', original: { kind: 'text', text: '# 三' } } },
  ] });
  // 原样重放（m7-1 幂等跳过，其余两条为新 quote-only 语义照旧插入——如实断言）
  const replay = await cli.tool('add_suggestions', { items: [
    { title: 'M7 合法一', content: { request_id: 'm7-1', format: 'plain', original: { kind: 'text', text: '一' } } },
  ] });
  cli.kill();
  const c = dbOpen(db);
  const env1 = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE json_valid(content_envelope) AND json_extract(content_envelope, '$.request_id') = 'm7-1'").get().n;
  const md3 = c.prepare("SELECT content_envelope FROM suggestions WHERE title = 'M7 合法三'").get();
  const replayTxt = toolText(replay);
  c.close();
  const env3 = md3 && JSON.parse(md3.content_envelope);
  rec('M7 批量：坏批零行 / 好批混排入库 / 重放幂等跳过 / markdown 声明保真',
    toolText(badBatch).startsWith('ERROR') && afterBad === 0 && !okBatch.error && env1 === 1
      && replayTxt.includes('duplicate=true') && replayTxt.includes('#1') && !replayTxt.includes('已逐条收进')
      && env3 && env3.format === 'markdown' && env3.acquisition === 'mcp',
    'badBatch=' + toolText(badBatch).slice(0, 50) + ' badRows=' + afterBad + ' env1=' + env1 + ' replay=' + replayTxt.slice(0, 50));
}

// ── M8: content 与 quote 同给 → 信封权威（quote 字段不采信） ────────────────────
{
  const db = rustInit(path.join(work, 'm8-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const r = await cli.tool('add_suggestion', {
    title: 'M8 权威',
    quote: '这条旧 quote 应被忽略',
    content: { request_id: 'm8-req', format: 'plain', original: { kind: 'text', text: '正文以信封为准\r\nCRLF' } },
  });
  const m = /id=(\d+)/.exec(toolText(r));
  cli.kill();
  const c = dbOpen(db);
  const row = c.prepare('SELECT quote, content_envelope FROM suggestions WHERE id = ?').get(Number(m && m[1]));
  c.close();
  const env = row && JSON.parse(row.content_envelope);
  rec('M8 content 权威：同给 quote 不采信、列值=canonical 投影',
    !!(env && env.original.text === '正文以信封为准\r\nCRLF' && row.quote === '正文以信封为准\nCRLF'),
    'quote=' + JSON.stringify(row && row.quote));
}

// ── M9: 旧 quote-only 在 v2 库照常（legacy_plain、envelope NULL）+ 超限显式拒 ──
{
  const db = rustInit(path.join(work, 'm9-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const text = '  空白保留\r\n\t缩进\n🐱 emoji ';
  const old = await cli.tool('add_suggestion', { title: 'M9 旧通道', quote: text });
  const big = await cli.tool('add_suggestion', { title: 'M9 旧通道超限', quote: '汉'.repeat(100001) });
  const m = /id=(\d+)/.exec(toolText(old));
  cli.kill();
  const c = dbOpen(db);
  const row = c.prepare('SELECT quote, content_envelope FROM suggestions WHERE id = ?').get(Number(m && m[1]));
  const nBig = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = 'M9 旧通道超限'").get().n;
  c.close();
  rec('M9 v2 库旧 quote-only：原样入库（无信封列值）+超限显式拒',
    !old.error && row.quote === text && row.content_envelope === null && toolText(big).includes('超限') && nBig === 0,
    'quote逐字符=' + (row.quote === text) + ' envelope=NULL=' + (row.content_envelope === null) + ' 超限rows=' + nBig);
}

// ── M10: 独立启动（S05）：无 env 的全新 v2 库上先后两个客户端互不串扰 ───────────
{
  const db = rustInit(path.join(work, 'm10-v2.db'));
  const cli1 = new McpClient(db);
  const init1 = await cli1.initialize('claude-code');
  const r1 = await cli1.tool('add_suggestion', { title: 'M10 客户端一', content: { request_id: 'm10-a', format: 'plain', original: { kind: 'text', text: '一的内容' } } });
  cli1.kill();
  const cli2 = new McpClient(db);
  const init2 = await cli2.initialize('codex');
  const r2 = await cli2.tool('add_suggestion', { title: 'M10 客户端二', content: { request_id: 'm10-b', format: 'plain', original: { kind: 'text', text: '二的内容' } } });
  cli2.kill();
  const c = dbOpen(db);
  const rows = c.prepare("SELECT source_tool, json_extract(content_envelope, '$.request_id') rid FROM suggestions WHERE title LIKE 'M10 %' ORDER BY id").all();
  c.close();
  rec('M10 独立双客户端：各自入库、来源映射正确',
    init1.result && init2.result && !r1.error && !r2.error && rows.length === 2
      && rows[0].source_tool === 'claude-code' && rows[1].source_tool === 'codex',
    JSON.stringify(rows));
}

// ── M11: 深检补——未配对代理（lone surrogate）显式拒绝零行（防 U+FFFD 静默替换）──
{
  const db = rustInit(path.join(work, 'm11-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const badEnv = await cli.tool('add_suggestion', { title: 'M11 孤代理信封', content: { request_id: 'm11-sg', format: 'plain', original: { kind: 'text', text: '前\uD800后' } } });
  const badQuote = await cli.tool('add_suggestion', { title: 'M11 孤代理quote', quote: '前\uD800后' });
  const okEmoji = await cli.tool('add_suggestion', { title: 'M11 合法emoji', content: { request_id: 'm11-emoji', format: 'plain', original: { kind: 'text', text: '🐱ok' } } });
  cli.kill();
  const c = dbOpen(db);
  const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'M11 孤代理%'").get().n;
  const emoji = c.prepare("SELECT quote FROM suggestions WHERE title = 'M11 合法emoji'").get();
  c.close();
  rec('M11 孤代理：信封/quote-only 均显式拒绝零行；合法 emoji 代理对不受影响',
    toolText(badEnv).startsWith('ERROR') && toolText(badQuote).startsWith('ERROR') && n === 0
      && !okEmoji.error && emoji && emoji.quote === '🐱ok',
    'env=' + toolText(badEnv).slice(0, 50) + ' quote=' + toolText(badQuote).slice(0, 50) + ' 拒绝行数=' + n);
}


// ── M14（P1-B04-REPAIR-01）：同批同 request_id —— 同文×2/×3、异文 A/B ────────────
{
  const db = rustInit(path.join(work, 'm14-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const item = (title, text, rid) => ({ title, content: { request_id: rid, format: 'plain', original: { kind: 'text', text } } });
  // 同 ID/同文 ×2
  const r2 = await cli.tool('add_suggestions', { items: [item('M14 同文一', '同文', 'm14-same'), item('M14 同文二', '同文', 'm14-same')] });
  // 同 ID/同文 ×3
  const r3 = await cli.tool('add_suggestions', { items: [item('M14 三连一', '三连', 'm14-tri'), item('M14 三连二', '三连', 'm14-tri'), item('M14 三连三', '三连', 'm14-tri')] });
  // 同 ID/异文 A/B：首条 A 为权威，后条 B 明确 duplicate、不得覆盖、不得称新增
  const rAB = await cli.tool('add_suggestions', { items: [item('M14 首条A', 'A 正文', 'm14-ab'), item('M14 后条B', 'B 正文', 'm14-ab')] });
  cli.kill();
  const c = dbOpen(db);
  const nSame = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE json_extract(content_envelope, '$.request_id') = 'm14-same'").get().n;
  const nTri = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE json_extract(content_envelope, '$.request_id') = 'm14-tri'").get().n;
  const ab = c.prepare("SELECT id, title, quote FROM suggestions WHERE json_extract(content_envelope, '$.request_id') = 'm14-ab' ORDER BY id").all();
  c.close();
  const abTxt = toolText(rAB);
  rec('M14 同批同 ID：同文×2/×3 恰 1 行；异文 A/B 恰 1 行且保留 A、B 为 duplicate 同 ID',
    nSame === 1 && nTri === 1 && ab.length === 1 && ab[0].title === 'M14 首条A' && ab[0].quote === 'A 正文'
      && !r2.error && !r3.error && !rAB.error
      && abTxt.includes('新增 1 条') && abTxt.includes('M14 首条A')
      && abTxt.includes('duplicate=true') && abTxt.includes('#' + ab[0].id)
      && !abTxt.includes('B 正文') && !abTxt.includes('M14 后条B') && !abTxt.includes('已存内容为 B'),
    'same=' + nSame + ' tri=' + nTri + ' ab=' + JSON.stringify(ab) + ' resp=『' + abTxt.replace(/\n/g, ' | ') + '』');
}

// ── M15：交错 [X(A),Y,X(B)] / 已存在 X+新 Y / 整批重放 / 重启 MCP 后重放 ──────────
{
  const db = rustInit(path.join(work, 'm15-v2.db'));
  const item = (title, text, rid) => ({ title, content: { request_id: rid, format: 'plain', original: { kind: 'text', text } } });
  {
    const cli = new McpClient(db);
    await cli.initialize('p1t04-probe');
    // X(A)、Y、X(B) 交错
    const r1 = await cli.tool('add_suggestions', { items: [item('M15 X-A', 'XA', 'm15-x'), item('M15 Y', 'Y 文', 'm15-y'), item('M15 X-B', 'XB', 'm15-x')] });
    // 已存在 X（跨批）+ 新 Y2：X 原行不变，仅 Y2 新增；不得拿本次正文冒充已存 X
    const r2 = await cli.tool('add_suggestions', { items: [item('M15 X-again-别的正文', 'X-新正文', 'm15-x'), item('M15 Y2', 'Y2 文', 'm15-y2')] });
    // 整批整体再发（全重复）
    const r3 = await cli.tool('add_suggestions', { items: [item('M15 X-r', 'XA', 'm15-x'), item('M15 Y-r', 'Y 文', 'm15-y')] });
    var beforeRestart = { r1: toolText(r1), r2: toolText(r2), r3: toolText(r3) };
    cli.kill();
  }
  // 重启 MCP 后重放
  {
    const cli = new McpClient(db);
    await cli.initialize('p1t04-probe');
    const r4 = await cli.tool('add_suggestions', { items: [item('M15 X-r2', 'XA', 'm15-x'), item('M15 Y2-r', 'Y2 文', 'm15-y2')] });
    cli.kill();
    var afterRestart = toolText(r4);
  }
  const c = dbOpen(db);
  const perRid = c.prepare("SELECT json_extract(content_envelope, '$.request_id') rid, COUNT(*) n, MIN(id) mn, MAX(id) mx, MIN(title) t FROM suggestions WHERE content_envelope IS NOT NULL GROUP BY rid ORDER BY rid").all();
  c.close();
  const x = perRid.find((r) => r.rid === 'm15-x');
  const y = perRid.find((r) => r.rid === 'm15-y');
  const y2 = perRid.find((r) => r.rid === 'm15-y2');
  rec('M15 交错/已存在/整批重放/重启重放：各 request_id 恰一行，返回 ID 与 DB 一致，X 原行不被冒充',
    perRid.length === 3 && x.n === 1 && y.n === 1 && y2.n === 1
      && x.t === 'M15 X-A' && x.mn === x.mx
      && beforeRestart.r2.includes('新增 1 条') && beforeRestart.r2.includes('M15 X-A') && !beforeRestart.r2.includes('X-新正文')
      && beforeRestart.r3.includes('duplicate=true') && !beforeRestart.r3.includes('已逐条收进')
      && afterRestart.includes('duplicate=true') && !afterRestart.includes('已逐条收进'),
    JSON.stringify(perRid) + ' r2=『' + beforeRestart.r2.replace(/\n/g, '|').slice(0, 90) + '』 restart=『' + afterRestart.replace(/\n/g, '|').slice(0, 60) + '』');
}

// ── M16：不做正文去重 —— 不同 ID 相同正文 / legacy 相同正文，均分别保存 ──────────
{
  const db = rustInit(path.join(work, 'm16-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const r1 = await cli.tool('add_suggestions', { items: [
    { title: 'M16 结构同文一', content: { request_id: 'm16-a', format: 'plain', original: { kind: 'text', text: '一字不差的正文' } } },
    { title: 'M16 结构同文二', content: { request_id: 'm16-b', format: 'plain', original: { kind: 'text', text: '一字不差的正文' } } },
  ] });
  const r2 = await cli.tool('add_suggestions', { items: [
    { title: 'M16 legacy 同文一', quote: '完全相同的旧通道正文' },
    { title: 'M16 legacy 同文二', quote: '完全相同的旧通道正文' },
  ] });
  cli.kill();
  const c = dbOpen(db);
  const nEnv = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE quote = '一字不差的正文' AND content_envelope IS NOT NULL").get().n;
  const nQuote = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE quote = '完全相同的旧通道正文' AND content_envelope IS NULL").get().n;
  c.close();
  rec('M16 不同 ID 相同正文×2 与 legacy 相同正文×2 均分别入库（未误做正文去重）',
    !r1.error && !r2.error && nEnv === 2 && nQuote === 2, 'env=' + nEnv + ' quote=' + nQuote);
}

// ── M17：非法混排整批拒绝（含非法项复用前项 ID）/ 原有数据逐行不变 ───────────────
{
  const db = rustInit(path.join(work, 'm17-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  // 先放一条基线数据（用于「库中原有数据逐行不变」对账）
  await cli.tool('add_suggestion', { title: 'M17 基线', content: { request_id: 'm17-base', format: 'plain', original: { kind: 'text', text: '基线正文' } } });
  const c0 = dbOpen(db);
  const baseBefore = c0.prepare('SELECT id,title,quote,content_envelope FROM suggestions ORDER BY id').all();
  const uvBefore = c0.prepare('PRAGMA user_version').get().user_version;
  c0.close();
  const item = (title, content) => ({ title, content });
  // (1) 有效项后跟非法 format（且复用前项 request_id）
  const bad1 = await cli.tool('add_suggestions', { items: [
    item('M17 合法', { request_id: 'm17-rid', format: 'plain', original: { kind: 'text', text: '合法正文' } }),
    item('M17 非法复用ID', { request_id: 'm17-rid', format: 'rtf', original: { kind: 'text', text: '坏' } }),
  ] });
  // (2) 有效项后跟超限
  const bad2 = await cli.tool('add_suggestions', { items: [
    item('M17 又合法', { request_id: 'm17-rid2', format: 'plain', original: { kind: 'text', text: '又合法' } }),
    item('M17 超限', { request_id: 'm17-rid2', format: 'plain', original: { kind: 'text', text: '超'.repeat(100001) } }),
  ] });
  // (3) 有效项后跟坏 Unicode
  const bad3 = await cli.tool('add_suggestions', { items: [
    item('M17 三合法', { request_id: 'm17-rid3', format: 'plain', original: { kind: 'text', text: '三合法' } }),
    item('M17 孤代理', { request_id: 'm17-rid3', format: 'plain', original: { kind: 'text', text: '前\uD800后' } }),
  ] });
  cli.kill();
  const c = dbOpen(db);
  const rowsAfter = c.prepare('SELECT id,title,quote,content_envelope FROM suggestions ORDER BY id').all();
  const uvAfter = c.prepare('PRAGMA user_version').get().user_version;
  c.close();
  rec('M17 有效后非法/超限/坏Unicode（复用前项 ID）：整批显式失败零新增，原有数据与 user_version 逐行不变',
    toolText(bad1).startsWith('ERROR') && toolText(bad2).startsWith('ERROR') && toolText(bad3).startsWith('ERROR')
      && JSON.stringify(rowsAfter) === JSON.stringify(baseBefore) && uvAfter === uvBefore,
    'err1=' + toolText(bad1).slice(0, 40) + ' rows=' + rowsAfter.length + '/' + baseBefore.length + ' uv=' + uvBefore + '→' + uvAfter);
}

// ── M18：事务内确定性 INSERT 失败 → 整批回滚；解除触发器后同实例恢复 ─────────────
// 触发器只建在本 case 的临时库（测试资产），随库销毁，绝不进产品/生产。
{
  const db = rustInit(path.join(work, 'm18-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  const c0 = dbOpen(db);
  c0.exec("CREATE TRIGGER m18_abort_second BEFORE INSERT ON suggestions WHEN NEW.title = 'M18 第二条' BEGIN SELECT RAISE(ABORT, 'injected second insert failure'); END;");
  const schemaWithTrigger = c0.prepare("SELECT type,name FROM sqlite_master WHERE name = 'm18_abort_second'").get();
  c0.close();
  const item = (title, rid, text) => ({ title, content: { request_id: rid, format: 'plain', original: { kind: 'text', text } } });
  // 第一条合法、第二条 INSERT 确定性失败 → 整批（含第一条）回滚
  const failBatch = await cli.tool('add_suggestions', { items: [item('M18 第一条', 'm18-a', '一'), item('M18 第二条', 'm18-b', '二')] });
  // 解除触发器（同一 MCP 实例），正常批应成功——证明事务没有悬挂
  const c1 = dbOpen(db);
  c1.exec('DROP TRIGGER m18_abort_second;');
  c1.close();
  const okBatch = await cli.tool('add_suggestions', { items: [item('M18 第一条', 'm18-a', '一'), item('M18 第二条', 'm18-b', '二')] });
  cli.kill();
  const c = dbOpen(db);
  const rows = c.prepare('SELECT id,title FROM suggestions ORDER BY id').all();
  const uv = c.prepare('PRAGMA user_version').get().user_version;
  c.close();
  rec('M18 批内第二条 INSERT RAISE(ABORT)：整批回滚零行+显式错误；解除后同实例成功（事务未悬挂）',
    !!schemaWithTrigger && toolText(failBatch).startsWith('ERROR') && toolText(failBatch).includes('回滚')
      && !okBatch.error && rows.length === 2 && rows[0].title === 'M18 第一条' && rows[1].title === 'M18 第二条' && uv === 5, // R12：Rust 建库为 v5
    'fail=' + toolText(failBatch).slice(0, 70) + ' okRows=' + JSON.stringify(rows) + ' uv=' + uv);
}

// ── M19：外部连接持写锁 → 批量明确失败零新增；释放后重试成功 ────────────────────
{
  const db = rustInit(path.join(work, 'm19-v2.db'));
  const cli = new McpClient(db);
  await cli.initialize('p1t04-probe');
  // 预放一条基线
  await cli.tool('add_suggestion', { title: 'M19 基线', content: { request_id: 'm19-base', format: 'plain', original: { kind: 'text', text: '基线' } } });
  // 另一自有连接持有写锁（BEGIN IMMEDIATE 保持打开——以锁的获取与释放为时序证据，不靠 sleep）
  const holder = dbOpen(db);
  holder.exec('BEGIN IMMEDIATE');
  holder.prepare("INSERT INTO suggestions (title, quote, source_tool) VALUES ('M19 占位', '占位', 'holder')").run();
  const item = (title, rid) => ({ title, content: { request_id: rid, format: 'plain', original: { kind: 'text', text: title } } });
  const busyBatch = await cli.tool('add_suggestions', { items: [item('M19 锁中一', 'm19-a'), item('M19 锁中二', 'm19-b')] });
  holder.exec('COMMIT');
  holder.close();
  const mid = dbOpen(db);
  const nDuring = mid.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'M19 锁中%'").get().n;
  mid.close();
  const retry = await cli.tool('add_suggestions', { items: [item('M19 锁中一', 'm19-a'), item('M19 锁中二', 'm19-b')] });
  cli.kill();
  const c = dbOpen(db);
  const rows = c.prepare("SELECT json_extract(content_envelope, '$.request_id') rid, COUNT(*) n FROM suggestions WHERE content_envelope IS NOT NULL GROUP BY rid").all();
  c.close();
  rec('M19 写锁竞争：持锁期批量明确失败零新增；释放后同 ID 重试恰 2 行',
    toolText(busyBatch).startsWith('ERROR') && toolText(busyBatch).includes('BEGIN IMMEDIATE') && nDuring === 0
      && !retry.error && rows.filter((r) => r.rid.startsWith('m19-') && r.rid !== 'm19-base').every((r) => r.n === 1)
      && rows.filter((r) => r.rid.startsWith('m19-') && r.rid !== 'm19-base').length === 2,
    'busy=' + toolText(busyBatch).slice(0, 60) + ' during=' + nDuring + ' rows=' + JSON.stringify(rows));
}

// ── M20：legacy v0-4/v0-5/v1 批量 quote-only 正例 + 结构化批量显式拒绝 ──────────
{
  const shapes = ['v0-4', 'v0-5', 'v1'];
  const results = [];
  const m20dir = path.join(work, 'm20');
  fs.mkdirSync(m20dir, { recursive: true });
  for (const shape of shapes) {
    const db = legacyDb(m20dir, shape);
    const cli = new McpClient(db);
    await cli.initialize('p1t04-probe');
    const okBatch = await cli.tool('add_suggestions', { items: [
      { title: 'M20 ' + shape + ' 批量一', quote: shape + ' 的批量旧通道正文一' },
      { title: 'M20 ' + shape + ' 批量二', quote: shape + ' 的批量旧通道正文二' },
    ] });
    const badBatch = await cli.tool('add_suggestions', { items: [
      { title: 'M20 ' + shape + ' 结构化', content: { request_id: 'm20-' + shape, format: 'plain', original: { kind: 'text', text: '不应入库' } } },
    ] });
    cli.kill();
    const c = dbOpen(db);
    const nQuote = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'M20 " + shape + " 批量%'").get().n;
    const nEnv = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'M20 " + shape + " 结构化%'").get().n;
    c.close();
    results.push({ shape, nQuote, nEnv, ok: !okBatch.error, rejected: toolText(badBatch).startsWith('ERROR') });
  }
  rec('M20 legacy 三形态批量 quote-only 正例入库（各 2 行）+ 结构化批量显式拒绝零写入',
    results.every((r) => r.nQuote === 2 && r.nEnv === 0 && r.ok && r.rejected), JSON.stringify(results));
}

fs.rmSync(work, { recursive: true, force: true });
process.exit(R.finish() ? 1 : 0);
