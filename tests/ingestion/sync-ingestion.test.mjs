#!/usr/bin/env node
// tests/ingestion/sync-ingestion.test.mjs —— P1-T04 sync HTTP 全矩阵（真实 sync-server.js 子进程）。
// 覆盖：S01 信封入库逐字符保真 / S02 legacy 库 409 显式拒绝零行（旧 quote-only 不受影响）/
// S03 slice(0,100000) 静默截断已移除（恰限入库/超一 413 零行，字段名可见）/
// S04 request_id 幂等 / CORS 响应头补齐（chrome-extension 来源）/ content 权威。
// 用法：node tests/ingestion/sync-ingestion.test.mjs [--out DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mkWork, rustInit, legacyDb, startSync, freePort, expectEnvelope, dbOpen, makeRecorder,
} from './helpers.mjs';

const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-sync-ingestion-'));
const R = makeRecorder(outDir, 'sync-ingestion');
const rec = R.rec;
const work = mkWork('sync');

async function withSync(db, fn) {
  const port = await freePort();
  const h = await startSync(db, port);
  try {
    return await fn('http://127.0.0.1:' + port);
  } finally {
    h.p.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(() => { try { h.p.kill('SIGKILL'); } catch (_) {} r(); }, 3000); h.p.on('exit', () => { clearTimeout(t); r(); }); });
  }
}

const post = (base, body, headers) => fetch(base + '/api/suggestions', {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: JSON.stringify(body),
});

// ── S1: v2 信封入库逐字符保真 + 响应行含 duplicate:false ────────────────────────
{
  const db = rustInit(path.join(work, 's1.db'));
  const text = '  缩进\t首行\r\nCRLF 行\r独立 CR\n\n🐱é\u0301尾随  ';
  await withSync(db, async (base) => {
    const r = await post(base, {
      title: 'S1 信封',
      quote: '旧字段应被忽略',
      source_tool: 'webbox', workspace: '/tmp/p1t04', session_ref: '标题 | https://例.test/x', tags: 't1',
      request_id: 's1-req',
      content: { schema_version: 1, request_id: 's1-req', format: 'plain', original: { kind: 'text', text } },
    });
    const row = await r.json();
    const c = dbOpen(db);
    const st = c.prepare('SELECT content_envelope, quote, session_ref, workspace FROM suggestions WHERE id = ?').get(row.id);
    c.close();
    const exp = expectEnvelope({ schema_version: 1, request_id: 's1-req', format: 'plain', original: { kind: 'text', text } }, { acquisition: 'extension_dom' });
    const env = JSON.parse(st.content_envelope);
    rec('S1 v2 信封入库：original 逐字符/quote=canonical/来源元数据原样/duplicate:false',
      r.status === 200 && row.duplicate === false && env.original.text === text && st.quote === exp.quote
        && env.acquisition === 'extension_dom' && st.session_ref === '标题 | https://例.test/x' && st.workspace === '/tmp/p1t04',
      'status=' + r.status + ' orig逐字符=' + (env.original.text === text) + ' quote==canon=' + (st.quote === exp.quote) + ' acq=' + env.acquisition);
  });
}

// ── S2: request_id 幂等（重发返回已有行 duplicate:true，恰一行） ─────────────────
{
  const db = rustInit(path.join(work, 's2.db'));
  await withSync(db, async (base) => {
    const body = { title: 'S2 幂等', request_id: 's2-req', content: { request_id: 's2-req', format: 'plain', original: { kind: 'text', text: '重试正文' } } };
    const r1 = await post(base, body);
    const row1 = await r1.json();
    const r2 = await post(base, body); // 网络重放/双击同形
    const row2 = await r2.json();
    const c = dbOpen(db);
    const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE json_valid(content_envelope) AND json_extract(content_envelope, '$.request_id') = 's2-req'").get().n;
    c.close();
    rec('S2 request_id 幂等：重发返回已有行、库中恰一行',
      r1.status === 200 && r2.status === 200 && row1.duplicate === false && row2.duplicate === true && row1.id === row2.id && n === 1,
      'id1=' + row1.id + ' id2=' + row2.id + ' dup2=' + row2.duplicate + ' rows=' + n);
  });
}

