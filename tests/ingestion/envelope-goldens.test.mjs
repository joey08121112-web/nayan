#!/usr/bin/env node
// tests/ingestion/envelope-goldens.test.mjs —— P1-T04 跨语言契约对账：
// schema-gate.mjs 的 buildContentEnvelope 输出必须与 tests/content 已验收的
// golden 信封（Rust 序列化产出、且经 Rust round-trip/一致性重算验收）逐案相等。
// golden 由 Rust 侧 fixtures_golden_contract 维护——本测试证明「JS 构建的信封
// 就是 Rust 会接受的信封」（传递性：相等 ⇒ Rust Deserialize/重算一致 ⇒ 可读回）。
// 用法：node tests/ingestion/envelope-goldens.test.mjs [--out DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContentEnvelope } from '../../schema-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(__dirname, '..', '..', 'tests', 'content');
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-envelope-goldens-'));
fs.mkdirSync(outDir, { recursive: true });

const cases = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json'), 'utf8'));
let pass = 0, fail = 0;
const rows = [];
for (const c of cases) {
  const bytes = fs.readFileSync(path.join(BASE, 'fixtures', c.fixture));
  const input = {
    schema_version: 1,
    request_id: c.request_id,
    format: c.format,
    format_provenance: c.legacy ? 'legacy_assumed_plain' : 'declared',
    acquisition: c.legacy ? 'legacy_import' : c.acquisition,
    original: c.binary
      ? { kind: 'bytes', bytes: Array.from(bytes), charset_hint: c.charset_hint === undefined ? null : c.charset_hint }
      : { kind: 'text', text: new TextDecoder().decode(bytes) },
  };
  const built = buildContentEnvelope(input);
  const golden = JSON.parse(fs.readFileSync(path.join(BASE, 'golden', c.fixture + '.json'), 'utf8'));
  const same = built.ok && JSON.stringify(built.envelope) === JSON.stringify(golden);
  if (same) pass++; else fail++;
  rows.push({ fixture: c.fixture, ok: !!same,
    reason: built.ok ? (same ? '' : '信封与 golden 不符：got ' + JSON.stringify(built.envelope).slice(0, 200) + ' expect ' + JSON.stringify(golden).slice(0, 200)) : built.reason });
  console.log((same ? 'PASS' : 'FAIL') + ' golden 对账 ' + c.fixture + (same ? '' : ' — ' + rows[rows.length - 1].reason.slice(0, 160)));
}
fs.writeFileSync(path.join(outDir, 'envelope-goldens.json'), JSON.stringify({ pass, fail, rows }, null, 2));
console.log(fail ? 'envelope-goldens: ' + fail + ' 例失败' : 'envelope-goldens: ' + pass + ' 例通过');
process.exit(fail ? 1 : 0);
