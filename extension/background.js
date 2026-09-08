// 纳言捕捉 · 背景服务
// 职责：右键菜单 / 工具栏 / 快捷键三个入口 → 注入内容脚本并进入框选模式；
//       内容脚本的入库与项目列表请求由这里中转（页面里 fetch localhost 会被 CORS 拦）。
const INBOX = 'http://localhost:8787/api/suggestions';
const PROJECTS = 'http://localhost:8787/api/projects';

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
      files: ['content/box-select.js']
    });
    chrome.tabs.sendMessage(tab.id, { type: 'nayan:arm' }, function () {
      void chrome.runtime.lastError; // 无接收方时静默（脚本刚注入自己会进入待命）
    });
  } catch (e) {
    flash('!'); // chrome:// 等页面无法注入
  }
}

// 旧通道保留：划词右键 → 不弹卡直接入库
function quickSave(info, tab) {
  var text = (info.selectionText || '').trim();
  if (!text) return;
  var title = text.split('\n')[0].slice(0, 100);
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
    fetch(PROJECTS)
      .then(function (r) { return r.json(); })
      .then(function (list) { sendResponse({ ok: true, list: list }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
});

async function saveSuggestion(p) {
  try {
    const r = await fetch(INBOX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    });
    if (!r.ok) {
      const d = await r.json().catch(function () { return {}; });
      return { ok: false, error: d.error || ('HTTP ' + r.status) };
    }
    const row = await r.json();
    flash('✓');
    return { ok: true, id: row.id };
  } catch (e) {
    flash('!');
    return { ok: false, error: '连不上收件箱（server.js / 纳言 App 在运行吗？）' };
  }
}

function flash(mark) {
  chrome.action.setBadgeText({ text: mark });
  chrome.action.setBadgeBackgroundColor({ color: mark === '✓' ? '#059669' : '#b91c1c' });
  setTimeout(function () { chrome.action.setBadgeText({ text: '' }); }, 2500);
}