// ── S3: quote-only 静默截断已移除——恰 100000 字符入库、超一 413 零行（字段名可见）─
{
  const db = rustInit(path.join(work, 's3.db'));
  await withSync(db, async (base) => {
    const at = '汉'.repeat(100000);
    const over = '汉'.repeat(100001);
    const rAt = await post(base, { title: 'S3 恰限', quote: at, source_tool: 'webbox' });
    const rowAt = await rAt.json();
    const rOver = await post(base, { title: 'S3 超一', quote: over, source_tool: 'webbox' });
    const errOver = await rOver.json();
    const c = dbOpen(db);
    const stAt = c.prepare("SELECT quote FROM suggestions WHERE title = 'S3 恰限'").get();
    const nOver = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = 'S3 超一'").get().n;
    c.close();
    rec('S3 quote-only：恰限 100000 codepoint 全量入库、超一 413 显式拒绝零行',
      rAt.status === 200 && rOver.status === 413 && stAt.quote === at && nOver === 0
        && /quote/.test(String(errOver.error)) && errOver.error.includes('未截断'),
      'atStatus=' + rAt.status + ' atLen=' + (stAt && stAt.quote.length) + ' overStatus=' + rOver.status + ' overRows=' + nOver + ' err=' + String(errOver.error).slice(0, 60));
  });
}

// ── S4: 信封超限 413 零行；title 超限 413 零行（旧 slice 语义已废除） ────────────
{
  const db = rustInit(path.join(work, 's4.db'));
  await withSync(db, async (base) => {
    const rEnv = await post(base, { title: 'S4 信封超限', request_id: 's4-req', content: { request_id: 's4-req', format: 'plain', original: { kind: 'text', text: '汉'.repeat(100001) } } });
    const eEnv = await rEnv.json();
    const rTitle = await post(base, { title: 'x'.repeat(100001), quote: '正文正常', source_tool: 'webbox' });
    const eTitle = await rTitle.json();
    const rTitleAt = await post(base, { title: 'T'.repeat(100000), quote: '正文正常2', source_tool: 'webbox' });
    const c = dbOpen(db);
    const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = 'S4 信封超限'").get().n;
    const tAt = c.prepare("SELECT title FROM suggestions WHERE quote = '正文正常2'").get();
    c.close();
    rec('S4 超限矩阵：信封超一/标题超一 413 零行、标题恰限全量',
      rEnv.status === 413 && n === 0 && rTitle.status === 413 && rTitleAt.status === 200
        && tAt && tAt.title.length === 100000 && eEnv.error.includes('未截断') && /title/.test(String(eTitle.error)),
      'env=' + rEnv.status + '/' + n + ' titleOver=' + rTitle.status + ' titleAt=' + rTitleAt.status + '(len=' + (tAt && tAt.title.length) + ')');
  });
}

// ── S5: legacy v1 库——信封 409 显式拒绝零行；同库旧 quote-only 200 不受影响 ──────
for (const shape of ['v0-4', 'v1']) {
  const db = legacyDb(work, shape);
  await withSync(db, async (base) => {
    const rEnv = await post(base, { title: 'S5 ' + shape + ' 信封', request_id: 's5-' + shape, content: { request_id: 's5-' + shape, format: 'plain', original: { kind: 'text', text: 'x' } } });
    const eEnv = await rEnv.json();
    const rOld = await post(base, { title: 'S5 ' + shape + ' 旧客户端', quote: '旧通道正文 ' + shape, source_tool: 'web' });
    const c = dbOpen(db);
    const nEnv = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = ?").get('S5 ' + shape + ' 信封').n;
    const old = c.prepare("SELECT quote FROM suggestions WHERE title = ?").get('S5 ' + shape + ' 旧客户端');
    const cols = c.prepare('PRAGMA table_info(suggestions)').all().map((x) => x.name);
    c.close();
    rec('S5 sync@' + shape + '：信封 409 零行/旧 quote-only 200 原样/不建列',
      rEnv.status === 409 && nEnv === 0 && rOld.status === 200 && old && old.quote === '旧通道正文 ' + shape
        && !cols.includes('content_envelope') && eEnv.error.includes('零写入'),
      'env=' + rEnv.status + '/' + nEnv + ' old=' + rOld.status + ' cols 无 envelope=' + !cols.includes('content_envelope'));
  });
}

// ── S6: CORS 响应头——chrome-extension 来源回显；无来源不回 ─────────────────────
{
  const db = rustInit(path.join(work, 's6.db'));
  await withSync(db, async (base) => {
    const r = await fetch(base + '/api/health', { headers: { Origin: 'chrome-extension://abcdef' } });
    const r2 = await post(base, { title: 'S6 CORS', quote: 'x' }, { Origin: 'chrome-extension://abcdef' });
    const r3 = await post(base, { title: 'S6 无来源', quote: 'x' }, { Origin: 'http://evil.example' });
    const acao = r.headers.get('access-control-allow-origin');
    const acao2 = r2.headers.get('access-control-allow-origin');
    const acao3 = r3.headers.get('access-control-allow-origin');
    rec('S6 CORS：扩展来源 GET/POST 回显 ACAO、外部来源不回',
      acao === 'chrome-extension://abcdef' && acao2 === 'chrome-extension://abcdef' && !acao3 && r2.status === 200 && r3.status === 200,
      'healthACAO=' + acao + ' postACAO=' + acao2 + ' evilACAO=' + acao3);
  });
}

