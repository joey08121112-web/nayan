#!/usr/bin/env node
// tests/ingestion/batch-duplicate-probe.mjs —— P1-B04-REPAIR-01 批内同 request_id 查重探针。
//
// 复用总控 control/reviews/P1-B04-R1/batch-duplicate-probe.mjs 的时序（真实 MCP 子进程 +
// Rust 初始化隔离库 + 同批两条共用 same-in-batch、正文 A/B），输出位置经 --out 指定到本批
// 目录——不改写总控原始 probe/result。可用作修前复现与修后独立复验（--tag 区分输出文件名）。
//
// 用法：node tests/ingestion/batch-duplicate-probe.mjs --out DIR [--tag before|after]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkWork, rustInit, McpClient, toolText, dbOpen } from './helpers.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-batch-duplicate-'));
const tagIdx = args.indexOf('--tag');
const tag = tagIdx >= 0 ? args[tagIdx + 1] : 'run';
fs.mkdirSync(outDir, { recursive: true });

const work = mkWork('b04r01-batch-duplicate');
let cli;
try {
  const db = rustInit(path.join(work, 'probe.db'));
  cli = new McpClient(db);
  await cli.initialize('p1b04-repair01-probe');
  const request = {
    items: ['A', 'B'].map((text) => ({
      title: 'same-' + text,
      content: { request_id: 'same-in-batch', format: 'plain', original: { kind: 'text', text } },
    })),
  };
  const response = await cli.tool('add_suggestions', request);
  const c = dbOpen(db);
  const rows = c.prepare('SELECT id,title,quote,content_envelope FROM suggestions ORDER BY id').all();
  c.close();
  const result = {
    tag,
    request,
    response: toolText(response),
    rows,
    contract_passed: rows.length === 1,
    isolated: true,
    work_dir: work.replace(/^.*\//, '') + '（结束即删）',
  };
  fs.writeFileSync(path.join(outDir, 'batch-duplicate-' + tag + '.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ tag, rows: rows.length, contract_passed: rows.length === 1 }));
} finally {
  if (cli && cli.p.exitCode === null && cli.p.signalCode === null) { const stopped = once(cli.p, 'exit'); cli.kill(); await stopped; }
  fs.rmSync(work, { recursive: true, force: true });
}
