/* 纳言捕捉 · 内容脚本
 * 框选流程：浮动气泡/快捷键/右键 → 十字光标框选 → 矩形映射文本块（外层块保留、嵌套去重）
 *          → 玻璃批注卡（原文可改 + 我的想法 + 项目归类）→ 经 background 入库。
 * 实现要点移植自 Wispal 拆解：capture 阶段接管事件、边缘自动滚动、120ms 节流重映射、
 * content-visibility 强制展开、prefers-reduced-motion 降级、warnOnce 诊断。
 */
(function () {
  'use strict';
  if (window.__NAYAN_CAPTURE__) {
    try { window.__NAYAN_CAPTURE__.arm(); } catch (e) {}
    return;
  }

  // ---------- 常量 ----------
  var Z = 2147483600;
  var COVER_MIN_RATIO = 0.45;   // 块与矩形交叠面积占比达到才算命中
  var CONTAIN_RATIO = 0.9;      // 内层块被外层块覆盖 ≥90% 时丢弃（保留外层）
  var REMAP_MS = 120;           // 拖拽中重映射节流
  var EDGE_BAND = 80;           // 自动滚动感应带
  var SCROLL_MAX = 22;          // 自动滚动每帧上限 px
  var QUOTE_CAP = 20000;        // 原文长度上限

  var warnOnce = (function () {
    var seen = {};
    return function (key, msg) {
      if (seen[key]) return;
      seen[key] = 1;
      console.warn('[NaYan] ' + msg);
    };
  })();

  // ---------- chrome API 守卫（便于测试桩注入） ----------
  function sendMsg(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch (e) { resolve(null); }
    });
  }
  function storeGet(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (o) {
          void chrome.runtime.lastError;
          resolve(o && o[key]);
        });
      } catch (e) { resolve(undefined); }
    });
  }
  function storeSet(key, val) {
    try { chrome.storage.local.set(Object.defineProperty({}, key, { value: val })); } catch (e) {}
  }

  // ---------- 影子根与样式 ----------
  var host = document.createElement('div');
  host.id = 'nayan-capture-host';
  var root = host.attachShadow({ mode: 'open' });

  var CSS = ''
    + ':host{all:initial}'
    + '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}'
    + '.dim{position:fixed;inset:0;z-index:' + (Z + 1) + ';background:rgba(4,5,9,.52);opacity:0;pointer-events:none;transition:opacity .28s ease}'
    + '.dim.show{opacity:1}'
    + '.dim.backdrop{pointer-events:auto}'
    + '.canvas{position:fixed;inset:0;z-index:' + (Z + 2) + ';pointer-events:none;will-change:transform}'
    + '.rect{position:absolute;display:none;border:1.5px dashed rgba(140,210,215,.95);border-radius:6px;'
    +       'background:rgba(140,210,215,.07);box-shadow:0 0 26px rgba(140,210,215,.16)}'
    + '.rect.ok{border-color:rgba(240,148,100,.95);background:rgba(240,148,100,.09);box-shadow:0 0 26px rgba(240,148,100,.2)}'
    + '.blk{position:absolute;border:1px solid rgba(240,148,100,.8);border-radius:4px;background:rgba(240,148,100,.12)}'
    + '.hint{position:fixed;bottom:26px;left:50%;z-index:' + (Z + 5) + ';display:inline-flex;align-items:center;gap:9px;'
    +       'padding:8px 15px;border-radius:999px;background:rgba(40,42,48,.6);backdrop-filter:blur(20px) saturate(120%);'
    +       '-webkit-backdrop-filter:blur(20px) saturate(120%);border:1px solid rgba(255,255,255,.12);'
    +       'box-shadow:0 8px 24px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.1);'
    +       'font-size:13px;color:rgba(255,255,255,.88);white-space:nowrap;pointer-events:none;'
    +       'opacity:0;transform:translateX(-50%) translateY(8px) scale(.96);'
    +       'transition:opacity .3s ease,transform .34s cubic-bezier(.05,.7,.1,1)}'
    + '.hint.show{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}'
    + '.hint .k{font-family:"SF Mono",Menlo,monospace;font-size:10px;padding:1px 6px;border-radius:4px;'
    +       'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-bottom-width:1.5px;color:rgba(255,255,255,.72)}'
    + '.hint .cnt{color:#f09464;font-weight:600;display:none}'
    + '.hint svg{color:#f09464;flex-shrink:0}'
    + '.demo-rect{fill:none;stroke:rgba(140,210,215,.95);stroke-width:1;stroke-dasharray:2 1.6;stroke-linecap:round;'
    +       'animation:ny-demo-rect 2.4s ease-in-out infinite}'
    + '.demo-cur{animation:ny-demo-cur 2.4s ease-in-out infinite}'
    + '@keyframes ny-demo-cur{0%{transform:translate(2.5px,3.5px);opacity:0}10%{transform:translate(2.5px,3.5px);opacity:1}'
    +   '55%,88%{transform:translate(13px,10.5px);opacity:1}96%,100%{transform:translate(13px,10.5px);opacity:0}}'
    + '@keyframes ny-demo-rect{0%{width:0;height:0;opacity:0}10%{width:0;height:0;opacity:1}'
    +   '55%,88%{width:11px;height:7px;opacity:1}96%,100%{width:11px;height:7px;opacity:0}}'
    + '.toast{position:fixed;bottom:86px;left:50%;transform:translateX(-50%);z-index:' + (Z + 6) + ';'
    +       'background:rgba(28,30,36,.92);border:1px solid rgba(255,255,255,.16);color:rgba(255,255,255,.92);'
    +       'border-radius:999px;padding:9px 18px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .3s;'
    +       'backdrop-filter:blur(12px);max-width:80vw;text-align:center}'
    + '.toast.show{opacity:1}'
    + '.bubble{position:fixed;z-index:' + Z + ';width:46px;height:46px;border-radius:50%;'
    +       'background:rgba(30,32,38,.72);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);'
    +       'border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12);'
    +       'display:grid;place-items:center;color:rgba(255,255,255,.9);cursor:pointer;pointer-events:auto;touch-action:none;'
    +       'transition:transform .22s cubic-bezier(.2,.8,.2,1),border-color .22s,box-shadow .22s;user-select:none;-webkit-user-select:none}'
    + '.bubble:hover{transform:scale(1.08);border-color:rgba(240,148,100,.55);box-shadow:0 12px 34px rgba(240,148,100,.18),inset 0 1px 0 rgba(255,255,255,.12)}'
    + '.bubble:active{transform:scale(.94)}'
    + '.bubble svg{pointer-events:none}'
    + '.card{position:fixed;left:50%;bottom:30px;z-index:' + (Z + 4) + ';width:min(580px,92vw);'
    +       'transform:translateX(-50%) translateY(16px) scale(.98);opacity:0;pointer-events:none;'
    +       'background:rgba(26,28,34,.78);backdrop-filter:blur(28px) saturate(150%);-webkit-backdrop-filter:blur(28px) saturate(150%);'
    +       'border:1px solid rgba(255,255,255,.13);border-radius:20px;padding:18px 20px 16px;'
    +       'box-shadow:0 24px 70px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.09);'
    +       'transition:opacity .32s ease,transform .36s cubic-bezier(.05,.7,.1,1);color:rgba(255,255,255,.92)}'
    + '.card.show{opacity:1;transform:translateX(-50%) translateY(0) scale(1);pointer-events:auto}'
    + '.chead{display:flex;align-items:center;gap:9px;margin-bottom:12px;font-size:14px}'
    + '.cdot{width:8px;height:8px;border-radius:50%;background:#f09464;box-shadow:0 0 8px #f09464;flex-shrink:0}'
    + '.chead b{font-weight:650}'
    + '.cmeta{color:rgba(255,255,255,.45);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}'
    + '.cx{background:none;border:none;color:rgba(255,255,255,.5);font-size:15px;cursor:pointer;padding:2px 6px;border-radius:6px}'
    + '.cx:hover{color:#fff;background:rgba(255,255,255,.08)}'
    + '.card textarea,.card input{width:100%;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);'
    +       'border-radius:11px;padding:9px 12px;color:rgba(255,255,255,.92);font-size:13.5px;line-height:1.6;'
    +       'font-family:inherit;resize:none;outline:none;transition:border-color .2s,background .2s}'
    + '.card textarea:focus,.card input:focus{border-color:rgba(240,148,100,.55);background:rgba(255,255,255,.08)}'
    + '.card textarea::placeholder,.card input::placeholder{color:rgba(255,255,255,.32)}'
    + '.cq{max-height:150px;overflow-y:auto;margin-bottom:9px;min-height:44px}'
    + '.cn{min-height:58px;margin-bottom:11px}'
    + '.crow{display:flex;gap:8px;align-items:center;margin-bottom:13px}'
    + '.crow select{flex:1;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);border-radius:10px;'
    +       'padding:7px 10px;color:rgba(255,255,255,.92);font-size:13px;outline:none;font-family:inherit;'
    +       'appearance:none;-webkit-appearance:none}'
    + '.crow select option{background:#22242a;color:#eee}'
    + '.cnew{background:none;border:1px solid rgba(255,255,255,.16);color:rgba(255,255,255,.75);border-radius:10px;'
    +       'padding:7px 12px;font-size:12.5px;cursor:pointer;font-family:inherit;white-space:nowrap}'
    + '.cnew:hover{border-color:rgba(240,148,100,.5);color:#f09464}'
    + '.cnewin{display:none;flex:1;gap:8px}.crow.editing .cnewin{display:flex}.crow.editing select,.crow.editing>.cnew{display:none}'
    + '.cnewin input{flex:1}.cnewok{white-space:nowrap}'
    + '.cfoot{display:flex;align-items:center;gap:10px}'
    + '.cerr{color:#ff8a8a;font-size:12.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.cbtn{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:rgba(255,255,255,.85);'
    +       'border-radius:999px;padding:8px 18px;font-size:13.5px;cursor:pointer;font-family:inherit;transition:all .2s}'
    + '.cbtn:hover{border-color:rgba(255,255,255,.3)}'
    + '.cbtn.primary{background:linear-gradient(135deg,#f09464,#e87f4b);border-color:transparent;color:#fff;font-weight:600;'
    +       'box-shadow:0 6px 18px rgba(240,148,100,.3)}'
    + '.cbtn.primary:hover{box-shadow:0 8px 24px rgba(240,148,100,.42)}'
    + '.cbtn.primary[disabled]{opacity:.6;cursor:default}'
    + '.cdone{text-align:center;padding:10px 0 6px}'
    + '.cdone .ok{font-size:15px;font-weight:650;margin-bottom:4px}'
    + '.cdone .ok em{color:#f09464;font-style:normal}'
    + '.cdone .sub{font-size:12.5px;color:rgba(255,255,255,.5);margin-bottom:14px}'
    + '.cdone .row{display:flex;gap:10px;justify-content:center}'
    + '.cdone a{color:rgba(140,210,215,.95);text-decoration:none;font-size:13.5px;display:inline-flex;align-items:center;gap:5px;'
    +       'padding:8px 16px;border:1px solid rgba(140,210,215,.35);border-radius:999px}'
    + '.cdone a:hover{background:rgba(140,210,215,.1)}'
    + '@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}';

  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  // 页面级样式：框选时的光标/禁选中/禁原生滚动；.nayan-cv-fix 用于 content-visibility 展开
  var pageStyle = document.createElement('style');
  pageStyle.textContent = ''
    + 'html.nayan-on,html.nayan-on body{cursor:crosshair!important}'
    + 'html.nayan-on *{cursor:crosshair!important;user-select:none!important;-webkit-user-select:none!important}'
    + 'html.nayan-on{touch-action:none}'
    + '.nayan-cv-fix{content-visibility:visible!important}';

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  var dim = el('div', 'dim');
  var canvas = el('div', 'canvas');
  var rectEl = el('div', 'rect');
  var blocksEl = el('div');
  canvas.appendChild(rectEl);
  canvas.appendChild(blocksEl);

  var HINT_SVG = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">'
    + '<rect class="demo-rect" x="2.5" y="3.5" width="11" height="7" rx="1.5"></rect>'
    + '<g class="demo-cur"><path d="M2.5 3.5 L2.5 11 L4.3 9.4 L5.4 11.8 L6.3 11.4 L5.3 9 L7.2 9 Z" fill="currentColor" stroke="none"></path></g>'
    + '</svg>';
  var hint = el('div', 'hint');
  hint.lang = 'zh-CN';
  hint.innerHTML = HINT_SVG
    + '<span class="hlabel">拖拽以选取</span>'
    + '<span class="cnt"></span>'
    + '<span class="k">Esc</span>';
  var hintLabel = hint.querySelector('.hlabel');
  var hintCnt = hint.querySelector('.cnt');

  var toastEl = el('div', 'toast');
  toastEl.lang = 'zh-CN';

  var BUBBLE_SVG = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>'
    + '<path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>'
    + '</svg><span style="position:absolute;top:7px;right:8px;width:7px;height:7px;border-radius:50%;'
    + 'background:#f09464;box-shadow:0 0 6px #f09464"></span>';
  var bubble = el('div', 'bubble');
  bubble.title = '纳言 · 框选捕获（拖动移位置）';
  bubble.lang = 'zh-CN';
  bubble.innerHTML = BUBBLE_SVG;
  bubble.style.display = 'none';

  var card = el('div', 'card');
  card.lang = 'zh-CN';

  root.appendChild(dim);
  root.appendChild(canvas);
  root.appendChild(hint);
  root.appendChild(toastEl);
  root.appendChild(card);
  root.appendChild(bubble);

  // ---------- 状态 ----------
  var phase = 'idle';           // idle | armed | dragging | card
  var drag = null;              // {sx,sy,cx,cy,lastClientY} —— 内容坐标
  var picked = [];
  var lastRemap = 0;
  var scrollRAF = 0;
  var toastTimer = 0;
  var listeners = [];           // [target, type, fn]（框选期间临时监听，退出时统一移除）

  // ---------- 工具 ----------
  function inHost(e) {
    var p = e.composedPath ? e.composedPath() : [];
    return p.indexOf(host) !== -1;
  }
  function onCapture(t, type, fn) {
    t.addEventListener(type, fn, true);
    listeners.push([t, type, fn]);
  }
  function clearListeners() {
    listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], true); });
    listeners = [];
  }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function hasDirectText(n) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (c.nodeType === 3 && c.data && c.data.trim()) return true;
    }
    return false;
  }
  function intersects(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }
  function interArea(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 && h > 0) ? w * h : 0;
  }
  function containsRect(outer, inner, ratio) {
    var a = inner.width * inner.height;
    if (a <= 0) return false;
    return interArea(outer, inner) / a >= ratio;
  }
  function viewportRect(r) { // 视口 DOMRect → 内容坐标
    return { left: r.left + scrollX, top: r.top + scrollY,
             right: r.right + scrollX, bottom: r.bottom + scrollY,
             width: r.width, height: r.height };
  }
  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var showToast = (function () {
    var shown = '';
    return function (msg, ms) {
      shown = msg;
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        if (toastEl.textContent === shown) toastEl.classList.remove('show');
      }, ms || 2600);
    };
  })();

  // ---------- 候选块收集与映射 ----------
  var SKIP_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, IFRAME:1, CANVAS:1, SVG:1,
    TEXTAREA:1, INPUT:1, SELECT:1, OPTION:1, BUTTON:1, VIDEO:1, AUDIO:1, PICTURE:1, SOURCE:1,
    META:1, LINK:1, HEAD:1, DIALOG:1 };

  function collectCandidates() {
    var out = [];
    if (!document.body) return out;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    var node = walker.nextNode();
    for (; node; node = walker.nextNode()) {
      if (node === host || host.contains(node)) continue;
      if (SKIP_TAGS[node.tagName]) continue;
      if (!hasDirectText(node)) continue;
      var r = node.getBoundingClientRect();
      if (r.width < 12 || r.height < 6) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      var cs = getComputedStyle(node);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      out.push({ el: node, r: r });
    }
    return out;
  }

  // 把候选上移到"恰好拥有这段文本"的最近块容器（合并高亮 span / 代码行）
  function consolidate(node) {
    var cur = node;
    for (var i = 0; i < 8; i++) {
      var p = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement || p === host) break;
      if (hasDirectText(p)) break;
      if (norm(p.textContent) !== norm(cur.textContent)) break;
      var pr = p.getBoundingClientRect();
      if (pr.width > innerWidth * 1.2) break;
      cur = p;
    }
    return cur;
  }

  function pickBlocks(sel) { // sel：内容坐标矩形
    var cands = collectCandidates();
    var hits = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var cr = viewportRect(c.r);
      if (!intersects(sel, cr)) continue;
      var area = cr.width * cr.height;
      if (area <= 0) continue;
      // 双条件命中：① 垂直覆盖 ≥50% 且横向交叠 ≥24px（带子扫过的行都算——通用网页段落宽，
      // 纯面积占比会把窄矩形扫过宽段落的情形全漏掉）；② 或整体面积覆盖 ≥45%
      var interW = Math.min(sel.right, cr.right) - Math.max(sel.left, cr.left);
      var interH = Math.min(sel.bottom, cr.bottom) - Math.max(sel.top, cr.top);
      var vCover = interH / cr.height;
      var aCover = interArea(sel, cr) / area;
      if (!((vCover >= 0.5 && interW >= 24) || aCover >= COVER_MIN_RATIO)) continue;
      hits.push({ el: c.el, r: cr });
    }
    var map = new Map();
    for (var j = 0; j < hits.length; j++) {
      var owner = consolidate(hits[j].el);
      if (!map.has(owner)) map.set(owner, viewportRect(owner.getBoundingClientRect()));
    }
    var arr = [];
    map.forEach(function (r, elx) { arr.push({ el: elx, r: r }); });
    arr.sort(function (a, b) { return (b.r.width * b.r.height) - (a.r.width * a.r.height); });
    var keep = [];
    for (var k = 0; k < arr.length; k++) {
      var contained = false;
      for (var m = 0; m < keep.length; m++) {
        if (containsRect(keep[m].r, arr[k].r, CONTAIN_RATIO)) { contained = true; break; }
      }
      if (!contained) keep.push(arr[k]);
    }
    keep.sort(function (a, b) {
      var pos = a.el.compareDocumentPosition(b.el);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    return keep;
  }

  // ---------- 框选可视化 ----------
  function canvasTransform() {
    canvas.style.transform = 'translate(' + (-scrollX) + 'px,' + (-scrollY) + 'px)';
  }
  function updateRectVisual() {
    if (!drag) return;
    var left = Math.min(drag.sx, drag.cx), top = Math.min(drag.sy, drag.cy);
    rectEl.style.display = 'block';
    rectEl.style.left = left + 'px';
    rectEl.style.top = top + 'px';
    rectEl.style.width = Math.abs(drag.cx - drag.sx) + 'px';
    rectEl.style.height = Math.abs(drag.cy - drag.sy) + 'px';
    rectEl.classList.toggle('ok', picked.length > 0);
  }
  function drawBlocks() {
    blocksEl.textContent = '';
    for (var i = 0; i < picked.length; i++) {
      var b = el('div', 'blk');
      b.style.left = picked[i].r.left + 'px';
      b.style.top = picked[i].r.top + 'px';
      b.style.width = picked[i].r.width + 'px';
      b.style.height = picked[i].r.height + 'px';
      blocksEl.appendChild(b);
    }
    if (picked.length) {
      hintCnt.style.display = 'inline';
      hintCnt.textContent = '已框到 ' + picked.length + ' 块';
      hintLabel.textContent = '松手捕获';
    } else {
      hintCnt.style.display = 'none';
      hintLabel.textContent = '拖拽以选取';
    }
  }
  function maybeRemap(force) {
    var now = Date.now();
    if (!force && now - lastRemap < REMAP_MS) return;
    lastRemap = now;
    var sel = { left: Math.min(drag.sx, drag.cx), top: Math.min(drag.sy, drag.cy),
                right: Math.max(drag.sx, drag.cx), bottom: Math.max(drag.sy, drag.cy) };
    picked = pickBlocks(sel);
    drawBlocks();
    updateRectVisual();
  }

  // ---------- 边缘自动滚动 ----------
  function autoScrollTick() {
    if (phase !== 'dragging' || !drag) return;
    var y = drag.lastClientY;
    var dy = 0;
    if (y < EDGE_BAND) dy = -Math.round((1 - y / EDGE_BAND) * SCROLL_MAX);
    else if (y > innerHeight - EDGE_BAND) dy = Math.round((1 - (innerHeight - y) / EDGE_BAND) * SCROLL_MAX);
    if (dy) {
      var before = scrollY;
      window.scrollBy(0, dy);
      if (scrollY !== before) {
        drag.cy = Math.min(drag.cy + (scrollY - before), document.documentElement.scrollHeight);
        canvasTransform();
        updateRectVisual();
        maybeRemap(false);
      }
    }
    scrollRAF = requestAnimationFrame(autoScrollTick);
  }

  // ---------- 模式切换 ----------
  function arm() {
    if (phase === 'armed' || phase === 'dragging') return;
    if (phase === 'card') closeCard();
    phase = 'armed';
    document.documentElement.classList.add('nayan-on');
    if (!pageStyle.parentNode) document.head.appendChild(pageStyle);
    dim.classList.add('show');
    hint.classList.add('show');
    canvasTransform();
    bindCaptureListeners();
  }
  function disarm() {
    if (phase === 'idle') return;
    cancelAnimationFrame(scrollRAF);
    clearListeners();
    document.documentElement.classList.remove('nayan-on');
    dim.classList.remove('show', 'backdrop');
    hint.classList.remove('show');
    rectEl.style.display = 'none';
    blocksEl.textContent = '';
    canvas.style.transform = 'none';
    picked = [];
    drag = null;
    phase = 'idle';
  }
  function toggle() {
    if (phase === 'idle') arm();
    else disarm();
  }

  function bindCaptureListeners() {
    onCapture(window, 'pointerdown', function (e) {
      if (phase !== 'armed') return;
      if (inHost(e)) return; // 气泡自己的点击走它自己的监听
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      drag = {
        sx: Math.max(0, e.clientX + scrollX),
        sy: Math.max(0, e.clientY + scrollY),
        cx: 0, cy: 0,
        lastClientY: e.clientY
      };
      drag.cx = drag.sx;
      drag.cy = drag.sy;
      phase = 'dragging';
      scrollRAF = requestAnimationFrame(autoScrollTick);
      maybeRemap(true);
    });
    onCapture(window, 'pointermove', function (e) {
      if (phase !== 'dragging' || !drag) return;
      e.preventDefault();
      drag.lastClientY = e.clientY;
      drag.cx = Math.max(0, Math.min(e.clientX + scrollX, document.documentElement.scrollWidth));
      drag.cy = Math.max(0, Math.min(e.clientY + scrollY, document.documentElement.scrollHeight));
      canvasTransform();
      maybeRemap(false);
    });
    onCapture(window, 'pointerup', function (e) {
      if (phase !== 'dragging' || !drag) return;
      e.preventDefault();
      e.stopPropagation();
      finalizeDrag();
    });
    onCapture(window, 'keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (phase === 'dragging' || phase === 'armed') {
        e.preventDefault();
        e.stopPropagation();
        disarm();
        showToast('已退出框选');
      }
    });
    onCapture(window, 'scroll', function () {
      if (phase !== 'dragging') return;
      canvasTransform();
      maybeRemap(false);
    }, { passive: true });
  }

  // 卡片阶段的 Esc（框选阶段的 Esc 在 bindCaptureListeners 里）
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || phase !== 'card') return;
    e.preventDefault();
    e.stopPropagation();
    closeCard();
  }, true);

  // ---------- 拖拽结束 → 提取 → 批注卡 ----------
  function finalizeDrag() {
    cancelAnimationFrame(scrollRAF);
    var moved = Math.abs(drag.cx - drag.sx) > 12 && Math.abs(drag.cy - drag.sy) > 10;
    if (!moved) { disarm(); return; }
    // 先算结果再退出框选态——disarm 会清 picked，结果要抢在它之后存回
    var found = pickBlocks({ left: Math.min(drag.sx, drag.cx), top: Math.min(drag.sy, drag.cy),
                             right: Math.max(drag.sx, drag.cx), bottom: Math.max(drag.sy, drag.cy) });
    disarm();
    picked = found;
    if (!picked.length) { showToast('这块区域没有框到文字——试着从正文段落上拖过'); return; }

    // content-visibility 强制展开再提取，保证 innerText 完整（Wispal 同款处理），用完即撤
    var fixed = applyCvFix(picked);
    var parts = [];
    for (var i = 0; i < picked.length; i++) {
      var t = '';
      try { t = picked[i].el.innerText || picked[i].el.textContent || ''; } catch (e) { t = picked[i].el.textContent || ''; }
      t = String(t).trim();
      if (t) parts.push(t);
    }
    removeCvFix(fixed);

    var quote = parts.join('\n\n');
    if (quote.length > QUOTE_CAP) {
      quote = quote.slice(0, QUOTE_CAP) + '\n\n…（已截断，原文过长）';
      warnOnce('quote-cap', '框选内容超过 ' + QUOTE_CAP + ' 字，已截断');
    }
    if (!quote) { showToast('框到的内容没有可提取的文字'); return; }
    openCard(quote);
  }

  function applyCvFix(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i].el;
      while (n && n !== document.body) {
        try {
          if (getComputedStyle(n).contentVisibility === 'auto') {
            n.classList.add('nayan-cv-fix');
            if (out.indexOf(n) === -1) out.push(n);
          }
        } catch (e) {}
        n = n.parentElement;
      }
    }
    return out;
  }
  function removeCvFix(set) {
    for (var i = 0; i < set.length; i++) set[i].classList.remove('nayan-cv-fix');
  }

  // ---------- 批注卡 ----------
  function titleFromQuote(quote) {
    var line = norm(quote.split('\n')[0] || '');
    line = line.replace(/^[-*#>\s\d.、）)]+/, '');
    if (line.length > 60) line = line.slice(0, 57) + '…';
    return line || norm(document.title).slice(0, 60) || '网页框选';
  }

  function openCard(quote) {
    phase = 'card';
    dim.classList.add('show', 'backdrop');
    card.innerHTML = ''
      + '<div class="chead"><span class="cdot"></span><b>纳言捕捉</b>'
      + '<span class="cmeta">已框选 ' + picked.length + ' 块 · ' + escHtml(location.hostname) + '</span>'
      + '<button class="cx" title="取消 (Esc)">✕</button></div>'
      + '<textarea class="cq" placeholder="框选到的原文（可编辑）…"></textarea>'
      + '<textarea class="cn" placeholder="我的想法：为什么框它？（可留空）"></textarea>'
      + '<div class="crow">'
      +   '<select class="cproj"><option value="">不归类</option></select>'
      +   '<button class="cnew">＋ 新项目</button>'
      +   '<div class="cnewin"><input class="cnewinp" placeholder="项目名，如：记录软件">'
      +   '<button class="cnewok cbtn">确定</button></div>'
      + '</div>'
      + '<div class="cfoot"><span class="cerr"></span><button class="cbtn ccancel">取消</button>'
      + '<button class="cbtn primary csave">存入收件箱</button></div>';

    var cq = card.querySelector('.cq');
    var cn = card.querySelector('.cn');
    var cproj = card.querySelector('.cproj');
    var crow = card.querySelector('.crow');
    var cerr = card.querySelector('.cerr');
    var csave = card.querySelector('.csave');
    cq.value = quote;
    autoGrow(cq);
    autoGrow(cn);
    cq.addEventListener('input', function () { autoGrow(cq); });
    cn.addEventListener('input', function () { autoGrow(cn); });

    loadProjects(cproj);

    card.querySelector('.cnew').addEventListener('click', function () {
      crow.classList.add('editing');
      card.querySelector('.cnewinp').focus();
    });
    function commitNewProject() {
      var v = norm(card.querySelector('.cnewinp').value);
      if (v) {
        var opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        opt.selected = true;
        cproj.appendChild(opt);
      }
      crow.classList.remove('editing');
    }
    card.querySelector('.cnewok').addEventListener('click', commitNewProject);
    card.querySelector('.cnewinp').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitNewProject(); }
    });

    card.querySelector('.cx').addEventListener('click', closeCard);
    card.querySelector('.ccancel').addEventListener('click', closeCard);
    dim.onclick = function () { if (phase === 'card') closeCard(); };

    csave.addEventListener('click', function () {
      var q = cq.value.trim();
      if (!q) { cerr.textContent = '原文是空的'; return; }
      csave.disabled = true;
      csave.textContent = '存入中…';
      sendMsg({ type: 'nayan:save', payload: {
        title: titleFromQuote(q).slice(0, 120),
        quote: q,
        my_note: cn.value.trim(),
        source_tool: 'webbox',
        workspace: cproj.value || '',
        session_ref: (document.title || '') + ' | ' + location.href,
        tags: ''
      } }).then(function (res) {
        if (res && res.ok) showDone(res.id);
        else {
          csave.disabled = false;
          csave.textContent = '存入收件箱';
          cerr.textContent = (res && res.error) || '保存失败，请重试';
        }
      });
    });

    // 同步显示 + 强制 reflow，保证入场过渡能播出来（rAF 在后台标签页会被暂停，不可依赖）
    void card.offsetWidth;
    card.classList.add('show');
    try { cn.focus(); } catch (e) {}
  }

  function showDone(id) {
    card.innerHTML = ''
      + '<div class="cdone">'
      + '<div class="ok">✓ 已入箱 <em>#' + id + '</em></div>'
      + '<div class="sub">来源已记录，稍后可在卡片里「在来源中查看」跳回本页</div>'
      + '<div class="row">'
      + '<a href="http://localhost:8787" target="_blank" rel="noreferrer">打开收件箱 ↗</a>'
      + '<button class="cbtn again">继续框选</button>'
      + '<button class="cbtn primary cclose">完成</button>'
      + '</div></div>';
    card.querySelector('.again').addEventListener('click', function () { closeCard(); arm(); });
    card.querySelector('.cclose').addEventListener('click', closeCard);
  }

  function closeCard() {
    card.classList.remove('show');
    dim.classList.remove('show', 'backdrop');
    dim.onclick = null;
    phase = 'idle';
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
  }

  function loadProjects(sel) {
    sendMsg({ type: 'nayan:projects' }).then(function (res) {
      if (!res || !res.ok || !Array.isArray(res.list)) return;
      var cur = sel.value;
      res.list.forEach(function (p) {
        var name = p && p.name;
        if (!name) return;
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name + '（' + p.count + '）';
        sel.appendChild(opt);
      });
      if (cur) sel.value = cur;
    });
  }

  // ---------- 浮动气泡 ----------
  var bubblePos = { xr: 0.985, yr: 0.62 };
  storeGet('nayan:bubble').then(function (v) {
    if (v && typeof v.xr === 'number' && typeof v.yr === 'number') bubblePos = v;
    placeBubble();
    bubble.style.display = 'grid';
  });

  function placeBubble() {
    var w = 46, h = 46;
    var x = Math.min(Math.max(bubblePos.xr, 0), 1) * (innerWidth - w);
    var y = Math.min(Math.max(bubblePos.yr, 0), 1) * (innerHeight - h);
    bubble.style.left = x + 'px';
    bubble.style.top = y + 'px';
  }
  window.addEventListener('resize', placeBubble);

  (function bindBubble() {
    bubble.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var moved = false, startX = e.clientX, startY = e.clientY;
      try { bubble.setPointerCapture(e.pointerId); } catch (err) {}
      function mv(ev) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 5) moved = true;
        if (!moved) return;
        bubblePos.xr = Math.min(Math.max((ev.clientX - 23) / (innerWidth - 46), 0), 1);
        bubblePos.yr = Math.min(Math.max((ev.clientY - 23) / (innerHeight - 46), 0), 1);
        placeBubble();
      }
      function up() {
        bubble.removeEventListener('pointermove', mv);
        bubble.removeEventListener('pointerup', up);
        bubble.removeEventListener('pointercancel', up);
        if (moved) storeSet('nayan:bubble', bubblePos);
        else toggle();
      }
      bubble.addEventListener('pointermove', mv);
      bubble.addEventListener('pointerup', up);
      bubble.addEventListener('pointercancel', up);
    });
  })();

  // ---------- 外部唤起与装配 ----------
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'nayan:arm') { try { arm(); } catch (e) {} }
    });
  } catch (e) {}

  document.documentElement.appendChild(host);
  warnOnce('boot', '纳言捕捉内容脚本已就绪');

  window.__NAYAN_CAPTURE__ = {
    arm: arm, toggle: toggle, disarm: disarm,
    get phase() { return phase; }
  };
})();