// ── S7: 非法信封 400 零行（未知格式/未知字段/坏字节/矛盾组合） ──────────────────
{
  const db = rustInit(path.join(work, 's7.db'));
  await withSync(db, async (base) => {
    const bads = [
      ['未知格式', { request_id: 's7a', format: 'rtf', original: { kind: 'text', text: 'x' } }],
      ['未知字段', { request_id: 's7b', format: 'plain', original: { kind: 'text', text: 'x' }, plain_projection: { status: 'available', text: '伪造' } }],
      ['坏字节', { request_id: 's7c', format: 'plain', original: { kind: 'bytes', bytes: [-1] } }],
      ['矛盾组合', { request_id: 's7d', format: 'markdown', format_provenance: 'legacy_assumed_plain', original: { kind: 'text', text: '# x' } }],
    ];
    const codes = [];
    for (const [name, content] of bads) {
      const r = await post(base, { title: 'S7 ' + name, content });
      codes.push([name, r.status]);
    }
    const c = dbOpen(db);
    const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'S7 %'").get().n;
    c.close();
    rec('S7 非法信封四型 400 零行', n === 0 && codes.every(([, c2]) => c2 === 400),
      'rows=' + n + ' codes=' + JSON.stringify(codes));
  });
}

// ── S8: bytes 信封入库（quote 空投影）+ markdown 声明 ──────────────────────────
{
  const db = rustInit(path.join(work, 's8.db'));
  await withSync(db, async (base) => {
    const bytes = Array.from(new TextEncoder().encode('{\\rtf1 二进制\xff}'));
    const r1 = await post(base, { title: 'S8 二进制', request_id: 's8-b', content: { request_id: 's8-b', format: 'plain', original: { kind: 'bytes', bytes, charset_hint: 'rtf' } } });
    const r2 = await post(base, { title: 'S8 markdown', request_id: 's8-m', content: { request_id: 's8-m', format: 'markdown', original: { kind: 'text', text: '# 标题\r\n- 项' } } });
    const row1 = await r1.json(); const row2 = await r2.json();
    const c = dbOpen(db);
    const stB = c.prepare('SELECT content_envelope, quote FROM suggestions WHERE id = ?').get(row1.id);
    const stM = c.prepare('SELECT content_envelope, quote FROM suggestions WHERE id = ?').get(row2.id);
    c.close();
    const envB = JSON.parse(stB.content_envelope); const envM = JSON.parse(stM.content_envelope);
    rec('S8 bytes 逐字节+quote 空 / markdown 声明入库',
      r1.status === 200 && r2.status === 200 && envB.original.bytes.length === bytes.length
        && envB.original.bytes.every((b, i) => b === bytes[i]) && stB.quote === ''
        && envM.format === 'markdown' && stM.quote === '# 标题\n- 项' && envM.acquisition === 'extension_dom',
      'bytes=' + envB.original.bytes.length + ' quoteB=' + JSON.stringify(stB.quote) + ' quoteM=' + JSON.stringify(stM.quote));
  });
}

// ── S9: 深检补——未配对代理（lone surrogate）显式拒绝零行；合法 emoji（代理对）不误伤 ──
{
  const db = rustInit(path.join(work, 's9.db'));
  await withSync(db, async (base) => {
    const badEnv = await post(base, { title: 'S9 孤代理信封', request_id: 's9-sg', content: { request_id: 's9-sg', format: 'plain', original: { kind: 'text', text: '前\uD800后' } } });
    const badQuote = await post(base, { title: 'S9 孤代理quote', quote: '前\uD800后', source_tool: 'web' });
    const okEmoji = await post(base, { title: 'S9 合法emoji', request_id: 's9-emoji', content: { request_id: 's9-emoji', format: 'plain', original: { kind: 'text', text: '🐱组合é\u0301' } } });
    const c = dbOpen(db);
    const n = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title LIKE 'S9 孤代理%'").get().n;
    const emoji = c.prepare("SELECT quote, content_envelope FROM suggestions WHERE title = 'S9 合法emoji'").get();
    c.close();
    const env = emoji && JSON.parse(emoji.content_envelope);
    rec('S9 孤代理：信封/quote-only 均 400 零行（防 U+FFFD 静默替换）；合法 emoji 代理对不受影响',
      badEnv.status === 400 && badQuote.status === 400 && n === 0
        && okEmoji.status === 200 && env && env.original.text === '🐱组合é\u0301' && emoji.quote === '🐱组合é\u0301',
      'env=' + badEnv.status + ' quote=' + badQuote.status + ' 拒绝行数=' + n + ' emoji=' + okEmoji.status + '/原文一致=' + !!(env && env.original.text === '🐱组合é\u0301'));
  });
}

fs.rmSync(work, { recursive: true, force: true });
process.exit(R.finish() ? 1 : 0);
