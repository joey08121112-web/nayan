// 纳言捕捉 · 背景服务
// 职责：右键菜单 / 工具栏 / 快捷键三个入口 → 注入内容脚本并进入框选模式；
//       内容脚本的入库与项目列表请求由这里中转（页面里 fetch localhost 会被 CORS 拦）。
importScripts('title-rule.js');   // 统一取标题规则（与 App 同口径）
// P1-T04：同步服务端点可经 chrome.storage.local 的 'nayan:endpoint' 覆盖（默认
// http://localhost:8787 不变）——隔离测试可指向临时端口，生产行为零变化。
const DEFAULT_BASE = 'http://localhost:8787';

async function endpoints() {
  var base = DEFAULT_BASE;
  try {
    var o = await chrome.storage.local.get('nayan:endpoint');
    if (o && o['nayan:endpoint']) base = String(o['nayan:endpoint']).replace(/\/+$/, '');
  } catch (e) {}
  return { inbox: base + '/api/suggestions', projects: base + '/api/projects' };
}

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: 'nayan-box-select',
    title: '🖼 框选捕获此页（纳言）',
    contexts: ['page', 'selection', 'frame', 'link', 'image']
  });
  chrome.contextMenus.create({
    id: 'nayan-add-selection',
    title: '📥 选中内容存入纳言',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'nayan-box-select') startBoxSelect(tab);
  if (info.menuItemId === 'nayan-add-selection') quickSave(info, tab);
});

chrome.action.onClicked.addListener(function (tab) {
  if (tab && tab.id) startBoxSelect(tab);
});

chrome.commands.onCommand.addListener(function (cmd, tab) {
  if (cmd !== 'run-box-select') return;
  if (tab && tab.id) return startBoxSelect(tab);
  chrome.tabs.query({ active: true, currentWindow: true }, function (ts) {
    if (ts[0] && ts[0].id) startBoxSelect(ts[0]);
  });
});

// 进入框选：content script 可重复注入（内部有幂等标记），已存在则直接唤起
async function startBoxSelect(tab) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['title-rule.js', 'content/box-select.js']
    });
    chrome.tabs.sendMessage(tab.id, { type: 'nayan:arm' }, function () {
      void chrome.runtime.lastError; // 无接收方时静默（脚本刚注入自己会进入待命）
    });
  } catch (e) {
    flash('!'); // chrome:// 等页面无法注入
  }
}

// 旧通道保留：划词右键 → 不弹卡直接入库
// P1-T04/S03：正文原样透传（不再 trim——选中文字的首尾空白/换行逐字符保留，
// 服务端同口径不 trim）；空判只拦全空白。
function quickSave(info, tab) {
  var text = info.selectionText || '';
  if (!text.trim()) return;
  var title = NayanTitle.shortTitle(text);   // 统一取标题规则（title-rule.js）
  var ref = ((tab && tab.title) || '') + ' | ' + (info.pageUrl || '');
  saveSuggestion({
    title: title,
    quote: text,
    my_note: '',
    source_tool: 'web',
    session_ref: ref
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object' || !msg.type) return;
  if (msg.type === 'nayan:save') {
    saveSuggestion(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === 'nayan:projects') {
    endpoints().then(function (ep) {
      return fetch(ep.projects);
    })
      .then(function (r) { return r.json(); })
      .then(function (list) { sendResponse({ ok: true, list: list }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
});

async function saveSuggestion(p) {
  try {
    const ep = await endpoints();
    const r = await fetch(ep.inbox, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    });
    if (!r.ok) {
      const d = await r.json().catch(function () { return {}; });
      console.warn('[NaYan] 保存被服务端拒绝：HTTP ' + r.status + (d && d.error ? ' ' + d.error : ''));
      flash('!');
      return { ok: false, error: d.error || ('HTTP ' + r.status) };
    }
    const row = await r.json();
    flash('✓');
    return { ok: true, id: row.id };
  } catch (e) {
    flash('!');
    return { ok: false, error: '连不上收件箱（请先打开纳言桌面端，或运行 sync-server.js）' };
  }
}

function flash(mark) {
  chrome.action.setBadgeText({ text: mark });
  chrome.action.setBadgeBackgroundColor({ color: mark === '✓' ? '#059669' : '#b91c1c' });
  setTimeout(function () { chrome.action.setBadgeText({ text: '' }); }, 2500);
}
