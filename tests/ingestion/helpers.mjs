// tests/ingestion/helpers.mjs —— P1-T04 ingestion 测试共享基建。
// 复用 tests/migrations 的造库口径（Rust 迁移驱动 + 历史 SQL fixtures），
// 所有库均为临时目录内合成库，绝不触碰 App 主库 / data/inbox.db / 用户服务。
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContentEnvelope } from '../../schema-gate.mjs';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(__dirname, '..', '..');
export const CONTENT_FIXTURES = path.join(REPO, 'tests/content/fixtures');

export function mkWork(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-p1t04-' + tag + '-'));
}

/// Rust 权威建库（与 test-mcp.mjs / external-writers.mjs 同驱动）。
export function rustInit(dbPath) {
  const r = spawnSync('cargo', ['test', '--offline', 'migrations::tests::driver_init_db', '--', '--nocapture'], {
    cwd: path.join(REPO, 'app/src-tauri'),
    env: { ...process.env, NAYAN_MIGRATION_INIT_DB: dbPath },
    encoding: 'utf8', timeout: 120000,
  });
  if (r.status !== 0 || !fs.existsSync(dbPath)) {
    throw new Error('Rust 初始化驱动失败：' + r.stdout + r.stderr);
  }
  return dbPath;
}

/// 历史 schema 形态：'v0-4' | 'v0-5' | 'v1'（SQL 来自 tests/migrations/fixtures，注释行剥离）。
export function legacyDb(dir, shape) {
  const file = shape === 'v0-4' ? 'v0-4-pre-usermsg.sql' : shape === 'v0-5' ? 'v0-5-no-window.sql' : 'v1-full.sql';
  const db = path.join(dir, 'legacy-' + shape + '.db');
  const c = new DatabaseSync(db);
  c.exec('PRAGMA busy_timeout=2000;');
  c.exec(fs.readFileSync(path.join(REPO, 'tests/migrations/fixtures', file), 'utf8').replace(/^--.*$/gm, ''));
  c.close();
  return db;
}

export function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/// 真实 sync-server 子进程：等到监听（或退出）后返回句柄。
export async function startSync(dbPath, port) {
  const p = spawn(process.execPath, [path.join(REPO, 'sync-server.js')], {
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', (d) => { err += d; });
  const ok = await new Promise((res) => {
    const t0 = Date.now();
    const tryConn = () => {
      if (p.exitCode !== null) return res(false);
      if (Date.now() - t0 > 8000) return res(false);
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => { s.destroy(); setTimeout(tryConn, 200); });
    };
    tryConn();
  });
  if (!ok) {
    try { p.kill('SIGKILL'); } catch (_) {}
    throw new Error('sync-server 未监听：' + err.slice(0, 300));
  }
  return { p, err: () => err };
}

/// 真实 MCP 子进程（stdio JSON-RPC），支持任意调用序列。
export class McpClient {
  constructor(dbPath) {
    this.p = spawn(process.execPath, [path.join(REPO, 'mcp-server.js')], {
      env: { ...process.env, DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 0;
    this.stderr = '';
    this.exited = null;
    this.p.stderr.on('data', (d) => { this.stderr += d; });
    this.p.on('exit', (c) => { this.exited = c; });
    this.p.stdout.on('data', (c) => {
      this.buf += String(c);
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const fn = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          fn(msg);
        }
      }
    });
  }
  send(msg) { this.p.stdin.write(JSON.stringify(msg) + '\n'); }
  call(method, params) {
    const id = ++this.nextId;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async initialize(clientName) {
    const r = await this.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: clientName || 'p1t04-probe', version: '1.0' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }
  async tool(name, args) {
    return this.call('tools/call', { name, arguments: args });
  }
  kill() { try { this.p.kill('SIGKILL'); } catch (_) {} }
}

/// 工具调用的可读文本（错误时含 ERROR: 前缀）。
export function toolText(resp) {
  if (resp.error) return 'ERROR: ' + resp.error.message;
  const c = resp.result && resp.result.content;
  return (c && c[0] && c[0].text) || JSON.stringify(resp.result);
}

/// 服务端应构建出的期望信封（共享构建器直调——与被测服务同源，作为「服务侧应写内容」的规格）。
export function expectEnvelope(input, defaults) {
  const b = buildContentEnvelope(input, defaults);
  if (!b.ok) throw new Error('测试内部错误：期望信封构建失败 ' + b.reason);
  return b;
}

export function dbOpen(db) {
  const c = new DatabaseSync(db);
  c.exec('PRAGMA busy_timeout=2000;');
  return c;
}

export function codepoints(s) {
  let n = 0;
  for (const _ of String(s)) n++;
  return n;
}

/// 测试结果记录（与项目套件风格一致：console + JSON 落盘）。
export function makeRecorder(outDir, suiteName) {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  return {
    rec(name, ok, detail) {
      results.push({ name, ok, detail: String(detail).slice(0, 300) });
      console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + ' — ' + String(detail).slice(0, 160));
    },
    finish() {
      fs.writeFileSync(path.join(outDir, suiteName + '.json'),
        JSON.stringify({ suite: suiteName, coverage: 'real mcp-server.js / sync-server.js processes; synthetic temp DBs; verified via node:sqlite', results }, null, 2));
      const failed = results.filter((r) => !r.ok).length;
      console.log(failed ? suiteName + ': ' + failed + ' 例失败' : suiteName + ': ' + results.length + ' 例通过');
      return failed;
    },
  };
}

export const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
