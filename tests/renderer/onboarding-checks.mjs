// 真实 Rust API + 隔离空库 + shipped DOM；无权限调用与系统设置副作用。
export async function checkOnboarding({cdp,api,base,check,click,waitFor,sleep}) {
  check('O1','全新空库返回自动展示', (await api('GET','/api/onboarding')).show===true);
  await cdp.go(base+'/');
  check('O1','真实页面自动打开第一步',await waitFor('onboarding.step===1'));
  check('O1','展示即保存已看标记',(await api('GET','/api/onboarding')).seen===true);
  await click('[data-ob-next="2"]');
  check('O2','第二步权限不阻挡继续',await cdp.eval("onboarding.step===2 && !document.querySelector('[data-ob-next=\"3\"]').disabled"));
  await click('[data-ob-next="3"]');
  check('O3','未选择不能保存，库仍空',await cdp.eval("gid('obSave').disabled")&&(await api('GET','/api/suggestions')).length===0);
  const select=()=>cdp.eval("(()=>{const r=document.createRange();r.selectNodeContents(gid('obSample'));const s=getSelection();s.removeAllRanges();s.addRange(r);})()");
  await select();await sleep(100);
  check('O3','示例区选中后启用明确保存按钮',await cdp.eval("!gid('obSave').disabled"));
  await api('POST','/__test/fault',{path_contains:'/api/suggestions',action:'fail',times:1});
  await click('#obSave');
  check('O3','失败不显示成功且保留重试',(await api('GET','/api/suggestions')).length===0&&await cdp.eval("!onboarding.saved && !gid('obSave').disabled && gid('obSelection').textContent.includes('没有收进来')"));
  await click('#obSave');await waitFor('!!onboarding.saved');
  const first=(await api('GET','/api/suggestions'))[0];
  check('O3','示例在收件箱并保留原话和来源',first?.quote==='把今天要做的事写成三步，先完成最小的一步。'&&first.source_tool==='me'&&first.session_ref==='引导示例'&&first.status==='inbox'&&!first.list_id);
  const env=await api('GET','/api/suggestions/'+first.id+'/content');
  check('O3','正常信封入口完整保存原文',(env.content||env).original?.text===first.quote,env);
  await click('[data-ob-inbox]');
  check('O3','进入收件箱后展示刚保存的示例',await waitFor(`onboarding.step===0 && gid('onboarding').hidden && state.view.t==='triage' && state.sel===${first.id}`));
  await cdp.eval('openSettings()');await sleep(200);await click('#reopenOnboarding');
  await click('[data-ob-next="2"]');await click('[data-ob-next="3"]');await select();await sleep(100);await click('#obSave');await waitFor('!!onboarding.saved');
  const repeated=await api('GET','/api/suggestions');
  check('O4','设置重开重复保存仍是原来一条',repeated.length===1&&repeated[0].id===first.id&&await cdp.eval('onboarding.saved.duplicate===true'));
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await cdp.go(base+'/');
  check('O4','重载不再自动展示',await cdp.eval('onboarding.step===0 && gid("onboarding").hidden'));
  // 仅清理本套隔离档案的合成示例，下一组仍从七条固定 fixture 开始。
  await api('DELETE','/api/suggestions/'+first.id);await api('DELETE','/api/suggestions/'+first.id+'?purge=1');
}
