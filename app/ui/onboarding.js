/* 已定稿三步引导；示例仅在明确点击后经正常信封入口保存。 */
var onboarding={step:0,chosen:'',saved:null,busy:false,timer:null,focus:null};
var onboardingSample='把今天要做的事写成三步，先完成最小的一步。';
function openOnboarding(){
  return api('POST','/api/onboarding',{}).then(function(){
    closeSettings();
    onboarding.focus=document.activeElement;
    onboarding.saved=null; onboarding.chosen='';
    gid('onboarding').hidden=false;
    renderOnboarding(1);
  }).catch(function(e){toast(e.message);});
}
function closeOnboarding(inbox){
  clearInterval(onboarding.timer); onboarding.timer=null; onboarding.step=0;
  gid('onboarding').hidden=true;
  if(inbox){load(false).then(function(){goView('inbox');});}
  if(onboarding.focus&&onboarding.focus.isConnected) onboarding.focus.focus();
}
function renderOnboarding(step){
  clearInterval(onboarding.timer); onboarding.timer=null; onboarding.step=step; onboarding.chosen='';
  var box=gid('onboarding');
  var brand='<div class="ob-brand"><span class="ob-mark" aria-hidden="true"><i></i></span><span class="ob-word">纳言</span></div>';
  var preview='<div class="ob-preview"><div class="ob-row"><span class="ob-av">纳</span><span class="ob-label">阅读笔记 · 示例内容</span><span class="grow"></span><span class="ob-badge">收件箱</span></div><div class="ob-title">先完成最小的一步</div><p class="ob-note">'+onboardingSample+'</p></div>';
  var next='<button type="button" class="ob-cta" data-ob-next="'+(step+1)+'">'+(step===1?'下一步':'继续')+'</button>';
  var body='',foot='';
  if(step===1){
    body='<h3 id="obTitle">值得的话，先收进来。</h3><p>留住原话和来源，想做的时候，再一条条整理。</p>'+preview;
    foot='<span class="ob-label">内容留在这台 Mac 上</span><span class="grow"></span>'+next;
  }else if(step===2){
    body='<h3 id="obTitle">从别的 App，把那句话收过来。</h3><p class="ob-note">开启后可以用划词和框选。不想现在授权，也能粘贴或直接记一条。</p><div class="ss-group">'+
      [['ax','辅助功能 · 划词收录','读取你在其他 App 中选中的文字。'],['screen','屏幕录制 · 框选收录','保存你框选区域的原图，并在本机识别文字。']].map(function(p){
        return '<div class="ss-row"><div class="grow"><b>'+p[1]+'</b><div class="hint">'+p[2]+'</div></div><span class="ob-perm" id="ob-'+p[0]+'">检查中…</span><button type="button" class="tb" data-ob-perm="'+p[0]+'">打开系统设置</button></div>';
      }).join('')+'</div>';
    foot='<button type="button" class="lk" data-ob-next="1">上一步</button><span class="grow"></span><button type="button" class="lk" data-ob-next="3">稍后再开</button>'+next;
  }else{
    body='<h3 id="obTitle">试着留下一句话。</h3><p class="ob-note">在下面划选一段文字，再点「收进纳言」。</p><div class="ob-paper"><span class="ob-label">阅读笔记 · 引导示例</span><p class="ob-sample" id="obSample">'+onboardingSample+'</p></div><div class="hint" id="obSelection" role="status">先选一句你想留下的话。</div>';
    foot='<button type="button" class="lk" data-ob-next="2">上一步</button><span class="grow"></span><button type="button" class="lk" data-ob-skip>先用起来</button><button type="button" class="ob-cta" id="obSave" disabled>收进纳言</button>';
  }
  box.innerHTML='<div class="ob-sheet"><div class="ob-head">'+(step===1?brand+'<span class="grow"></span>':'')+'<span class="ob-label">'+step+' / 3</span>'+(step===1?'':'<span class="grow"></span>')+'<button type="button" class="lk" data-ob-skip>跳过引导</button></div>'+body+'<div class="ob-foot">'+foot+'</div><div id="obSaved"></div></div>';
  box.querySelector('[data-ob-skip]').focus();
  if(step===2){refreshOnboardingPermissions();onboarding.timer=setInterval(refreshOnboardingPermissions,2000);}
  if(step===3){
    gid('obSave').onpointerdown=function(e){e.preventDefault();};
    gid('obSave').onclick=saveOnboardingSample;
    if(onboarding.saved) showOnboardingSaved(onboarding.saved);
  }
}
function refreshOnboardingPermissions(){
  if(onboarding.step!==2||!TAPI) return;
  TAPI.invoke('perm_status').then(function(p){
    if(onboarding.step!==2) return;
    ['ax','screen'].forEach(function(k){
      var s=gid('ob-'+k),b=gid('onboarding').querySelector('[data-ob-perm="'+k+'"]');
      s.textContent=p[k]?'✓ 已开启':'未开启'; s.classList.toggle('yes',!!p[k]); b.hidden=!!p[k];
    });
  }).catch(function(){['ax','screen'].forEach(function(k){var s=gid('ob-'+k);if(s)s.textContent='未能检测';});});
}
function showOnboardingSaved(row){
  gid('obSave').disabled=true;
  gid('obSaved').innerHTML='<div class="ob-success" role="status">已收进收件箱。原话和来源都在。</div><div class="ob-preview"><div class="ob-row"><span class="ob-av">纳</span><span class="ob-label">我写的 · 引导示例 · 刚刚</span><span class="grow"></span><span class="ob-badge">收件箱 · 1</span></div><div class="ob-title">'+esc(row.title)+'</div><p class="ob-note">'+esc(row.quote)+'</p><div class="ob-row"><span class="grow"></span><button type="button" class="tb" data-ob-inbox>去收件箱看看</button></div></div>';
}
function saveOnboardingSample(){
  if(!onboarding.chosen||onboarding.busy||onboarding.saved) return;
  var text=onboarding.chosen,request='nayan-onboarding-example-v1';
  onboarding.busy=true;gid('obSave').disabled=true;
  api('POST','/api/suggestions',{title:NayanTitle.shortTitle(text),source_tool:'me',session_ref:'引导示例',kind:'suggestion',request_id:request,
    content:{schema_version:1,request_id:request,format:'plain',format_provenance:'declared',acquisition:'manual',original:{kind:'text',text:text},fidelity:{truncated:false},canonical:text,canonical_unavailable_reason:null,plain_projection:{status:'available',text:text}}
  }).then(function(row){
    onboarding.saved=row;
    if(onboarding.step===3) showOnboardingSaved(row);
    load(false);
  }).catch(function(e){if(onboarding.step===3){gid('obSelection').textContent='没有收进来：'+e.message;gid('obSave').disabled=!onboarding.chosen;}})
    .finally(function(){onboarding.busy=false;});
}
gid('onboarding').onclick=function(e){
  var b=e.target.closest('button');if(!b) return;
  if(b.hasAttribute('data-ob-skip'))closeOnboarding();
  else if(b.hasAttribute('data-ob-inbox'))closeOnboarding(true);
  else if(b.hasAttribute('data-ob-next'))renderOnboarding(Number(b.getAttribute('data-ob-next')));
  else if(b.hasAttribute('data-ob-perm')&&TAPI)TAPI.invoke(b.getAttribute('data-ob-perm')==='ax'?'open_ax_settings':'open_screen_settings').catch(function(e){toast(e.message||String(e));});
};
document.addEventListener('selectionchange',function(){
  if(onboarding.step!==3||onboarding.saved||onboarding.busy) return;
  var s=window.getSelection(),sample=gid('obSample');
  var text=s?s.toString().trim():'';
  var inside=s&&s.anchorNode&&s.focusNode&&sample.contains(s.anchorNode)&&sample.contains(s.focusNode);
  // macOS 三连击整段时选区会带段尾换行；只接受与示例全文一致且确实覆盖示例的选区。
  var whole=text===sample.textContent&&s.rangeCount&&s.getRangeAt(0).intersectsNode(sample);
  onboarding.chosen=inside||whole?text:'';
  gid('obSelection').textContent=onboarding.chosen?'已选中：'+onboarding.chosen:'先选一句你想留下的话。';
  gid('obSave').disabled=!onboarding.chosen;
});
window.addEventListener('focus',refreshOnboardingPermissions);
if(window.__TAURI__&&window.__TAURI__.event)window.__TAURI__.event.listen('tauri://focus',refreshOnboardingPermissions);
if(window.__TAURI__&&window.__TAURI__.event)window.__TAURI__.event.listen('main-close-requested',function(){if(onboarding.step)closeOnboarding();});
document.addEventListener('keydown',function(e){
  if(!onboarding.step)return;
  if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeOnboarding();}
  else if(e.key==='Tab'){
    var buttons=[].slice.call(gid('onboarding').querySelectorAll('button')).filter(function(b){return !b.disabled&&!b.hidden;});
    var first=buttons[0],last=buttons[buttons.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
  e.stopImmediatePropagation();
},true);
api('GET','/api/onboarding').then(function(s){if(s.show)openOnboarding();}).catch(function(){});
