// MCP server 协议冒烟测试：node test-mcp.mjs
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
p.stdout.on('data', function (c) {
  buf += String(c);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) { const fn = pending.get(msg.id); pending.delete(msg.id); fn(msg); }
  }
});
p.stderr.on('data', function (c) { console.error('STDERR:', String(c)); });

function send(msg) { p.stdin.write(JSON.stringify(msg) + '\n'); }
function call(msg) { return new Promise(function (res) { pending.set(msg.id, res); send(msg); }); }
function textOf(resp) {
  if (resp.error) return 'ERROR: ' + resp.error.message;
  const c = resp.result && resp.result.content;
  return (c && c[0] && c[0].text) || JSON.stringify(resp.result);
}

const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '1.0' } } });
console.log('1) initialize    ->', init.result.serverInfo.name, '| 协议', init.result.protocolVersion);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const tools = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
console.log('2) tools/list    ->', tools.result.tools.map(function (t) { return t.name; }).join(', '));

const add = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_suggestion', arguments: { title: 'MCP 冒烟测试：可删除', quote: '测试原文', workspace: '/tmp/demo' } } });
console.log('3) add_suggestion->', textOf(add));

const list = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_suggestions', arguments: {} } });
console.log('4) list_suggest  ->\n' + textOf(list).split('\n').map(function (l) { return '   ' + l; }).join('\n'));

const idMatch = /id=(\d+)/.exec(textOf(add));
const newId = Number(idMatch && idMatch[1] || 0);
const upd = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'update_suggestion', arguments: { id: newId, status: 'done' } } });
console.log('5) update        ->', textOf(upd));

const db = new DatabaseSync(path.join(__dirname, 'data', 'inbox.db'));
const row = db.prepare("SELECT id, source_tool, status FROM suggestions WHERE id = ?").get(newId);
console.log('6) 入库校验      ->', JSON.stringify(row), '（source_tool 应为 claude-code，来自 clientInfo 自动映射）');
db.prepare("DELETE FROM suggestions WHERE id = ?").run(newId);
console.log('7) 清理          -> 测试数据已删除');
p.kill();
process.exit(0);
