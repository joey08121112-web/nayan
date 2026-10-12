/* 纳言 · reader 共享模块（详情页 AI 原文 / 收录窗预览共用）
   P1-T05 plain/legacy 阅读保真：显示文本只经文本节点（textContent）+ 保空白 CSS，
   换行按 canonical 口径规范化（CRLF/CR→LF，其余一切逐字符原样）。
   plain/legacy 不做任何「猜标题/猜列表/拆中点」的结构性重排——破坏性启发式已退场。
   P1-T06：声明 Markdown / 声明 HTML 的受限结构化渲染——markdown-it（锁定 15.0.2，
   html:false，内嵌 HTML 一律转义为字面文本）+ DOMPurify（锁定 3.4.16，正向白名单），
   两库本地打包于 vendor/、运行期零网络。原文与显示彻底分离：存储原表示从不回写；
   任何一环缺失/失败/被停用都回退 plain 源文本显示并给出原因，绝不假装渲染成功。
   P1-B06-PERF-01：详情正文增加最小、有界、可取消的异步渲染入口
   （renderReaderBodyAsync，顶层结构元素分批挂载）；同步入口与预览端行为不变。 */

/* HTML 转义（index.html 构建 HTML 字符串沿用；不用于 reader 正文填充） */
function esc(s){ var d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }

/* 与 Rust content.rs canonicalize_text 同口径的唯一显示规范化：
   CRLF→LF、孤立 CR→LF；空格/tab/空行/字符逐字符原样。纯函数、幂等。 */
function canonicalNewlines(s){
  return String(s==null?'':s).replace(/\r\n?/g,'\n');
}

/* ---------- P1-T06/S03：rich 白名单（正向 allowlist） ----------
   标签：结构 + 行内文本级。图片/媒体/表单/嵌入/样式/脚本一律不允许
   （DOMPurify 剥壳留文本 = 可读安全回退，不静默丢内容）。
   属性：仅 href / ol start / 表格跨度，以及 code/pre 的单一 language-* 元数据。
   其它 class/id/style/data-* 全部不允许——
   内容不得触碰页面外观与 DOM 身份。 */
var RICH_ALLOWED_TAGS=['p','br','hr','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','li',
  'pre','code','em','strong','del','s','a','span','b','i','u','sup','sub',
  'table','thead','tbody','tfoot','tr','th','td','caption'];
var RICH_ALLOWED_ATTR=['href','start','colspan','rowspan'];
/* S05 外链窄域：唯一放行形态 = 绝对 http(s) URL、无空白与控制字符。
   javascript:/data:/file:/相对路径/协议相对一律不匹配（清洗与点击共用同一判据）。 */
var RICH_SAFE_HREF=/^https?:\/\/[^\s\x00-\x1f]+$/i;

/* 运行时可用性与回退开关（测试接缝；localStorage 不可用时视为未停用） */
function richDisabled(){
  try{ return localStorage.getItem('nayan-rich-disable')==='1'; }catch(e){ return false; }
}
function richRuntime(){
  var md=typeof markdownit==='function';
  var dp=typeof DOMPurify==='function'&&DOMPurify.isSupported===true;
  return { markdownit:md, dompurify:dp, disabled:richDisabled(),
    markdownitVersion:md&&markdownit.version?String(markdownit.version):null,
    dompurifyVersion:(typeof DOMPurify==='function'&&DOMPurify.version)?String(DOMPurify.version):null };
}

/* S02+S03：唯一清洗入口。DOMPurify 不可用 → 返回 null，调用方必须回退 plain。
   markdown 产物（html:false，理论上只含 markdown-it 自产标签）也整体过这一层——
   纵深防御，不信任单一防线的正确性。
   注：DOMPurify 会对一切白名单属性的「值」跑 URI 正则（不止 href），窄域正则会
   误伤 start/colspan 等纯数值排版属性——经 ADD_URI_SAFE_ATTR 豁免（无 URL 语义）。 */
