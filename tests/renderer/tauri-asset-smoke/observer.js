// observer.js —— asset-smoke 初始化脚本（WebviewWindowBuilder::initialization_script 注入，
// wry 于 document start 执行，先于页面脚本）。__SMOKE_MODE__ 由 Rust 侧替换为 clean|gate-cmd|gate-net。
//
// 【记录器边界（实测事实，如实声明）】
// - window.__TAURI__.core.invoke 不可写（严格模式赋值抛 TypeError；Tauri 对全局 API 面的
//   加固）——JS 侧无法包装原生调用通道。应用命令由 Rust 在 dispatch 前记录；包括 plugin ACL 在内的尝试由真实 fetch
//   传输记录（请求原样转发）。本有限 run 若触发 postMessage 回退则失败，不虚称该路径已测。
// - JS 侧记录器覆盖：网络尝试（fetch/XHR/img-src 属性/setAttribute/MutationObserver 五路，
//   window.fetch 等可写对象实测可包）、CSP 违例、console、页面几何/DOM 状态。
// - 阶段标记与结果回传走 __TAURI_INTERNALS__.invoke（Tauri core 注入早于公开 bundle，
//   实测 document start 即可用）。
(function () {
  'use strict';
  var MODE = '__SMOKE_MODE__';

  function rawInvoke(cmd, args) {
    try {
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
        return window.__TAURI_INTERNALS__.invoke(cmd, args);
      }
    } catch (e) {}
    return null;
  }
  function jlog(msg) { rawInvoke('js_log', { msg: String(msg).slice(0, 160) }); }
  jlog('obs: script-top [internals=' + !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) + ' tauriApi=' + !!window.__TAURI__ + ']');

  window.__PHASE__ = 'pre-init';
  window.__PHASELOG__ = { seq: 0, net: [], ipc: [] };
  window.__VIOLATIONS__ = [];
  window.__CONSOLES__ = [];

  function recNet(entry) {
    entry.phase = window.__PHASE__; entry.seq = ++window.__PHASELOG__.seq;
    if (entry.url && String(entry.url).length > 200) {
      entry.url = String(entry.url).slice(0, 140) + '…[len=' + entry.url.length + '，base64 已截断]';
    }
    window.__PHASELOG__.net.push(entry);
  }
  window.__EXTERNAL_URL__ = function (u) {
    var s = String(u || '');
    return /^https?:\/\//i.test(s) || /^wss?:\/\//i.test(s) || s.indexOf('//') === 0;
  };
  window.markPhase = function (name) {
    window.__PHASE__ = name;
    return rawInvoke('smoke_phase', { name: name });
  };

  // ---- 网络尝试记录器（记录先于移除/网络层；CSP 拦截亦有 attempt 留痕） ----
  try {
    var of = window.fetch ? window.fetch.bind(window) : null;
    if (of) window.fetch = function (input, init) {
      var url = String(input && input.url !== undefined ? input.url : input);
      recNet({ type: 'fetch', url: url });
      // Actual Tauri custom-protocol transport, forwarded unchanged (not an invoke stub).
      // This also observes plugin ACL rejection, which precedes application invoke_handler.
      if (url.indexOf('ipc://localhost/') === 0) {
        var args = null;
        try { args = JSON.parse(init && init.body); } catch (_) {}
        window.__PHASELOG__.ipc.push({seq: ++window.__PHASELOG__.seq, phase: window.__PHASE__,
          cmd: decodeURIComponent(url.slice('ipc://localhost/'.length)), method: args && args.method,
          path: args && args.path, transport:'real-fetch-forwarded'});
      }
      return of(input, init);
    };
  } catch (e) { jlog('obs: fetch-wrap-failed'); }
  try {
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      recNet({ type: 'xhr', method: String(m), url: String(u) });
      return oo.apply(this, arguments);
    };
  } catch (e) { jlog('obs: xhr-wrap-failed'); }
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (d && d.set) Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true, enumerable: d.enumerable,
      get: function () { return d.get.call(this); },
      set: function (v) { recNet({ type: 'img-src', url: String(v) }); return d.set.call(this, v); }
    });
  } catch (e) { jlog('obs: img-wrap-failed'); }
  try {
    var osa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      try {
        var t = String(this.tagName || '').toUpperCase();
        if ((n === 'src' || n === 'href') && (t === 'IMG' || t === 'SCRIPT' || t === 'IFRAME' || t === 'LINK'))
          recNet({ type: 'attr-' + t.toLowerCase() + '-' + n, url: String(v) });
      } catch (e2) {}
      return osa.call(this, n, v);
    };
  } catch (e) { jlog('obs: setattr-wrap-failed'); }
  try {
    function scanRes(n) {
      try {
        var t = String(n.tagName || '').toUpperCase();
        if (t === 'IMG' || t === 'SCRIPT' || t === 'IFRAME') {
          var s = n.getAttribute && n.getAttribute('src');
          if (s) recNet({ type: 'dom-' + t.toLowerCase() + '-src', url: String(s) });
        } else if (t === 'LINK') {
          var h = n.getAttribute && n.getAttribute('href');
          if (h) recNet({ type: 'dom-link-href', url: String(h) });
        }
        if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll('img[src],script[src],iframe[src],link[href]'), scanRes);
      } catch (e) {}
    }
    new MutationObserver(function (muts) {
      muts.forEach(function (mu) {
        Array.prototype.forEach.call(mu.addedNodes, function (n) { if (n && n.nodeType === 1) scanRes(n); });
      });
    }).observe(document, { childList: true, subtree: true });
  } catch (e) { jlog('obs: mo-wrap-failed'); }

  // ---- 违例 / console 捕获 ----
  window.addEventListener('securitypolicyviolation', function (e) {
    window.__VIOLATIONS__.push({ phase: window.__PHASE__, directive: e.violatedDirective, uri: String(e.blockedURI || '').slice(0, 60), sample: String(e.sample || '').slice(0, 80) });
  });
  ['log', 'warn', 'error'].forEach(function (m) {
    var orig = console[m] ? console[m].bind(console) : function () {};
    console[m] = function () {
      try { window.__CONSOLES__.push(m + ': ' + Array.prototype.map.call(arguments, function (a) { return typeof a === 'string' ? a : String(a); }).join(' ').slice(0, 200)); } catch (e) {}
      orig.apply(null, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    try { window.__CONSOLES__.push('pageerror: ' + String(e.message || '').slice(0, 200)); } catch (_) {}
  });

  function info(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var img = el.querySelector('img');
    var r = el.getBoundingClientRect();
    var out = { sel: sel, container: { w: r.width, h: r.height }, hasImg: !!img };
    if (img) {
      var ir = img.getBoundingClientRect(); var cs = getComputedStyle(img);
      out.img = { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete,
        rectW: ir.width, rectH: ir.height, computedW: cs.width, computedH: cs.height };
    }
    return out;
  }
  function settle(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- 驱动：等页面就绪后按阶段执行（正文经真实 IPC 的 GET :id/content 取回） ----
  window.addEventListener('load', function () {
    jlog('obs: load-fired');
    setTimeout(function () { run().catch(function (e) {
      try { rawInvoke('smoke_result', { payload: JSON.stringify({ driverError: String(e)+'\n'+String(e&&e.stack||'') }) }); } catch (_) {}
    }); }, 1800);
  });

  async function run() {
    await markPhase('init');
    await settle(300);
    var page = typeof renderDetail === 'function' && typeof state !== 'undefined';
    var out = { mode: MODE, pageReady: page, url: location.href, protocol: location.protocol };

    // 真实服务期 CSP 证据：fetch 自身 URL 读响应头（connect-src 'self' 放行）
    try {
      var resp = await fetch(location.href);
      out.servedCSPHeader = resp.headers.get('content-security-policy');
    } catch (e) { out.servedCSPHeader = 'fetch-failed:' + String(e).slice(0, 80); }
    // WebKit nonce-hiding：插入后 JS 读 getAttribute('nonce') 得空串（实测）——
    // 取证用 hasAttribute（存在性）；nonce 值的证据在服务期 CSP 头的 'nonce-N'。
    var styleEls = document.querySelectorAll('style');
    out.styleNonceCount = Array.prototype.filter.call(styleEls, function (el) { return el.hasAttribute && el.hasAttribute('nonce'); }).length;
    out.styleTotal = styleEls.length;
    out.styleNonceValuesReadable = Array.prototype.map.call(styleEls, function (el) { return el.getAttribute('nonce'); });
    var inlineProbe = document.createElement('span'); inlineProbe.setAttribute('style', 'display:none');
    document.body.appendChild(inlineProbe);
    out.inlineStyleApplied = getComputedStyle(inlineProbe).display === 'none'; inlineProbe.remove();
    out.vendor = { markdownIt: typeof window.markdownit, DOMPurify: typeof window.DOMPurify };
    out.sourceMapModule = typeof window.NaYanSourceSpans;
    out.ipcTransportBoundary = 'Fetch custom protocol attempts + Rust application ingress; fallback must not occur in this finite run';

    var hostileDetail = null, hostileHtmlDetail = null, sidecar = null, fixtureCheck = null;
    if (page) {
      // ---- body-normal：正常条目 ----
      await markPhase('body-normal');
      state.sel = 1; state.pane = { mode: 'entry' }; renderDetail();
      await settle(500);
      out.brandIcon = info('.brand .logo');
      out.normalEntryTitle = (document.querySelector('#dtitle') || {}).textContent || null;

      // ---- hostile-window：敌意 MD ----
      await markPhase('hostile-window');
      state.sel = 3; state.pane = { mode: 'entry' }; renderDetail();
      await settle(700); // 等真实 IPC GET :id/content + markdown-it/DOMPurify 渲染
      var aib = document.querySelector('.aibody');
      var codeEl = aib ? aib.querySelector('pre code') : null;
      hostileDetail = {
        aibodyPresent: !!aib, richClass: aib ? aib.classList.contains('rich') : false,
        headings: aib ? aib.querySelectorAll('h1').length : 0,
        codeFencePresent: !!codeEl,
        codeFenceText: codeEl ? codeEl.textContent : null,
        scriptTags: aib ? aib.querySelectorAll('script').length : -1,
        onAttrs: aib ? Array.prototype.filter.call(aib.querySelectorAll('*'), function (el) { return el.getAttribute && (el.getAttribute('onerror') || el.getAttribute('onload') || el.getAttribute('onclick')); }).length : -1,
        styleAttrs: aib ? aib.querySelectorAll('[style]').length : -1,
        remoteImgs: aib ? Array.prototype.filter.call(aib.querySelectorAll('img'), function (el) { return /^https?:/.test(el.getAttribute('src') || ''); }).length : -1,
        jsLinks: aib ? Array.prototype.filter.call(aib.querySelectorAll('a'), function (el) { return /^javascript:/i.test(el.getAttribute('href') || ''); }).length : -1
      };
      // S04 链（真实 Tauri 页面）：sidecar 挂载 + 切片 + 身份
      var sc = (typeof readerSidecarOf === 'function') ? readerSidecarOf(aib) : null;
      var blk = sc ? sc.entries().find(function (e) { return e.kind === 'code-block' && e.available; }) : null;
      var pay = sc ? sc.entries().find(function (e) { return e.kind === 'code-payload'; }) : null;
      sidecar = {
        present: !!sc, entryCount: sc ? sc.entries().length : 0,
        identity: sc ? sc.identity() : null,
        blockSlice: (sc && blk) ? sc.slice(blk.id, aib.__nayanDecision, aib.__nayanIdentity).text : null,
        blockExact: !!(sc && blk && sc.slice(blk.id, aib.__nayanDecision, aib.__nayanIdentity).text === '```\ncode 原文 · Unicode ✓\n  缩进保留\tTab\n```'),
        payloadAvail: pay ? pay.available : null,
        payloadSlice: (sc && pay && pay.available) ? sc.slice(pay.id, aib.__nayanDecision, aib.__nayanIdentity).text : null
      };

      // ---- 敌意 HTML ----
      state.sel = 5; state.pane = { mode: 'entry' }; renderDetail();
      await settle(700);
      var aib2 = document.querySelector('.aibody');
      var strongEl = aib2 ? aib2.querySelector('strong') : null;
      hostileHtmlDetail = {
        aibodyPresent: !!aib2, richClass: aib2 ? aib2.classList.contains('rich') : false,
        strongText: strongEl ? strongEl.textContent : null,
        pTags: aib2 ? aib2.querySelectorAll('p').length : -1,
        scriptTags: aib2 ? aib2.querySelectorAll('script').length : -1,
        imgTags: aib2 ? aib2.querySelectorAll('img').length : -1,
        iframeTags: aib2 ? aib2.querySelectorAll('iframe').length : -1,
        onAttrs: aib2 ? Array.prototype.filter.call(aib2.querySelectorAll('*'), function (el) { return el.getAttribute && (el.getAttribute('onerror') || el.getAttribute('onload') || el.getAttribute('onclick')); }).length : -1,
        styleAttrs: aib2 ? aib2.querySelectorAll('[style]').length : -1,
        jsLinks: aib2 ? Array.prototype.filter.call(aib2.querySelectorAll('a'), function (el) { return /^javascript:/i.test(el.getAttribute('href') || ''); }).length : -1,
        safeLinks: aib2 ? Array.prototype.filter.call(aib2.querySelectorAll('a[href]'), function (el) { return /^https?:/.test(el.getAttribute('href') || ''); }).length : -1
      };
      fixtureCheck = {
        mdCanonicalLen: sc ? sc.sourceLength() : -1,
        htmlBodyTextLen: aib2 ? (aib2.textContent || '').length : -1,
        strongExact: strongEl ? strongEl.textContent === '白名单标签保留' : false
      };

      // ---- 注入门（在敌意窗口内、封闭结算前） ----
      // gate-cmd：未授权模拟命令经真实 IPC 发往 Rust（Rust 记录后拒绝——返回 Err）。
      // JS 无法包装 invoke 通道（不可写，实测）；该尝试在 Rust rustLog 的 hostile-window
      // 分桶中留痕（权威），JS 侧记录尝试意图与结果。
      var injected = null;
      if (MODE === 'gate-cmd') {
        try { await window.__TAURI__.core.invoke('smoke_unauthorized_probe', { marker: 'gate-cmd-marker' }); injected = 'unexpectedly-ok'; }
        catch (e) { injected = 'rejected:' + String(e).slice(0, 60); }
      } else if (MODE === 'gate-unknown' || MODE === 'gate-path' || MODE === 'gate-write' || MODE === 'gate-plugin') {
        try {
          var command = MODE === 'gate-unknown' ? 'open_path' : MODE === 'gate-plugin' ? 'plugin:nayan_absent|probe' : 'api';
          var args = MODE === 'gate-unknown' ? {path:'/synthetic/never-open'} : MODE === 'gate-path'
            ? {method:'GET',path:'/api/suggestions/not-an-id/extra/content'} : MODE === 'gate-write'
            ? {method:'PATCH',path:'/api/suggestions/3',body:{title:'never-written'}} : {};
          await window.__TAURI__.core.invoke(command,args); injected='unexpectedly-ok';
        } catch(e) { injected='rejected:'+String(e).slice(0,120); }
      } else if (MODE === 'gate-csp') {
        var badScript=document.createElement('script'); badScript.textContent='window.__NONCONTROL__=1';
        document.head.appendChild(badScript); badScript.remove(); injected='inline-csp-attempt';
      } else if (MODE === 'gate-net') {
        try {
          var im = document.createElement('img');
          im.src = 'https://nayan-smoke.invalid/transient.png';
          document.body.appendChild(im); im.remove();
          fetch('https://nayan-smoke.invalid/exfil').catch(function () {});
          injected = 'transient';
        } catch (e) { injected = 'transient-error:' + String(e); }
      }

      await settle(250); // Drain actual IPC/network/CSP events before sealing; controls are a different run.
      out.hostileIpc=window.__PHASELOG__.ipc.filter(function(e){return e.phase==='hostile-window';});

      // ---- 敌意窗口封闭结算（网络尝试；原生调用权威记录在 Rust 分桶） ----
      var sealedNet = [], sealedExternal = [];
      window.__PHASELOG__.net.forEach(function (e) {
        if (e.phase === 'hostile-window') {
          sealedNet.push(e);
          if (window.__EXTERNAL_URL__(e.url)) sealedExternal.push(e);
        }
      });
      out.hostileSealed = { net: sealedNet, external: sealedExternal,
        nativeNote: '实际 fetch IPC 尝试（含 plugin ACL）+ Rust 应用命令 dispatch 前入口；二者独立对账，未替换 invoke' };
      out.hostileInjected = injected;
      out.hostileDetail = hostileDetail;
      out.hostileHtmlDetail = hostileHtmlDetail;
      out.sidecar = sidecar;
      out.fixtureCheck = fixtureCheck;

      // ---- user-click：树交互 ----
      await markPhase('user-click');
      var tree = {};
      try {
        tree.segButtons = document.querySelectorAll('#sbMode button').length;
        var projBtn = document.querySelectorAll('#sbMode button[data-m="proj"]')[0];
        if (projBtn) projBtn.click();
        tree.projModeActive = state.sbMode === 'proj';
        var chev = document.querySelector('.pchev[data-tglk]');
        if (chev) chev.click();
        tree.foldToggled = !!(state.treeOpen && Object.keys(state.treeOpen).some(function (k) { return state.treeOpen[k] === false; }));
        var toolBtn = document.querySelectorAll('#sbMode button[data-m="tool"]')[0];
        if (toolBtn) toolBtn.click();
        var toolRow = document.querySelector('.nav-item.tool[data-tool="probe-tool-a"]');
        if (toolRow) toolRow.click();
        tree.selectSetsView = !!(state.view && state.view.t === 'tool' && state.view.tool === 'probe-tool-a');
      } catch (e) { tree.error = String(e); }
      out.tree = tree;

      // ---- observer-controls：正向控制（证明网络记录器在工作） ----
      await markPhase('observer-controls');
      out.sentinel = {};
      if (MODE === 'observer-controls') try {
        window.__PWNED__ = false;
        var s = document.createElement('script'); s.textContent = 'window.__PWNED__=1';
        document.head.appendChild(s); s.remove();
        out.sentinel.inlineScriptBlocked = window.__PWNED__ === false;
        var ri = document.createElement('img'); ri.src = 'https://nayan-sentinel.invalid/img-probe.png';
        document.body.appendChild(ri);
        try { fetch('https://nayan-sentinel.invalid/fetch-probe').catch(function () {}); } catch (e3) {}
        out.sentinel.netControlsPlanted = true;
      } catch (e) { out.sentinel.error = String(e); }

      // ---- teardown：恢复详情视图 ----
      await markPhase('teardown');
      state.view = { t: 'all' }; state.q = ''; state.sel = 1; state.pane = { mode: 'entry' };
      if (typeof renderAll === 'function') renderAll(true);
      await settle(500);
    }

    out.pwnedScript = !!window.__PWNED__; out.pwnedImg = !!window.__PWNED_IMG__; out.pwnedHtml = !!window.__PWNED_HTML__;
    out.violations = window.__VIOLATIONS__;
    out.consoles = window.__CONSOLES__.slice(0, 40);
    out.phaseNet = window.__PHASELOG__.net;
    out.ipcAttempts = window.__PHASELOG__.ipc;
    out.phaseNetExternal = window.__PHASELOG__.net.filter(function (e) { return window.__EXTERNAL_URL__(e.url); });
    out.navItems = document.querySelectorAll('.nav-item').length;
    out.screenshotNote = 'tauri 2.11.5 无公开 screenshot/capture API——Step5 截图 NV（如实声明）';

    rawInvoke('smoke_result', { payload: JSON.stringify(out) });
    jlog('obs: smoke-result-sent');
  }
})();
