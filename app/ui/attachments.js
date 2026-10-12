/* ---------- 附件（引用不拷贝：点开即用，文件挪走显灰态） ----------
 * P0-B01 恢复的三个 helper（77290a6 抽取 rich-text.js 时被误删）：
 *   attBlock(it)   详情页附件区骨架（entryHTML 内联调用，必须先于主脚本加载点存在）
 *   renderAtts(it) 拉取并渲染当前 item 的附件引用（renderDetail 尾部调用）
 *   addAtts(it, paths) 经真实 attachment API 逐个登记引用（attadd 按钮 / 拖放事件调用）
 * 与旧版相比的两处必要修正（P0-T02 合同）：
 *   1. 异步代次守卫：回调只认「最新一次请求 + 仍是同一 item」，A 的迟到响应（含 A→B→A）
 *      不得污染 B 或覆盖新 A 的结果。
 *   2. 附件失败局部可见可重试：正文渲染不依赖本模块任何请求；失败态有重试按钮，
 *      不得把失败伪装成「没有附件」。
 * 依赖（调用期而非加载期）：主脚本的 gid/esc/escQ/api/toast/state/TAPI。
 */
(function () {
  'use strict';
  /* 全局请求代次：每次 renderAtts 自增，回调只接受最新代次，跨 item 天然隔离 */
  var reqGen = 0;

  /* 追踪接缝（测试 opt-in）：测试实例注入 window.__NAYAN_TRACE__ = [] 后，
   * 每次 helper 调用/回调都记录 selected ID、所属 item、请求代次、API method/path、
   * DOM attachment ID 与 suggestion 关联——供 OI-1 类跨条目异常的闭环定位。
   * 生产不注入即零开销，不影响行为。 */
  function trace(ev, it, d) {
    if (!window.__NAYAN_TRACE__) return;
    try {
      window.__NAYAN_TRACE__.push(Object.assign({
        t: Date.now(), ev: ev,
        sel: (typeof state !== 'undefined' && state) ? state.sel : null,
        item: it ? it.id : null,
        gen: reqGen,
      }, d || {}));
    } catch (e) { /* 追踪绝不影响产品行为 */ }
  }

  /* 失败归属：错误必须可见且明确归属到发起操作的条目；reader 已切走时不得
   * 伪装成当前条目的失败，也不得因为切换而丢失真实写入失败。 */
  function attErr(it, msg) {
    var label = it && it.title ? String(it.title) : ('#' + (it ? it.id : '?'));
    if (label.length > 18) label = label.slice(0, 18) + '…';
    toast('✗（' + label + '）' + msg);
  }

  function attExt(name) { var m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/); return m ? m[1] : ''; }
  function extClass(e) {
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'tiff', 'icns'].indexOf(e) >= 0) return 'img';
    if (e === 'pdf') return 'pdf';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'dmg', 'pkg'].indexOf(e) >= 0) return 'zip';
    if (['js', 'ts', 'tsx', 'jsx', 'mjs', 'rs', 'py', 'swift', 'html', 'css', 'json', 'sh', 'md', 'toml', 'yml', 'yaml', 'sql'].indexOf(e) >= 0) return 'code';
    return 'doc';
  }
  function shortenPath(p) {
    var parts = String(p || '').split('/');
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : String(p || '');
  }

  /* 详情页附件区骨架。容器留空由 renderAtts 填充——正文（quote/steps/notes）与本区互不依赖 */
  function attBlock() {
    return '<div class="dblock"><div class="dlabel">📎 附件 · 产出文件' +
      '<span class="grow" style="float:right;font-weight:400">点文件打开 · 空格快速预览 · 可从访达拖进来</span></div>' +
      '<div id="attList" class="attlist"></div>' +
      '<div class="attadd"><button class="dbtn" data-act="attadd">＋ 添加文件</button></div></div>';
  }

  function stillCurrent(gen, it) {
    return gen === reqGen && state.pane.mode === 'entry' && state.sel === it.id;
  }

  function renderAtts(it) {
    var box = gid('attList');
    if (!box || state.pane.mode !== 'entry' || state.sel !== it.id) return;
    var gen = ++reqGen;
    Array.prototype.forEach.call(document.querySelectorAll('.screen-original'),function(e){e.remove();});
    trace('list.start', it, { api: 'GET /api/suggestions/' + it.id + '/attachments' });
    /* 先清旧值：A 的附件数据绝不能因为 B 加载失败而残留 */
    state.atts = []; state.attHover = 0;
    /* reader 身份标记：当前附件容器归属的 item（测试/排查用，供 DOM↔item 对账） */
    box.setAttribute('data-item', String(it.id));
    box.innerHTML = '<div class="attempty">附件加载中…</div>';
    api('GET', '/api/suggestions/' + it.id + '/attachments').then(function (rows) {
      if (!stillCurrent(gen, it) || !gid('attList')) { trace('list.stale-drop', it, { gen: gen }); return; }
      state.atts = rows || [];
      trace('list.ok', it, { gen: gen, rows: state.atts.map(function (a) { return { attId: a.id, name: a.name }; }) });
      if (!state.atts.length) {
        box.innerHTML = '<div class="attempty">还没有附件——AI 对话产出的文件挂上来，项目做下一阶段时不用翻聊天记录，直接从纳言打开。文件只记路径引用，不会被拷进纳言。</div>';
        return;
      }
      var original = state.atts.filter(function(a){return a.screen_capture===true;})[0];
      if(original){
        var region=document.createElement('div'); region.className='screen-original';
        region.style.cssText='margin:16px 0;padding:12px;border:1px solid var(--line);border-radius:12px';
        region.textContent='选区原图 · 识别文字可能有误';
        /* 原图默认缩略（只作核对错字用，不抢正文位置）；点图或按钮展开到整宽 */
        var THUMB='display:block;max-width:100%;max-height:160px;width:auto;height:auto;margin-top:10px;border-radius:8px;cursor:zoom-in';
        var FULL='display:block;width:100%;height:auto;margin-top:10px;border-radius:8px;cursor:zoom-out';
        var img=document.createElement('img');img.alt='选区原图';img.style.cssText=THUMB;region.appendChild(img);
        region.style.overflow='auto';
        var zoom=document.createElement('button');zoom.className='dbtn';zoom.textContent='查看大图';
        var toggle=function(){var big=img.style.cursor==='zoom-out';img.style.cssText=big?THUMB:FULL;zoom.textContent=big?'查看大图':'收起';};
        zoom.onclick=toggle;img.onclick=toggle;region.insertBefore(zoom,img);
        /* R7：原图记录只保留一个复制入口；识别文字的原文与展示值相同，两个同名按钮只会让人困惑 */
        var cpResp=document.getElementById('cpresp');if(cpResp&&cpResp.querySelector('.l1'))cpResp.querySelector('.l1').textContent='⧉ 复制识别文字';
        var cpOrig=document.getElementById('cporig');if(cpOrig)cpOrig.style.display='none';
        var empty=document.getElementById('noquote');if(empty)empty.textContent='未识别到文字，选区原图已保留。';
        var quote=document.getElementById('aiquote');
        if(quote)quote.parentElement.insertBefore(region,quote);else box.parentElement.insertBefore(region,box);
        api('GET','/api/suggestions/'+it.id+'/capture-images/'+original.id).then(function(image){
          if(!stillCurrent(gen,it)||!region.isConnected)return;
          if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl||''))throw new Error('原图响应格式错误');
          img.src=image.dataUrl;
        }).catch(function(e){if(stillCurrent(gen,it)&&region.isConnected)region.textContent='原图读取失败：'+(e.message||e);});
      }
      /* 文件名/路径全部经 esc/escQ 按文本呈现，含引号、尖括号、Unicode 也不构成可执行 HTML */
      box.innerHTML = state.atts.map(function (a) {
        var e = attExt(a.name);
        return '<div class="att' + (a.exists ? '' : ' miss') + '" data-att="' + a.id + '" data-path="' + escQ(a.path) + '">' +
          '<span class="aext ' + extClass(e) + '">' + esc(e || 'file') + '</span>' +
          '<span class="aname" title="' + escQ(a.path) + '">' + esc(a.name) + '</span>' +
          '<span class="apath" title="' + escQ(a.path) + '">' + esc(shortenPath(a.path)) + '</span>' +
          (a.exists ? '<button class="abtn" data-act="attlook" title="快速预览（或悬停后按空格）">👁</button>' : '') +
          '<button class="abtn" data-act="attrev" title="在访达中显示">⌕</button>' +
          '<button class="abtn adgr" data-act="attdel" title="移除这条附件引用（不动原文件）">✕</button>' +
          '</div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.att'), function (row) {
        var id = Number(row.getAttribute('data-att'));
        row.onmouseenter = function () { state.attHover = id; };
        row.onmouseleave = function () { if (state.attHover === id) state.attHover = 0; };
        row.onclick = function (ev) {
          if (ev.target.closest && ev.target.closest('.abtn')) return;
          var path = row.getAttribute('data-path');
          if (row.classList.contains('miss')) { toast('文件不存在（被移走或删掉了）——点 ⌕ 试试在访达里找回来'); return; }
          if (!TAPI) { toast('仅桌面 App 支持打开文件'); return; }
          TAPI.invoke('open_path', { path: path }).catch(function (e) { toast('✗ ' + (e.message || e)); });
        };
        /* 行内小按钮在这里绑（bindEntry 跑的时候附件列表还是空的，绑不到这些后来才渲染的按钮） */
        Array.prototype.forEach.call(row.querySelectorAll('.abtn'), function (b) {
          b.onclick = function (ev) {
            ev.stopPropagation();
            var act = b.getAttribute('data-act');
            var path = row.getAttribute('data-path');
            if (act === 'attdel') {
              /* 只删除引用记录（DELETE /api/attachments/:id），绝不触碰原文件。
               * 归属双保险（OI-1 防护）：
               * ① 客户端守卫：被点行必须属于当前 reader 渲染出的附件集合（state.atts），
               *    DOM 里错放的行（历史 OI-1 形态）在发请求前即拒绝；
               * ② 后端原子校验：DELETE 携带 expected_suggestion_id，服务端在一条条件
               *    DELETE 中核对附件确实属于该条目，不符零行删除。
               * 迟到错误归属：DELETE 失败若发生在 reader 已切走之后，错误仍要可见，
               * 但明确归属到发起删除的条目（attErr），不得伪装成当前条目的失败。 */
              /* 当前 reader 上下文五重校验（R3-F01）：发请求前必须全部成立——
               * ① pane 仍是条目 reader；② 当前选择 == 捕获 item；③ 请求代次仍最新；
               * ④ 附件容器归属（attList[data-item]）== 捕获 item 且该行真实连在其内；
               * ⑤ 附件 id 属于当前条目的权威集合 state.atts。
               * 旧行+旧 state.atts 整体注入（捕获 item/id 彼此一致、但与用户当前选择不符）
               * 会被 ②④ 拦下；A→B→A 的旧代次行会被 ③ 拦下。拒绝发生在请求发出之前。 */
              var ctxBad = null;
              if (!stillCurrent(gen, it)) {
                ctxBad = '当前选择/请求代次已不属于发起操作的条目';
              } else {
                var cont = document.getElementById('attList');
                if (!cont || cont.getAttribute('data-item') !== String(it.id)) {
                  ctxBad = '附件容器归属不符';
                } else if (!row.isConnected || row.closest('#attList') !== cont) {
                  ctxBad = '附件行不在当前容器内';
                } else if (!(state.atts || []).some(function (a) { return a.id === id; })) {
                  ctxBad = '附件行不属于当前条目的附件集合';
                }
              }
              if (ctxBad) {
                trace('del.ctx-reject', it, { attId: id, expectedSid: it.id, gen: gen, reason: ctxBad });
                attErr(it, '已拒绝删除：' + ctxBad + '（未发出请求）');
                return;
              }
              row.style.opacity = '.3';
              trace('del.click', it, { attId: id, expectedSid: it.id, api: 'DELETE /api/attachments/' + id });
              api('DELETE', '/api/attachments/' + id, { expected_suggestion_id: it.id })
                .then(function (r) {
                  trace('del.ok', it, { attId: id, expectedSid: it.id, resp: r || null });
                  if (stillCurrent(gen, it)) renderAtts(it);
                })
                .catch(function (e) {
                  var current = stillCurrent(gen, it);
                  trace('del.err', it, { attId: id, expectedSid: it.id, current: current, msg: String(e.message || e) });
                  if (current) {
                    row.style.opacity = '';
                    toast(e.message);
                  } else {
                    attErr(it, '移除附件失败：' + (e.message || e));
                  }
                });
              return;
            }
            if (!TAPI) { toast('仅桌面 App 支持'); return; }
            if (act === 'attrev') { TAPI.invoke('reveal_path', { path: path }).catch(function (e) { toast('✗ ' + (e.message || e)); }); }
            else if (act === 'attlook') { TAPI.invoke('quick_look', { path: path }).catch(function (e) { toast('✗ ' + (e.message || e)); }); }
          };
        });
      });
    }).catch(function (e) {
      if (!stillCurrent(gen, it) || !gid('attList')) { trace('list.stale-drop-err', it, { gen: gen }); return; }
      trace('list.err', it, { gen: gen, msg: String(e.message || e) });
      /* 失败必须可见且可重试；正文不受影响（entryHTML 渲染在 renderAtts 之前已完成） */
      box.innerHTML = '<div class="attempty">附件读取失败：' + esc(e.message || e) +
        ' <button class="abtn" type="button" title="重新加载附件">↻ 重试</button></div>';
      var rb = box.querySelector('.attempty .abtn');
      if (rb) rb.onclick = function () { renderAtts(it); };
    });
  }

  function addAtts(it, paths) {
    var chain = Promise.resolve();
    var firstFail = '';
    trace('add.start', it, { paths: (paths || []).slice() });
    (paths || []).forEach(function (p) {
      chain = chain.then(function () {
        return api('POST', '/api/suggestions/' + it.id + '/attachments', { path: p })
          .then(function (r) { trace('add.ok', it, { path: p, attId: r && r.id }); })
          .catch(function (e) {
            if (!firstFail) firstFail = e.message || String(e);
            trace('add.err', it, { path: p, msg: String(e.message || e) });
          });
      });
    });
    chain.then(function () {
      /* 写入照常完成（真实持久化）；仅当用户仍停在同一条时才重渲染。
       * 失败不得显示成假成功；reader 已切走时错误归属到原条目（不丢失、不误示）。 */
      var stillOn = state.pane.mode === 'entry' && state.sel === it.id;
      if (stillOn) renderAtts(it);
      trace('add.end', it, { firstFail: firstFail, stillOn: stillOn });
      if (firstFail) {
        if (stillOn) toast('✗ ' + firstFail);
        else attErr(it, '添加附件失败：' + firstFail);
      }
    });
  }

  window.attBlock = attBlock;
  window.renderAtts = renderAtts;
  window.addAtts = addAtts;
  /* 读取当前请求代次（测试用）：OI-1 类调查时与 __NAYAN_TRACE__ 记录比对 */
  window.__NAYAN_ATT_REQGEN__ = function () { return reqGen; };
  /* 加载顺序自检标记：主脚本运行前应已为 function（P0-T03 场景第 0 步断言） */
  window.__NAYAN_ATTACHMENTS_READY__ = true;
})();