function sanitizeRichHtml(html,returnFragment){
  if(typeof DOMPurify!=='function'||DOMPurify.isSupported!==true) return null;
  function languageOnly(node,data){
    if(data.attrName==='class' && /^(?:CODE|PRE)$/.test(node.nodeName) &&
        /^language-[a-zA-Z0-9+#._-]{1,64}$/.test(data.attrValue)) data.forceKeepAttr=true;
  }
  DOMPurify.addHook('uponSanitizeAttribute',languageOnly);
  try{ return DOMPurify.sanitize(html,{
    /* The async caller consumes children only; the sanitizer-owned BODY is never mounted.
       Returning it avoids an intermediate fragment extraction/reparenting pass. */
    RETURN_DOM:!!returnFragment,
    ALLOWED_TAGS:RICH_ALLOWED_TAGS,
    ALLOWED_ATTR:RICH_ALLOWED_ATTR,
    ALLOW_DATA_ATTR:false,
    ALLOWED_URI_REGEXP:RICH_SAFE_HREF,
    ADD_URI_SAFE_ATTR:['start','colspan','rowspan'],
    KEEP_CONTENT:true,
    FORBID_TAGS:['style','script','noscript','iframe','frame','frameset','object','embed','svg','math',
      'img','picture','video','audio','source','track','form','input','button','textarea',
      'select','option','link','meta','base','area','map','template','slot','title','head','body','html'],
    FORBID_ATTR:['style','src','srcset','xlink:href','formaction','background','poster','ping','usemap']
  }); }finally{ DOMPurify.removeHook('uponSanitizeAttribute',languageOnly); }
}

/* S02：markdown → HTML。html:false = 内嵌 HTML 转义为字面文本（绝不透传）；
   breaks:false = 硬换行仍是换行（源保真优先）；linkify/typographer 关闭（不猜不改写）。 */
var MD_INSTANCE=null;
function markdownToHtml(src){
  if(typeof markdownit!=='function') return null;
  if(!MD_INSTANCE) MD_INSTANCE=markdownit({html:false,breaks:false,linkify:false,typographer:false});
  try{ return MD_INSTANCE.render(canonicalNewlines(src)); }
  catch(e){ return null; }
}

/* S05：外链窄域校验（唯一放行判据见 RICH_SAFE_HREF）。 */
function safeExternalHref(u){
  if(typeof u!=='string') return null;
  var t=u.trim();
  return RICH_SAFE_HREF.test(t)?t:null;
}

/* S05：rich 容器链接统一出口——preventDefault 一律先行（容器内永不自行导航）；
   校验通过才交给 opener；opener 为空（收录窗预览/浏览器上下文）时链接保持惰性。 */
function wireRichLinks(el,opener){
  if(!el||el.__nayanRichLinks) return;
  el.__nayanRichLinks=true;
  el.addEventListener('click',function(ev){
    var a=(ev.target&&ev.target.closest)?ev.target.closest('a'):null;
    if(!a||!el.contains(a)) return;
    ev.preventDefault();
    var u=safeExternalHref(a.getAttribute('href')||'');
    if(u&&typeof opener==='function'){
      try{ opener(u); }catch(e){ /* opener 自身异常不外溢到内容 */ }
    }
  });
}

/* ---------- S04：rich DOM 的确定性纯文本投影 ----------
   稳定契约（P1-T07 HTML Copy Response 的数据源；勿随手改，改动需同步测试黄金值）：
   - p/h1..h6：行内文本（折叠空白）成段，段间空行
   - ul：每项 "- " 前缀；ol：按 start 属性计数 "N. " 前缀；嵌套列表每层缩进两空格
   - pre：textContent 原样（空白/换行一字不动）
   - hr：'---'
   - br：'\n'；其余行内标签只取文本
   - blockquote：内部投影后每行加 '> ' 前缀
   - table：每行 '| a | b |'，单元格折叠空白
   同一源渲染两次的 DOM 投影逐字符相同（测试断言）。 */
function _richInlineText(node){
  var out=[];
  (function walk(n){
    for(var i=0;i<n.childNodes.length;i++){
      var c=n.childNodes[i];
      if(c.nodeType===3) out.push(c.nodeValue);
      else if(c.nodeType===1){
        if(c.tagName.toLowerCase()==='br') out.push('\n');
        else walk(c);
      }
    }
  })(node);
  return out.join('');
}
function _richCollapse(s){ return String(s).replace(/[ \t\n\r\f\v]+/g,' ').trim(); }
/* 列表投影：ul → "- "；ol → 按 start 计数 "N. "；嵌套列表每层缩进两空格 */
function _projList(listEl,ind){
  var tag=listEl.tagName.toLowerCase();
  var start=parseInt(listEl.getAttribute('start')||'1',10);
  if(!(start>=0)) start=1;
  var idx=0, lines=[];
  for(var j=0;j<listEl.childNodes.length;j++){
    var li=listEl.childNodes[j];
    if(li.nodeType!==1||li.tagName.toLowerCase()!=='li') continue;
    idx++;
    var parts=[];
    for(var k=0;k<li.childNodes.length;k++){
      var c=li.childNodes[k];
      if(c.nodeType===3) parts.push(c.nodeValue);
      else if(c.nodeType===1){
        var ct=c.tagName.toLowerCase();
        if(ct==='ul'||ct==='ol') continue;          /* 嵌套列表走下面递归 */
        if(ct==='br'){ parts.push('\n'); continue; }
        parts.push(_richInlineText(c));
      }
    }
    var marker=tag==='ol'?(start+idx-1)+'. ':'- ';
    var line=ind+marker+_richCollapse(parts.join(''));
    if(line) lines.push(line);
    for(var k2=0;k2<li.childNodes.length;k2++){
      var c2=li.childNodes[k2];
      if(c2.nodeType===1){
        var ct2=c2.tagName.toLowerCase();
        if(ct2==='ul'||ct2==='ol') lines=lines.concat(_projList(c2,ind+'  '));
      }
    }
  }
  return lines;
}
function _projBlocks(el,ind){
  var blocks=[];
  function para(t){ var s=_richCollapse(t); if(s) blocks.push(ind+s); }
  for(var i=0;i<el.childNodes.length;i++){
    var n=el.childNodes[i];
    if(n.nodeType===3){ para(n.nodeValue); continue; }
    if(n.nodeType!==1) continue;
    /* UX-AI-CAPTURE-FIDELITY-01：代码块 chrome（语言标签/复制按钮）不进入投影/复制载荷 */
    if(n.getAttribute&&n.getAttribute('data-nayan-chrome')) continue;
    var tag=n.tagName.toLowerCase();
    if(/^h[1-6]$/.test(tag)||tag==='p'){ para(_richInlineText(n)); }
    else if(tag==='ul'||tag==='ol'){
      var lines=_projList(n,ind);
      if(lines.length) blocks.push(lines.join('\n'));
    }
    else if(tag==='pre'){ blocks.push(ind+n.textContent); }
    else if(tag==='hr'){ blocks.push(ind+'---'); }
    else if(tag==='blockquote'){
      var inner=_projBlocks(n,'').join('\n\n');
      if(inner) blocks.push(inner.split('\n').map(function(l){ return l?ind+'> '+l:''; }).join('\n'));
    }
    else if(tag==='table'||tag==='thead'||tag==='tbody'||tag==='tfoot'||tag==='tr'){
      var trs=tag==='tr'?[n]:n.querySelectorAll('tr');
      var rows=[];
      for(var r=0;r<trs.length;r++){
        var cells=[];
        for(var c3=0;c3<trs[r].cells.length;c3++) cells.push(_richCollapse(_richInlineText(trs[r].cells[c3])));
        rows.push(ind+'| '+cells.join(' | ')+' |');
      }
      if(rows.length) blocks.push(rows.join('\n'));
    }
    else if(tag==='caption'){ para(_richInlineText(n)); }
    /* 其余（span/div/未知剥壳残余等）：按行内文本成段 */
    else para(_richInlineText(n));
  }
  return blocks;
}
function plainProjection(el){ return _projBlocks(el,'').join('\n\n'); }

/* ---------- UX-AI-CAPTURE-FIDELITY-01：代码块 chrome（所有来源共享） ----------
   语言标签取自来源确实标记的 language-*（无则不显示，不伪造）；独立复制按钮。
   零文本污染设计：chrome 元素不携带 DOM 文本（标签文字经 CSS attr 内容呈现），
   并带 data-nayan-chrome 标记——plainProjection/_projBlocks 显式跳过、复制载荷不受影响。
   点击接线在页面层（index.html 详情 / capture-mini 预览各自接 copy 通道）。 */
function wireCodeChrome(root){
  if(!root||!root.querySelectorAll) return 0;
  var pres=root.querySelectorAll('pre');
  var n=0;
  for(var i=0;i<pres.length;i++){
    var pre=pres[i];
    if(pre.previousElementSibling&&pre.previousElementSibling.getAttribute
       &&pre.previousElementSibling.getAttribute('data-nayan-chrome')) continue;
    var code=(pre.firstElementChild&&pre.firstElementChild.tagName==='CODE')?pre.firstElementChild:null;
    var cls=String(code?code.className:pre.className||'');
    var m=/(?:^|\s)language-([\w+#.-]+)/.exec(cls);
    var lang=m?m[1]:'';
    var bar=document.createElement('div');
    bar.className='nayan-codebar'; bar.setAttribute('data-nayan-chrome','1');
    var lab=document.createElement('span'); lab.className='nayan-codelang';
    lab.setAttribute('data-lang',lang);
    var btn=document.createElement('button'); btn.type='button'; btn.className='nayan-codecopy';
    btn.setAttribute('data-nayan-code-copy','1'); btn.title='复制代码';
    bar.appendChild(lab); bar.appendChild(btn);
    pre.parentNode.insertBefore(bar,pre);
    n++;
  }
  return n;
}
/* 代码块纯文本：优先 code 子元素；兜底收集文本节点并跳过 UI 控件（S03 hover 芯片等）。
   保留空格/缩进/换行，不混入 bash 标签/复制按钮文字/来源芯片。 */
function nayanCodeText(pre){
  if(!pre) return '';
  var code=(pre.firstElementChild&&pre.firstElementChild.tagName==='CODE')?pre.firstElementChild:null;
  if(code&&!(code.querySelector&&code.querySelector('.nayan-srccp'))) return code.textContent;
  var out='';
  (function walk(node){
    for(var i=0;i<node.childNodes.length;i++){
      var c=node.childNodes[i];
      if(c.nodeType===3){ out+=c.nodeValue; continue; }
      if(c.nodeType!==1) continue;
      if(c.getAttribute&&c.getAttribute('data-nayan-chrome')) continue;
      if(c.classList&&c.classList.contains('nayan-srccp')) continue;
      walk(c);
    }
  })(pre);
  return out;
}

/* ---------- S01：reader 正文分派（B05 契约 + P1-T06 mode 字段） ----------
   返回 { format, provenance:'declared'|'legacy', mode:'plain'|'markdown'|'html',
          renderable, text?, reason? }：
   - 无信封 = legacy，默认 plain/unknown（绝不自动按 Markdown 重解释）
   - 信封 legacy_assumed_plain 归因 legacy → plain
   - 声明 markdown/html（provenance=declared）→ 对应 rich 模式；其余格式一律 plain
   - bytes 原文 / canonical 全缺：显式 renderable:false 带原因 */
function readerBody(envelope, legacyText){
  if(!envelope){
    return { format:'plain', provenance:'legacy', mode:'plain', renderable:true,
             text:canonicalNewlines(legacyText==null?'':legacyText) };
  }
  var fmt=envelope.format||'plain';
  var prov=envelope.format_provenance==='legacy_assumed_plain'?'legacy':'declared';
  var orig=envelope.original;
  if(orig && orig.kind==='bytes'){
    return { format:fmt, provenance:prov, mode:'plain', renderable:false,
             reason:'二进制原文：不能按 plain 文本渲染（不猜 charset）' };
  }
  var text=null;
  if(typeof envelope.canonical==='string') text=envelope.canonical;
  else if(envelope.plain_projection && envelope.plain_projection.status==='available'
       && typeof envelope.plain_projection.text==='string') text=envelope.plain_projection.text;
  else if(orig && orig.kind==='text' && typeof orig.text==='string') text=orig.text;
  if(text==null){
    return { format:fmt, provenance:prov, mode:'plain', renderable:false,
             reason:envelope.canonical_unavailable_reason||'canonical 不可用' };
  }
  text=canonicalNewlines(text);
  var mode=(prov==='declared'&&(fmt==='markdown'||fmt==='html'))?fmt:'plain';
  return { format:fmt, provenance:prov, mode:mode, renderable:true, text:text };
}

/* S02/S03：plain 渲染器——唯一入口是文本节点；配 .aibody/.bubble 的保空白 CSS。
   rich 失败回退也会走到这里（先摘 rich 类，容器语义还原为纯文本）。 */
function renderPlain(el, text){
  el.classList.remove('rich');
  el.textContent=canonicalNewlines(text);
  return el;
}

/* S02–S05：rich 渲染唯一入口（详情页与收录窗预览共用）。
   成功 → { rendered:true, projection }；失败 → { rendered:false, reason }
   （调用方回退 renderPlain，源文本原样可读）。唯一 innerHTML 写点：
   入参必先过 sanitizeRichHtml 正向白名单。 */
function renderRich(el, decision, opener){
  var rt=richRuntime();
  if(rt.disabled) return { rendered:false, reason:'rich 渲染已停用（回退开关）' };
  if(decision.mode==='markdown'&&!rt.markdownit)
    return { rendered:false, reason:'markdown 解析器未加载，回退纯文本' };
  if(!rt.dompurify)
    return { rendered:false, reason:'HTML 清洗器不可用，回退纯文本' };
  var raw=decision.mode==='markdown'?markdownToHtml(decision.text):decision.text;
  if(raw==null) return { rendered:false, reason:'markdown 解析失败，回退纯文本' };
  var clean=sanitizeRichHtml(raw);
  if(clean==null) return { rendered:false, reason:'HTML 清洗不可用，回退纯文本' };
  el.textContent='';
  el.innerHTML=clean;
  el.classList.add('rich');
  wireRichLinks(el,opener);
  return { rendered:true, projection:plainProjection(el) };
}

/* 正文填充总入口：按 decision.mode 分派，plain/不可渲染/回退共用。
   index.html（fillReaderBody 包装缓存 decision 供回退开关重渲）与
   capture-mini（预览，opener=null 链接惰性）都走这里，两端输出恒等。 */
function renderReaderBody(el, decision, opener){
  if(!decision.renderable){
    el.classList.remove('rich');
    el.textContent='（'+decision.reason+'）';
    return { rendered:false, fallbackReason:decision.reason };
  }
  if(decision.mode==='markdown'||decision.mode==='html'){
    var out=renderRich(el,decision,opener);
    if(out.rendered){ try{ wireCodeChrome(el); }catch(_e){} return out; }
    renderPlain(el,decision.text);
    return { rendered:false, fallbackReason:out.reason };
  }
  renderPlain(el,decision.text);
  return { rendered:false };
}

/* ---------- P1-B06-PERF-01：最小、有界、可取消的异步渲染入口（仅详情正文） ----------
   依据（批 P1-B06-PERF-01 Step 2 拆测，Apple M5）：高密度 1MiB 同步链主耗时为
   DOMPurify 全串清洗 ~376ms、整树一次性挂载 ~48ms 与 layout ~177ms，三者均可按
   markdown-it 顶层结构元素分批摊开；parse ~59ms 与 sidecar mapper ~64ms 为各自
   独立单块（<100ms 输入阻塞预算）。实现：一次解析 → 顶层结构元素分批
   （批内 render → 整批过同一 sanitizeRichHtml → insertAdjacentHTML 挂载 →
   offsetHeight 布局检查点摊开增量 layout），批间主动让出主线程。
   切片 render 拼接与整串逐字节等价、分片 sanitize 拼接与整串清洗逐字节等价
   （四夹具验证，批证据 split-test/）——最终 DOM、code text、plain projection
   与同步实现一致；白名单/URL 规则/canonical/投影语义零改动。
   预览端（capture-mini）仍走同步 renderReaderBody；本入口仅供详情页调用。
   返回：{status:'rendered',rendered,projection?|fallbackReason?} /
        {status:'failed',rendered:false,reason,fallbackReason}（已回退 plain，正文可读） /
        {status:'cancelled',rendered:false}（任务已死，绝不写 DOM/状态）。 */
var RICH_SLICE_MAX_ELEMS=512;    /* 每批顶层元素数上限：Step 2 实测 512 元素/批的 render+sanitize+mount 单块最大 5.3ms */
var RICH_SLICE_MAX_HTML=48*1024; /* 每批 HTML 字符上限：48KiB 批清洗 ~16ms（0.28ms/KiB 实测），批数减半、总时长更优（扫参 24/48/64 实测） */
var RICH_ATTACH_EVERY_MS=250;    /* 暂存内容回挂的最小时间间隔：祖先 .aiquote 有 backdrop-filter，每次回挂都
                                    重模糊整面板——回挂次数受限，构建期零视觉成本（P1-B06-PERF-01 实测：
                                    直接逐批挂载在无头环境 ~20ms/帧且让出被帧闸拖到 ~11ms/次） */
var RICH_ATTACH_MAX_HTML=256*1024; /* Bound detached HTML units; keep the 250ms progress trigger.
                                    Larger live batches avoid repeatedly laying out a growing tree;
                                    sanitization/yield chunks remain 48KiB and fully cancellable. */

/* 顶层结构元素切片：nesting 归零处即完整结构元素边界（不拆嵌套容器、不按字符切） */
function richTopLevelRanges(tokens){
  var ranges=[],depth=0,start=0;
  for(var i=0;i<tokens.length;i++){
    depth+=tokens[i].nesting;
    if(depth===0){ ranges.push([start,i+1]); start=i+1; }
  }
  return ranges;
}
/* 批间让出主线程：优先 scheduler.yield()（Chrome 129+，每次调用独立结算）；
   其次 MessageChannel（任务级让出，实测 ~0.02ms/次）；setTimeout(0) 链有 ~4.6ms/次
   嵌套钳制，弃为末位回退。
   P1-B06-PERF-01-REPAIR-01 / R1-F01：MC 分支必须支持并发等待且一一结算——
   固定单一 port1.onmessage handler + FIFO resolver 队列（每次等待入队一个 resolver、
   发一条消息；每条消息按入队序结算恰好一个等待，绝不覆盖他人 handler）。
   任务归属的等待（richTaskYield）在任务取消时被立即结算（resolve），
   续作随即经存活复核返回 cancelled——旧任务的 promise 不会永远 pending。 */
var RICH_YIELD_CHAN=null, RICH_YIELD_WAITERS=[];
function richMCChannel(){
  if(!RICH_YIELD_CHAN){
    RICH_YIELD_CHAN=new MessageChannel();
    RICH_YIELD_CHAN.port1.onmessage=function(){
      var w=RICH_YIELD_WAITERS.shift();
      if(w){ try{ w.res(); }catch(e){ /* resolver 异常不外溢 */ } }
    };
  }
  return RICH_YIELD_CHAN;
}
function richEnqueueYield(task){
  return new Promise(function(res){
    RICH_YIELD_WAITERS.push({task:task,res:res});
    richMCChannel().port2.postMessage(0);
  });
}
/* A boosted scheduler.yield continuation can starve ordinary tasks over many slices.
   Keep the real yield, then resume at background priority so ready input/timer tasks run. */
function richSchedulerYield(task){
  return scheduler.yield().then(function(){
    if(task&&task.cancelled) return;
    /* Every slice really yields. Limit boosted continuation runs to 16ms of work,
       rather than paying a second scheduler task for each tiny sanitized slice. */
    if(typeof scheduler.postTask==='function' && (!task || task.forceFair || task.fairAt==null || performance.now()-task.fairAt>=16)){
      return scheduler.postTask(function(){ if(task){ task.fairAt=performance.now(); task.forceFair=false; } },{priority:'background'});
    }
  });
}
function richYieldToMain(){
  if(typeof scheduler==='object'&&scheduler&&typeof scheduler.yield==='function') return richSchedulerYield();
  if(typeof MessageChannel==='function') return richEnqueueYield(null);
  return new Promise(function(res){ setTimeout(res,0); });
}
/* 任务级让出：与 richYieldToMain 同链，但等待登记归属任务，可被取消路径结算 */
function richTaskYield(task){
  if(typeof scheduler==='object'&&scheduler&&typeof scheduler.yield==='function') return richSchedulerYield(task);
  if(typeof MessageChannel==='function') return richEnqueueYield(task);
  return new Promise(function(res){ setTimeout(res,0); });
}
/* 结算指定任务的在途等待（取消时调用）：只动自己的 resolver，不碰并发中的其他等待 */
function richSettleWaitersFor(task){
  if(!RICH_YIELD_WAITERS.length||!task) return;
  var keep=[];
  for(var i=0;i<RICH_YIELD_WAITERS.length;i++){
    var w=RICH_YIELD_WAITERS[i];
    if(w.task===task){ try{ w.res(); }catch(e){} } else keep.push(w);
  }
  RICH_YIELD_WAITERS=keep;
}
/* 取消元素上的当前渲染任务：旧 callback 此后一律视为死亡（不写 DOM/不挂 sidecar/不报完成） */
function cancelReaderBodyRender(el){
  var t=el&&el.__nayanRenderTask;
  if(t){ t.cancelled=true; richSettleWaitersFor(t); /* R1-F01：旧任务的等待立即结算→续作复核后返回 cancelled */ }
  if(el){
    el.__nayanRenderTask=null;
    /* A completed render can still have a queued fill timer. Cancel that work too. */
    el.__nayanCancelEpoch=(el.__nayanCancelEpoch||0)+1;
  }
}
/* Capture values, not just object references: callers may reuse a decision object. */
function readerContextSnapshot(decision,identity){
  var d=decision||{}, i=identity||{};
  return Object.freeze({text:d.text,format:d.format,provenance:d.provenance,mode:d.mode,
    renderable:d.renderable,reason:d.reason,itemId:i.itemId,requestId:i.requestId,revision:i.revision});
}
function readerContextMatches(decision,identity,s){
  var d=decision||{},i=identity||{};
  return !!s && d.text===s.text && d.format===s.format && d.provenance===s.provenance
    && d.mode===s.mode && d.renderable===s.renderable && d.reason===s.reason
    && i.itemId===s.itemId && i.requestId===s.requestId && i.revision===s.revision;
}
/* 任务仍活着 = 未取消 && 仍是元素当前任务 && decision/身份对象未换 && 元素仍在文档 */
function readerRenderTaskAlive(task){
  return !!task && !task.cancelled
    && task.el.__nayanRenderTask===task
    && task.el.__nayanDecision===task.decision
    && task.el.__nayanIdentity===task.identity
    && readerContextMatches(task.decision,task.identity,task.context)
    && task.el.isConnected;
}
function richAsyncFallbackResult(task,reason){
  if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
  renderPlain(task.el,task.decision.text);
  return {status:'failed',rendered:false,reason:reason,fallbackReason:reason};
}
async function richRenderTaskRun(task){
  var el=task.el,decision=task.decision;
  try{
    if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
    el.textContent='';
    el.classList.add('rich');
    wireRichLinks(el,task.opener);   /* 挂载前先接线：增量期间点击同样走窄域出口 */
    if(decision.mode==='html'){
      /* 声明 HTML 无结构切片依据（不能证明任意 HTML 的顶层边界），保持整串清洗+整串挂载 */
      var cleanH=sanitizeRichHtml(decision.text);
      if(cleanH==null) return richAsyncFallbackResult(task,'HTML 清洗不可用，回退纯文本');
      el.innerHTML=cleanH;
      if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
      var htmlProjection=plainProjection(el);
      wireCodeChrome(el);
      return {status:'rendered',rendered:true,projection:htmlProjection};
    }
    /* markdown：一次解析（与 markdownToHtml 同一实例、同一选项、同一 canonical 口径）。
       构建策略：分批「render→清洗→写入 detached 暂存」（不在文档内→零样式/布局/绘制成本，
       每批一个 ~10ms 级任务后让出主线程）；到时间/尺寸阈值再把暂存内容一次性移入正文
       （回挂次数受限→祖先 backdrop-filter 的整面板重模糊次数受限）。最终 DOM 与同步
       实现一致（同批界、同序、同清洗）。 */
    if(!MD_INSTANCE) MD_INSTANCE=markdownit({html:false,breaks:false,linkify:false,typographer:false});
    var env={};
    var tokens;
    var preparedSidecar=null;
    try{
      /* Mapper seals ranges from its own parse before the renderer sees mutable tokens.
         No caller-provided AST is accepted, and no mapping is published mid-render. */
      if(typeof NaYanSourceSpans==='object'&&typeof NaYanSourceSpans.prepare==='function'){
        var prepared=NaYanSourceSpans.prepare(decision,task.identity);
        if(!prepared.tokens && /^markdown 解析失败/.test(prepared.sidecar.reason||'')) throw new Error(prepared.sidecar.reason);
        if(prepared.tokens && prepared.sidecar.check(decision,task.identity)){
          tokens=prepared.tokens;env=prepared.env;preparedSidecar=prepared.sidecar;
        }
      }
      if(!tokens) tokens=MD_INSTANCE.parse(canonicalNewlines(decision.text),env);
    }catch(e){ return richAsyncFallbackResult(task,'markdown 解析失败，回退纯文本'); }
    if(tokens.length>RICH_SLICE_MAX_ELEMS){
      await richTaskYield(task);
      if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
    }
    var ranges=richTopLevelRanges(tokens),idx=0;
    /* Keep sanitized children in one detached fragment. Appending a fragment moves
       its children and empties it, so the same staging object can be reused. */
    var stage=el.ownerDocument.createDocumentFragment();
    var stagedHtml=0,lastAttach=performance.now(),projectionParts=[],sliceCount=0;
    function flushStage(){
      if(!stage.firstChild) return;
      el.appendChild(stage);
      /* Live insertion can queue style/layout work without advancing JS time yet.
         Give ready input/timer tasks a fair turn after every live batch too. */
      task.forceFair=true;
      stagedHtml=0;lastAttach=performance.now();
    }
    while(idx<ranges.length){
      if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
      sliceCount++;
      var parts=[],htmlLen=0;
      while(idx<ranges.length&&parts.length<RICH_SLICE_MAX_ELEMS&&htmlLen<RICH_SLICE_MAX_HTML){
        var h=MD_INSTANCE.renderer.render(tokens.slice(ranges[idx][0],ranges[idx][1]),MD_INSTANCE.options,env);
        parts.push(h); htmlLen+=h.length; idx++;
      }
      /* 每片清洗后再写入暂存：批 HTML 是完整顶层元素的拼接，不跨安全边界拼 raw 片 */
      var clean=sanitizeRichHtml(parts.join(''),true);
      if(clean==null) return richAsyncFallbackResult(task,'HTML 清洗不可用，回退纯文本');
      /* Reuse the sanitized fragment: no serialize/reparse cycle. Project each complete
         top-level batch while detached; join with the unchanged block separator. */
      if(!clean||clean.nodeType!==1||clean.tagName!=='BODY') return richAsyncFallbackResult(task,'清洗片段不可用，回退纯文本');
      var projected=_projBlocks(clean,'');
      for(var pi=0;pi<projected.length;pi++) projectionParts.push(projected[pi]);
      while(clean.firstChild) stage.appendChild(clean.firstChild);
      stagedHtml+=htmlLen;
      if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
      if(idx>=ranges.length||stagedHtml>=RICH_ATTACH_MAX_HTML||performance.now()-lastAttach>=RICH_ATTACH_EVERY_MS){
        flushStage();
        if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
      }
      if(idx<ranges.length) await richTaskYield(task); /* 小内容此处不触发：首片即全部完成，无多帧等待 */
    }
    flushStage();
    if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
    /* Let ready tasks/layout finish before the independent sidecar completion task. */
    if(sliceCount>1) await richTaskYield(task);
    if(!readerRenderTaskAlive(task)) return {status:'cancelled',rendered:false};
    /* UX-AI-CAPTURE-FIDELITY-01：异步 rich 完成后挂代码块 chrome（投影已在上行组装，
       chrome 元素带标记并被 _projBlocks 跳过，投影/复制载荷零污染） */
    try{ wireCodeChrome(el); }catch(_e){}
    return {status:'rendered',rendered:true,projection:projectionParts.join('\n\n'),sidecar:preparedSidecar};
  }catch(e){
    return richAsyncFallbackResult(task,'渲染中断：'+((e&&e.message)||String(e)));
  }
}
/* 异步详情入口：门与 renderReaderBody 一致；立即回退的路径不产生任务。
   脱离文档的容器（非详情路径）仍委托原同步入口，行为与预览端一致。 */
function renderReaderBodyAsync(el, decision, opener){
  cancelReaderBodyRender(el);
  if(!decision.renderable){
    el.classList.remove('rich');
    el.textContent='（'+decision.reason+'）';
    return Promise.resolve({status:'rendered',rendered:false,fallbackReason:decision.reason});
  }
  if(decision.mode!=='markdown'&&decision.mode!=='html'){
    renderPlain(el,decision.text);
    return Promise.resolve({status:'rendered',rendered:false});
  }
  var rt=richRuntime();
  if(rt.disabled){
    renderPlain(el,decision.text);
    return Promise.resolve({status:'failed',rendered:false,reason:'rich 渲染已停用（回退开关）',fallbackReason:'rich 渲染已停用（回退开关）'});
  }
  if(decision.mode==='markdown'&&!rt.markdownit){
    renderPlain(el,decision.text);
    return Promise.resolve({status:'failed',rendered:false,reason:'markdown 解析器未加载，回退纯文本',fallbackReason:'markdown 解析器未加载，回退纯文本'});
  }
  if(!rt.dompurify){
    renderPlain(el,decision.text);
    return Promise.resolve({status:'failed',rendered:false,reason:'HTML 清洗器不可用，回退纯文本',fallbackReason:'HTML 清洗器不可用，回退纯文本'});
  }
  if(!el.isConnected){
    var so=renderReaderBody(el,decision,opener);
    return Promise.resolve(so.rendered
      ?{status:'rendered',rendered:true,projection:so.projection}
      :{status:'failed',rendered:false,reason:so.reason,fallbackReason:so.reason});
  }
  var task={el:el,decision:decision,identity:el.__nayanIdentity,opener:opener,cancelled:false,
    context:readerContextSnapshot(decision,el.__nayanIdentity)};
  el.__nayanRenderTask=task;
  return richRenderTaskRun(task);
}

/* ---------- P1-B06-NATIVE-PAYLOAD-01 + READER-CONTRACT-REPAIR-01：只读 reader view → decision ----------
   reader_view_version:1 DTO（main.rs GET :id/reader）是读视图，不是 CapturedContent；
   正文只取 canonical 一份。全部字段完整校验（R1-F01 关闭）：own 格式/资格枚举、合法组合、
   id 形状、original_kind、request 类型、truncated 严格布尔、canonical/reason 互斥；
   bytes 只可有明确不可用原因不得携带文本 canonical；空串是合法正文。
   坏 view 一律显式 renderable:false，绝不伪装 legacy、不猜格式、不靠真值查表。 */
var READER_VIEW_VERSION=1;
/* READER-CONTRACT-REPAIR-02 / RC-R1-F02：契约字段必须自有（原型继承整体拒绝），
   且 request=null 仅允许无信封 legacy/plain/text 资格（declared 行的信封必有非空 request）。 */
function readerViewHasOwnContractFields(view){
  var keys=['reader_view_version','id','request_id','format','format_provenance','original_kind','truncated','canonical','canonical_unavailable_reason'];
  for(var i=0;i<keys.length;i++){ if(!Object.prototype.hasOwnProperty.call(view,keys[i])) return false; }
  return true;
}
function readerViewToDecision(view){
  /* invalid:true = DTO 资格失败（非法身份）——bindEntry 据此拒绝把 request 写入 bodyEl 身份；
     合法 bytes/不可渲染（DTO 合格）不带该标志，其真实不可用理由照常显示。 */
  var bad=function(reason){ return {format:'plain',provenance:'legacy',mode:'plain',renderable:false,invalid:true,reason:reason}; };
  try{
    if(!view||typeof view!=='object'||Array.isArray(view)) return bad('reader 视图缺失');
    if(!readerViewHasOwnContractFields(view)) return bad('reader 视图契约字段不完整（缺失或继承）');
    if(view.reader_view_version!==READER_VIEW_VERSION) return bad('reader 视图版本未知：'+String(view.reader_view_version));
    var fmt=view.format,prov=view.format_provenance;
    if(fmt!=='plain'&&fmt!=='markdown'&&fmt!=='html') return bad('reader 视图格式未知：'+String(fmt));
    if(prov!=='declared'&&prov!=='legacy_assumed_plain') return bad('reader 视图资格未知：'+String(prov));
    var legacy=prov==='legacy_assumed_plain';
    if(legacy&&fmt!=='plain') return bad('reader 视图矛盾组合：legacy_assumed_plain/'+String(fmt));
    var id=view.id, idOk=(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)||(typeof id==='string'&&/^[1-9][0-9]*$/.test(id));
    if(!idOk) return bad('reader 视图 id 形状非法：'+String(id));
    if(view.original_kind!=='text'&&view.original_kind!=='bytes') return bad('reader 视图 original_kind 未知：'+String(view.original_kind));
    var req=view.request_id;
    var text=view.canonical,reason=view.canonical_unavailable_reason;
    if(view.original_kind==='bytes'){
      /* RC-R3-F01+R4-F01：bytes 行 canonical 必须 ===null（其他类型 invalid）。
         request 资格：无信封旧行永远是 text quote 行——bytes 必须携带非空字符串 request
         （合法 structured legacy/declared bytes 均为不可渲染+真实理由+身份保留）；
         bytes+null request 属非法资格（invalid）。 */
      if(text!==null) return bad('bytes 视图 canonical 必须 null：'+String(text));
      if(typeof reason!=='string'||!reason) return bad('bytes 视图缺不可用原因');
      if(typeof req!=='string'||req.trim()==='') return bad('bytes 视图 request 必须为非空字符串：'+String(req));
      if(typeof view.truncated!=='boolean') return bad('reader 视图 truncated 非布尔');
      return {format:fmt,provenance:legacy?'legacy':'declared',mode:'plain',renderable:false,reason:reason};
    }
    if(legacy){
      /* null request 仅限无信封 legacy/plain/text 正常资格（canonical 字符串+reason null）；
         合法结构化 legacy 保留非空字符串 request（RC-R2-F02）。 */
      if(req!==null&&(typeof req!=='string'||req.trim()==='')) return bad('legacy 视图 request 只能为 null 或非空字符串：'+String(req));
    }else{
      if(typeof req!=='string'||req.trim()==='') return bad('declared 视图 request 必须为非空字符串：'+String(req));
    }
    if(typeof view.truncated!=='boolean') return bad('reader 视图 truncated 非布尔');
    if(typeof text==='string'){
      if(reason!==null) return bad('reader 视图 canonical 与不可用原因矛盾');
      if(legacy&&req===null){ /* 无信封旧行：canonical 字符串+reason null 才是 null request 的合法形态（已满足） */ }
      var mode=(legacy||fmt==='plain')?'plain':fmt;
      return {format:fmt,provenance:legacy?'legacy':'declared',mode:mode,renderable:true,text:text};
    }
    if(text===null){
      /* text 行 null canonical + 虚构 reason + null request = 非法资格（RC-R3-F01） */
      if(typeof reason==='string'&&reason){
        if(legacy&&req===null) return bad('无信封 legacy null request 不得携带 null canonical/不可用原因');
        return {format:fmt,provenance:legacy?'legacy':'declared',mode:'plain',renderable:false,reason:reason};
      }
      return bad('reader 视图缺 canonical');
    }
    return bad('reader 视图 canonical 类型非法：'+String(text));
  }catch(e){ return bad('reader 视图适配失败'); }
}

/* ---------- READER-CONTRACT-REPAIR-02：旧 /content 兼容体的严格信封资格（真实产品 helper） ----------
   按冻结 content.rs CapturedContent 构造/Deserialize 语义验证：schema/format/provenance 组合、
   非空 request、acquisition 枚举、original 文本/字节、fidelity 布尔、canonical 派生一致
   （canonical === canonicalize(original.text)，复用既有 canonicalNewlines，不改换行规则）、
   projection 与 format 相符、reason 互斥。合法 bytes 行明示不可渲染，不以 quote 伪装文字。
   返回 {ok:true, envelope} 或 {ok:false, reason}。 */
function readerEnvelopeQualifies(env){
  var fail=function(reason){ return {ok:false,reason:reason}; };
  try{
    if(!env||typeof env!=='object'||Array.isArray(env)) return fail('信封缺失或类型非法');
    if(!Object.prototype.hasOwnProperty.call(env,'schema_version')||env.schema_version!==1) return fail('信封版本未知');
    /* 必有字段（Rust 非 default）；fidelity/canonical/canonical_unavailable_reason/plain_projection
       按 serde default/Option 可缺省（RC-R3-F01），缺省值在下方各分支按冻结语义补齐。 */
    var keys=['schema_version','request_id','format','format_provenance','acquisition','original'];
    for(var i=0;i<keys.length;i++){ if(!Object.prototype.hasOwnProperty.call(env,keys[i])) return fail('信封缺字段：'+keys[i]); }
    var fmt=env.format,prov=env.format_provenance;
    if(fmt!=='plain'&&fmt!=='markdown'&&fmt!=='html') return fail('格式未知：'+String(fmt));
    if(prov!=='declared'&&prov!=='legacy_assumed_plain') return fail('资格未知：'+String(prov));
    if(prov==='legacy_assumed_plain'&&fmt!=='plain') return fail('矛盾组合：legacy_assumed_plain/'+String(fmt));
    if(typeof env.request_id!=='string'||env.request_id.trim()==='') return fail('request 必须为非空字符串');
    var acq=env.acquisition, ACQ=['ax_selection','region_ocr','clipboard','extension_dom','mcp','manual','legacy_import'];
    if(ACQ.indexOf(acq)<0) return fail('acquisition 未知：'+String(acq));
    var orig=env.original;
    if(!orig||typeof orig!=='object') return fail('original 缺失');
    /* RC-R3-F01：按冻结 content.rs 的 serde default/Option 语义——fidelity 与其 truncated
       缺省=false、canonical_unavailable_reason 缺省=null 均合法；显式错误值仍拒绝。
       （这是 CapturedContent 反序列化资格层，与 reader DTO 九字段 own 契约是不同合同。） */
    var fid=env.fidelity;
    if(fid===null) return fail('fidelity 显式 null 被拒绝（缺省才按 default=false）');
    if(fid===undefined){ fid={truncated:false}; }
    if(typeof fid!=='object'||Array.isArray(fid)) return fail('fidelity 类型非法');
    if(Object.prototype.hasOwnProperty.call(fid,'truncated')&&typeof fid.truncated!=='boolean') return fail('fidelity.truncated 必须为布尔');
    var truncated=fid.truncated===undefined?false:fid.truncated;
    var reason=env.canonical_unavailable_reason;
    if(reason===undefined) reason=null;
    /* 冻结 content.rs 构造器产出的精确 reason 文案（RC-R2-F02：不得发明） */
    var HTML_REASON='html sanitizer 未实现：结构化 plain projection 不可用（本批契约显式拒绝伪投影）';
    var BYTES_CANONICAL_REASON='二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）';
    var BYTES_PROJECTION_REASON='二进制 original 无文本投影';
    if(orig.kind==='text'){
      if(typeof orig.text!=='string') return fail('original.text 必须为字符串');
      if(!Object.prototype.hasOwnProperty.call(env,'canonical')||typeof env.canonical!=='string') return fail('text 行 canonical 必须为字符串');
      if(reason!==null&&reason!==undefined) return fail('text 行 canonical 与不可用原因互斥');
      var expect=canonicalNewlines(orig.text);
      if(env.canonical!==expect) return fail('canonical 与 original 规范化不一致');
      /* plain_projection 是必填字段（Rust 无 default）：缺省一律拒绝，不虚构。 */
      var proj=env.plain_projection;
      if(proj===undefined||proj===null) return fail('plain_projection 缺失（必填）');
      if(!proj||typeof proj!=='object') return fail('plain_projection 缺失');
      if(fmt==='html'){
        if(proj.status!=='unavailable') return fail('html 行 projection 必须显式不可用');
        if(proj.reason!==HTML_REASON) return fail('html 行 projection.reason 与冻结语义不符');
      }else{
        if(proj.status!=='available'||proj.text!==env.canonical) return fail('projection.text 必须等于 canonical');
      }
      return {ok:true,envelope:env};
    }
    if(orig.kind==='bytes'){
      /* Vec<u8>：逐项 0..255 整数；空向量按冻结构造器合法；charset_hint 仅 string|null（serde default 可缺） */
      if(!Array.isArray(orig.bytes)) return fail('bytes 行字节必须为数组');
      for(var bi=0;bi<orig.bytes.length;bi++){
        var b=orig.bytes[bi];
        if(typeof b!=='number'||!Number.isInteger(b)||b<0||b>255) return fail('bytes 含非法字节值：'+String(b));
      }
      var hint=orig.charset_hint;
      if(hint!==undefined&&hint!==null&&typeof hint!=='string') return fail('charset_hint 仅可为 string/null');
      if(env.canonical!==null&&(env.canonical!==undefined||Object.prototype.hasOwnProperty.call(env,'canonical'))) return fail('bytes 行不得携带文本 canonical');
      if(!Object.prototype.hasOwnProperty.call(env,'canonical')) { /* canonical Option default null */ }
      if(reason!==BYTES_CANONICAL_REASON) return fail('bytes 行 canonical 原因与冻结语义不符');
      var proj2=env.plain_projection;
      if(proj2===undefined||proj2===null) return fail('plain_projection 缺失（必填）');
      if(!proj2||proj2.status!=='unavailable'||proj2.reason!==BYTES_PROJECTION_REASON) return fail('bytes 行 projection 与冻结语义不符');
      return {ok:true,envelope:env};
    }
    return fail('original.kind 未知：'+String(orig.kind));
  }catch(e){ return fail('信封校验异常'); }
}
/* 旧 /content 兼容响应判定（真实产品 helper；当前无自动回退触发路径——404 一律显式不可用，
   见 bindEntry；此 helper 供「有独立端点不支持资格信号」的未来接入与真实测试）。 */
function readerCompatDecision(resp, selectedId){
  var unavailable=function(reason){ return {decision:{format:'plain',provenance:'legacy',mode:'plain',renderable:false,reason:reason},requestId:null}; };
  if(!resp||typeof resp!=='object'||Array.isArray(resp)) return unavailable('旧响应缺失或类型非法');
  if(resp.id!==selectedId) return unavailable('旧响应 id 与所选条目不符');
  if(resp.legacy===true){
    if(resp.envelope_json!==null&&resp.envelope_json!==undefined) return unavailable('legacy 行不得携带 structured 信封');
    if(typeof resp.quote!=='string') return unavailable('legacy 旧响应缺 quote');
    return {decision:readerBody(null, resp.quote),requestId:null};
  }
  if(resp.legacy===false){
    if(typeof resp.envelope_json!=='string') return unavailable('structured 旧响应缺 envelope_json');
    var env; try{ env=JSON.parse(resp.envelope_json); }catch(_e){ return unavailable('旧响应信封非法'); }
    var q=readerEnvelopeQualifies(env);
    if(!q.ok) return unavailable('旧响应信封资格不完整：'+q.reason);
    var rid=(typeof env.request_id==='string')?env.request_id:null;
    return {decision:readerBody(q.envelope, resp.quote),requestId:rid};
  }
  return unavailable('旧响应缺明确 legacy/structured 资格');
}

/* ---------- S04 源区间 sidecar（P1-B06-FIVE-STEP-2026-10-01；契约见批次
   SOURCE-SPAN-CONTRACT.md）----------
   仅「挂/取/清」三动作；sidecar 本体由 rich-source-map.js 构建（冻结数据对象，
   闭包持有 canonical 快照）。防跨条目串用双保险：
   ① 生命周期——fillReaderBody 每次先清旧 map（正文切换/回退/plain 都走它）；
   ② 访问校验——取用时重过 check(decision, 当前真实身份)
   （声明格式、身份、canonical 全文同时相等）。旧 map 即使残留也切不出新内容
   的片段。本节不新增任何 innerHTML 写点，不把原文属性透传为 DOM 属性。 */
function setReaderSidecar(el, sidecar){
  if(!el) return false;
  if(sidecar && typeof sidecar.check==='function' && el.__nayanDecision
     && sidecar.check(el.__nayanDecision,el.__nayanIdentity)){
    el.__nayanSourceMap=sidecar;
    el.__nayanSidecarCache=sidecar; /* 供「源码/排版」回退开关就地重挂（同一元素） */
    return true;
  }
  el.__nayanSourceMap=null;
  el.__nayanSidecarCache=null;
  return false;
}
function readerSidecarOf(el){
  var sc=el&&el.__nayanSourceMap;
  return (sc&&typeof sc.check==='function'&&el.__nayanDecision
          &&sc.check(el.__nayanDecision,el.__nayanIdentity))?sc:null;
}

/* ---------- P1-T07：复制语义/资格 helper（最小面；合同=batches/P1-B07/COPY-CONTRACT.md，
   先于实现冻结的独立期望，不从待测输出生成 golden）----------
   Copy Response：plain/legacy→canonical（仅 CRLF/CR→LF 一次转换，空白/缩进/组合
   字符/尾随空格原样）；declared Markdown→canonical 源码（非 DOM innerText）；
   declared HTML→同一受限渲染器的确定性 plainProjection（仅容器为完成态 rich 才可用，
   渲染中/失败/回退源码显式拒绝，不回退标签源码）；bytes→显式不可文本复制；
   加载失败/不可渲染→显式原因，不产出伪装成功的降级载荷。
   Copy Original：text→已保存 original.text 逐字符（保留 CRLF/CR；canonical 绝不
   冒充 original）；html→原始 HTML 源码逐字符；bytes→字节留存语义显式拒绝；
   无信封旧行→保存的原 quote。 */
function copyResponsePayload(decision, renderEl){
  if(!decision||typeof decision!=='object') return {ok:false,reason:'正文上下文缺失'};
  if(decision.renderable!==true) return {ok:false,reason:decision.reason||'正文不可用'};
  if(decision.format==='bytes') return {ok:false,reason:'二进制内容，不能按文本复制'};
  if(decision.mode==='html'){
    /* R1-SR-F02 修复：载荷=渲染完成时点对无控件 DOM 的确定性投影缓存（fillReaderBody
       完成回调计算并随渲染代次清除）。hover 芯片与一切 UI 控件文字不进入载荷，
       hover 前后 Copy Response 逐字符相等；不 trim/不删字样/不改原投影规则。 */
    var cachedProj=renderEl&&renderEl.__nayanHtmlProjection;
    if(typeof cachedProj!=='string'||!renderEl||!renderEl.classList||!renderEl.classList.contains('rich'))
      return {ok:false,reason:'HTML 投影不可用（渲染未完成或已回退源码）'};
    return {ok:true,payload:cachedProj};
  }
  if(typeof decision.text!=='string') return {ok:false,reason:'正文上下文缺失'};
  return {ok:true,payload:decision.text};
}
function copyOriginalPayload(rawOriginal, legacyQuote, hasEnvelope){
  if(hasEnvelope){
    if(!rawOriginal||typeof rawOriginal!=='object') return {ok:false,reason:'信封原文缺失'};
    if(rawOriginal.kind==='bytes') return {ok:false,reason:'二进制内容（字节留存），文件导出不在本批'};
    if(typeof rawOriginal.text==='string') return {ok:true,payload:rawOriginal.text};
    return {ok:false,reason:'信封原文形态未知：'+String(rawOriginal.kind)};
  }
  if(typeof legacyQuote==='string') return {ok:true,payload:legacyQuote};
  return {ok:false,reason:'无已保存原文'};
}
