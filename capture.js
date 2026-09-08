#!/usr/bin/env node
// 全局文字捕获：把选中的文字发进「建议收件箱」
// 由 macOS 快捷指令（快速操作）调用；文字从 stdin 或第一个参数传入
// DEBUG=1 node capture.js 可看日志
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let text = '';
if (process.argv[2]) text = process.argv[2];
else { try { text = readFileSync(0, 'utf8'); } catch (e) { text = ''; } }
text = String(text || '').trim();

var DEBUG = !!process.env.DEBUG;
function log(s) { if (DEBUG) console.log('[capture]', s); }

function notify(msg) {
  try {
    execFileSync('osascript', ['-e',
      'display notification "' + msg.replace(/"/g, "'") + '" with title "📥 建议收件箱"'
    ], { timeout: 2000 });
  } catch (e) { log('通知失败(可忽略): ' + e.message); }
}

if (!text) { notify('没有收到选中的文字'); process.exit(1); }

function frontApp() {
  try {
    return execFileSync('osascript', ['-e',
      'tell application "System Events" to get name of first application process whose frontmost is true'
    ], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (e) { log('frontApp 失败: ' + e.message); return ''; }
}

var title = text.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 100);
var app = frontApp();
log('来源 App: ' + (app || '(未知)'));

fetch('http://localhost:8787/api/suggestions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: title,
    quote: text,
    source_tool: app || 'other'
  })
}).then(function (r) {
  log('HTTP ' + r.status);
  if (r.ok) notify('已收进：' + title.slice(0, 24));
  else notify('失败：HTTP ' + r.status);
}).catch(function (e) {
  log(e.message);
  notify('失败：请先启动 node server.js');
});
