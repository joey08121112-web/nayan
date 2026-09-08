// 向 MCP 配置文件安全合并 suggestion-inbox 服务器（幂等，自动备份）
// 用法: node merge-mcp.mjs <config.json路径> <zcode|agents> <mcp-server.js绝对路径>
import fs from 'node:fs';
const cfgPath = process.argv[2];
const flavor = process.argv[3];
const script = process.argv[4];
if (!cfgPath || !fs.existsSync(cfgPath)) { console.error('配置文件不存在: ' + cfgPath); process.exit(1); }
let c;
try { c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
catch (e) { console.error('配置不是合法 JSON，跳过以免损坏'); process.exit(1); }
const entry = { command: 'node', args: [script] };
if (flavor === 'zcode') {
  c.mcp = c.mcp || {}; c.mcp.servers = c.mcp.servers || {};
  c.mcp.servers['suggestion-inbox'] = entry;
} else {
  c.mcpServers = c.mcpServers || {};
  c.mcpServers['suggestion-inbox'] = entry;
}
fs.writeFileSync(cfgPath + '.bak-setup', JSON.stringify(c, null, 2));
fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2) + '\n');
console.log('merged -> ' + cfgPath);
