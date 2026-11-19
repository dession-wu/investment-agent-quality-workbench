'use strict';
const API_BASE=new URL('.',location.href).pathname.replace(/\/$/,'');
const request=(path,options)=>fetch(API_BASE+path,options);
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LABELS={task:'任务回应',numeric:'数值与口径',risk:'必要风险',safety:'表达边界'};
const STATUS={UNRUN:'尚未核验',RUNNING:'执行中',EXECUTION_ERROR:'执行异常',NEEDS_EVIDENCE:'待补证／核验不足',FAIL:'发现失败',PASS:'本范围通过',UNKNOWN:'无法核验'};
const OUTCOMES={return_for_fix:'退回修复',needs_evidence:'待补证',archive:'已归档'};
let state=null,current=null,selected='F02',view='work',archive=null,archiveSelected=null,busy=false,polling=false,pendingRender=false,focusBeforeDialog=null;
const drafts=new Map(),pendingKeys=new Map(),volatileDrafts=new Set();
let demoStep=0,showAllConfig=false,draftStorageOK=true,demoReturn=null;
const evidenceVisits=new Set(),RESUME_KEY='investment-last-task:v1';
const DRAFT_PREFIX='investment-note-draft:v1:',DRAFT_TTL=7*24*60*60*1000;
const stamp=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间':'—';
const pill=x=>`<span class="pill ${esc(x)}">${esc(STATUS[x]||x)}</span>`;
const btn=(text,action,id='',primary=false,disabled=false)=>`<button data-action="${esc(action)}" data-id="${esc(id)}" class="${primary&&(!['inspector','gate'].includes(view)||action==='next-task')?'primary':''}" ${disabled?'disabled':''}>${esc(text)}</button>`;
const details=(title,data)=>`<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`;
const batch=()=>state?.batches.find(b=>b.batch.id===current);
const legacy=b=>b.frozen.provider!==state.provider_id||b.frozen.postprocess_version!==state.postprocess_version||b.frozen.judge_parameters?.enable_thinking===false;
const workflow=c=>c.workflow_status||(c.active?'RUNNING':!c.runs.length?'UNRUN':c.failure_context?'EXECUTION_ERROR':c.overall==='FAIL'?'FAIL':c.overall==='PASS'?'PASS':'NEEDS_EVIDENCE');
function batchStatus(b){const all=b.cases.map(workflow);return all.includes('RUNNING')?'RUNNING':all.includes('FAIL')?'FAIL':all.every(x=>x==='PASS')?'PASS':all.every(x=>x==='UNRUN')?'UNRUN':all.includes('EXECUTION_ERROR')?'EXECUTION_ERROR':'NEEDS_EVIDENCE';}
function reasonToRun(b,mode='run'){
  if(legacy(b))return '此任务冻结了旧配置，仅可查看或记录笔记。';
  if(!state.configured)return '当前部署未配置模型密钥，真实执行不可用。可查证、保存笔记、建立候选或查看历史。';
  if(state.batches.some(x=>x.cases.some(c=>c.active)))return '服务端正在处理任务，请等待完成。';
  return '';
}
function announce(text){const node=$('notice');node.textContent=text;if(node.dataset)node.dataset.tone=/失败|不足|不可|拒绝|错误|异常|不能|请填写/.test(text)?'warning':'info';if(text&&typeof setTimeout==='function')setTimeout(()=>{if(node.textContent===text&&node.dataset?.tone==='info')node.textContent='';},4500);}
async function read(path){const r=await request(path);const data=await r.json();if(!r.ok)throw new Error(data.error||'读取失败');return data;}
async function api(path,body){const sig=path+JSON.stringify(body);if(!pendingKeys.has(sig))pendingKeys.set(sig,crypto.randomUUID());const r=await request(path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':pendingKeys.get(sig)},body:JSON.stringify(body)});const data=await r.json();if(!r.ok){pendingKeys.delete(sig);throw new Error(data.error||'提交失败');}pendingKeys.delete(sig);return data;}
function storeDraft(key,value){
  drafts.set(key,value);
  if(!key.startsWith('note:'))return;
  try{if(value)localStorage.setItem(DRAFT_PREFIX+key,JSON.stringify({version:1,text:value,savedAt:Date.now()}));else localStorage.removeItem(DRAFT_PREFIX+key);volatileDrafts.delete(key);draftStorageOK=true;}
  catch{draftStorageOK=false;if(value)volatileDrafts.add(key);else volatileDrafts.delete(key);}
}
function restoreNoteDrafts(){
  // Only current-session batch/case keys are considered. Never scan other sessions.
  for(const b of state.batches)for(const c of b.cases){const key='note:'+b.batch.id+':'+c.case.id;if(drafts.has(key))continue;
    try{const raw=localStorage.getItem(DRAFT_PREFIX+key);if(!raw)continue;let item;try{item=JSON.parse(raw);}catch{localStorage.removeItem(DRAFT_PREFIX+key);continue;}
      if(item.version!==1||typeof item.text!=='string'||item.text.length>2000||!Number.isFinite(item.savedAt)||item.savedAt>Date.now()+60000||Date.now()-item.savedAt>DRAFT_TTL){localStorage.removeItem(DRAFT_PREFIX+key);continue;}
      drafts.set(key,item.text);
    }catch{draftStorageOK=false;}
  }
}
function clearSubmittedDraft(key,submitted){
  if(drafts.has(key)&&drafts.get(key).trim()!==submitted.trim())return;
  // An in-flight save must never erase text entered after the request began.
  try{const raw=localStorage.getItem(DRAFT_PREFIX+key);if(raw){const item=JSON.parse(raw);if(item.text?.trim()!==submitted.trim()){drafts.set(key,item.text);return;}}localStorage.removeItem(DRAFT_PREFIX+key);drafts.delete(key);volatileDrafts.delete(key);}
  catch{draftStorageOK=false;volatileDrafts.add(key);}
}
function draftLabel(key){return volatileDrafts.has(key)?'草稿未能保存 · 离开前请提交':drafts.get(key)?'本机草稿 · 刷新可恢复':(state?.batches.some(b=>b.notes.some(n=>key==='note:'+b.batch.id+':'+n.case_id))?'已保存到服务端':'尚未编辑');}
function commonChange(a,b){
  const x=Array.from(String(a??'')),y=Array.from(String(b??''));let i=0,j=0;
  while(i<x.length&&i<y.length&&x[i]===y[i])i++;
  while(j<x.length-i&&j<y.length-i&&x[x.length-1-j]===y[y.length-1-j])j++;
  const prefix=esc(x.slice(0,i).join('')),suffix=j?esc(x.slice(x.length-j).join('')):'';
  return {before:prefix+(x.length-i-j?'<del>'+esc(x.slice(i,x.length-j).join(''))+'</del>':'')+suffix,after:prefix+(y.length-i-j?'<ins>'+esc(y.slice(i,y.length-j).join(''))+'</ins>':'')+suffix};
}
function evidenceLines(value,path=''){
  if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>evidenceLines(v,path?path+'.'+k:k));
  const labels={id:'证据ID',metric_definition:'指标定义',single_quarter:'单季',cumulative:'累计',value:'数值',unit:'单位',period:'期间',risk:'必要风险',currency:'币种',entity:'主体',mode:'资料类型',available_at:'可用时间',scope:'范围',metric:'指标'};
  return [path.split('.').map(k=>labels[k]||k).join(' / ')+'：'+String(value??'—')];
}
function configRows(base,candidate){
  const fields=[['模型路由',base.frozen.generation_model,candidate.frozen.generation_model],['回答规则（Prompt）',base.frozen.prompt,candidate.frozen.prompt],['参考材料方案',base.frozen.generation_data,candidate.frozen.generation_data],['生成材料',evidenceLines(base.frozen.generation_evidence).join('\n'),evidenceLines(candidate.frozen.generation_evidence).join('\n')],['测试范围',base.cases.map(c=>c.case.id).sort().join(' / '),candidate.cases.map(c=>c.case.id).sort().join(' / ')],['核验依据',base.batch.benchmark_hash,candidate.batch.benchmark_hash]];
  return fields.map(([label,a,b])=>({label,a:String(a??'—'),b:String(b??'—'),changed:String(a??'—')!==String(b??'—')}));
}
function configComparison(base,candidate){
  const rows=configRows(base,candidate),count=rows.filter(r=>r.changed).length,visible=rows.filter(r=>showAllConfig||r.changed);
  return `<section class="config-diff"><div class="section-heading"><h3 id="config-heading" tabindex="-1">修改前后对照 <span class="tag">${count} 项变化</span></h3>${btn(showAllConfig?'只看变化':'查看全部字段','toggle-config')}</div><div class="scope-badges">${rows.filter(r=>!r.changed&&['参考材料方案','测试范围','核验依据'].includes(r.label)).map(r=>'<span class="tag">'+esc(r.label)+'未改变</span>').join('')}</div>${visible.length?`<div class="table-wrap"><table><thead><tr><th>字段</th><th>修改前 · 删除部分</th><th>修改后 · 新增部分</th></tr></thead><tbody>${visible.map(r=>{const d=commonChange(r.a,r.b);return `<tr class="${r.changed?'changed':'unchanged'}"><th scope="row">${esc(r.label)}</th><td class="diff-value">${d.before||'（空）'}</td><td class="diff-value">${r.changed?'':'<span class="tag">未改变</span><br>'}${d.after||'（空）'}</td></tr>`;}).join('')}</tbody></table></div>`:'<p class="muted">配置字段无变化</p>'}</section>`;
}
function presetScenario(){
  return {simulation:true,source:'authored_demo_not_model',question:'DEMO_A 2026年第三季度单季扣非净利润同比是多少？',baseline:'单季扣非净利润同比为45%。',candidate:'单季扣非净利润同比为8.2%；45%是前三季度累计同比。期末应收账款逾期占比18%，存在回款减值风险。',baselineChecks:{task:'FAIL',numeric:'FAIL',safety:'PASS'},candidateChecks:{task:'PASS',numeric:'PASS',safety:'PASS'}};
}
function demoView(){
  const p=presetScenario(),stages=['定位失败','修复配置','回归结果','范围决定'];
  const body=demoStep===0?`<h2>01 · 预置失败</h2><div class="compare"><div><h3>构造回答</h3><p>${esc(p.baseline)}</p>${pill('FAIL')}</div><div><h3>构造核验参考</h3><p>单季同比：8.2%<br>累计同比：45%</p><p>示例问题：累计口径被用于单季回答。</p></div></div>`:demoStep===1?`<h2>02 · 修复假设与配置</h2><div class="compare"><div><h3>原指令片段</h3><p><del>直接给出同比增速</del></p></div><div><h3>修复指令片段</h3><p><ins>先确认单季／累计口径，引用单季值，并保留必要风险</ins></p></div></div><p>测试范围：F02 · 参考资料固定</p>`:demoStep===2?`<h2>03 · 预置回归结果</h2><div class="compare"><div><h3>失败示例回答</h3><p>${esc(p.baseline)}</p></div><div><h3>修复示例回答</h3><p>${esc(p.candidate)}</p></div></div><table><thead><tr><th>必检项</th><th>预置基线</th><th>预置候选</th></tr></thead><tbody>${Object.keys(p.baselineChecks).map(k=>`<tr><td>${esc(LABELS[k])}</td><td>${pill(p.baselineChecks[k])}</td><td>${pill(p.candidateChecks[k])}</td></tr>`).join('')}</tbody></table>`:`<h2>04 · 示例范围决定</h2><div class="demo-outcome"><strong>演示：本测试范围可批准</strong><p>这是预先编写的流程示例，没有生成正式决定或审计记录。</p></div><p>真实任务只有在完整范围核验通过后，才允许保存决定。</p>${btn('回到真实排查任务','home')}`;
  $('app').innerHTML=head('','预置流程演示','所有答案、检查状态与决定均为预先编写的教学示例，不证明实际修复效果。',btn('退出演示','home'))+`<div class="demo-banner" role="status"><strong>预置演示 · 非实时模型调用</strong><span>不写入正式任务、评估或决定</span></div>${demoReturn?`<div class="demo-origin"><strong>这不是你刚修改候选的核验结果。</strong><p>这是另一个预先编写的示例，不验证当前候选的回答规则或效果。</p>${btn('返回我的待验证版本','demo-return')}</div>`:''}<nav class="demo-steps" aria-label="演示步骤">${stages.map((name,i)=>`<button data-action="demo-step" data-id="${i}" class="${demoStep===i?'selected':''}" ${demoStep===i?'aria-current="step"':''}>${i+1} ${name}</button>`).join('')}</nav><section class="panel">${body}<div class="form-foot">${demoStep>0?btn('上一步','demo-step',String(demoStep-1)):''}${demoStep<3?btn('下一步：'+stages[demoStep+1],'demo-step',String(demoStep+1),true):btn('重新体验','demo-step','0')}</div></section><p class="meta">示例状态是预置脚本，不来自模型或本轮规则执行；真实历史调用请到“历史实验”查看。</p>`;
}
function validateForm(form){
  form.querySelectorAll('.form-error').forEach(e=>e.textContent='');
  const values=new FormData(form);
  if(form.id==='new-form'&&!values.getAll('case_ids').length){const e=form.querySelector('#case-selection-error');e.textContent='请至少选择 1 个用例';form.querySelector('[name="case_ids"]')?.focus();return false;}
  for(const field of form.querySelectorAll('[required]')){
    if(!field.value.trim()){(form.querySelector('.form-error:not(#case-selection-error)')||form.querySelector('.form-error')).textContent=field.name==='reason'?'请填写处置依据与下一步':field.name==='name'?'请填写任务名称':field.name==='prompt'?'请填写修复 Prompt':'请填写必填内容';field.focus();return false;}
  }
  return true;
}
function relatedTasks(b=batch()){
  const base=b?.batch.parent_id?state.batches.find(x=>x.batch.id===b.batch.parent_id):b;
  const candidate=b?.batch.parent_id?b:state.batches.find(x=>x.batch.parent_id===base?.batch.id);
  return {base,candidate};
}
function lastTask(){
  try{const saved=JSON.parse(localStorage.getItem(RESUME_KEY));const found=state.batches.find(b=>b.batch.id===saved?.batch);if(found&&Number.isFinite(saved.savedAt)&&Date.now()-saved.savedAt<DRAFT_TTL)return {b:found,caseId:saved.caseId};}catch{}
  const b=state.batches[0];return b?{b,caseId:b.cases[0]?.case.id}:null;
}
function rememberTask(){if(!['inspector','gate'].includes(view)||!batch())return;try{localStorage.setItem(RESUME_KEY,JSON.stringify({batch:current,caseId:selected,savedAt:Date.now()}));}catch{}}
function hasProblemRecord(b,caseId){return !!b?.notes.some(n=>n.case_id===caseId);}
function taskProgress(b=batch()){
  const {base,candidate}=relatedTasks(b),validDecision=!!candidate?.decisions.some(d=>d.valid),disposition=candidate?.dispositions?.filter(d=>d.valid).at(-1);
  const scoped=base?.cases.find(c=>c.case.id===selected)||base?.cases[0];
  const recorded=!!base&&!!scoped&&(hasProblemRecord(base,scoped.case.id)||!!(scoped.evaluation&&scoped.runs.at(-1)?.status==='completed'&&!scoped.active));
  const evaluated=!!candidate&&candidate.cases.length>0&&candidate.cases.every(c=>!c.active&&c.runs.at(-1)?.status==='completed'&&c.evaluation&&['PASS','FAIL'].includes(workflow(c)));
  const pass=!!candidate&&comparable(base,candidate)&&!candidate.blockers.length&&candidate.cases.length>0&&candidate.cases.every(c=>workflow(c)==='PASS');
  const active=!!candidate?.cases.some(c=>c.active);
  const step=candidate?(view==='gate'&&(evaluated||validDecision||disposition)?3:2):(recorded?1:0);
  return {base,candidate,recorded,evaluated,pass,active,validDecision,disposition,step};
}
function taskNavigation(progress=null){
  const names=['核对回答','编写修复方案','验证修复效果','记录处理结论'];
  const done=progress?[progress.recorded,!!progress.candidate,progress.evaluated,progress.validDecision||!!progress.disposition]:[false,false,false,false];
  return `<nav class="task-navigation" aria-label="排查任务步骤">${names.map((name,i)=>{const here=progress&&progress.step===i;const status=here?'当前':done[i]?'已完成':'待处理';return `<button data-action="task-step" data-id="${i}" class="${here?'current':done[i]?'done':''}" ${here?'aria-current="step"':''}><b>${i+1}</b><span>${name}<small>${status}${i===3&&done[i]?' · 已记录处置':''}</small></span></button>`;}).join('')}</nav>`;
}
function inspectorPlan(b,row){
  const status=workflow(row),p=taskProgress(b),why=reasonToRun(b),bad=row.runs.at(-1);
  if(legacy(b))return {kind:'blocked',title:'旧配置任务，仅供查阅',label:'新建当前配置任务',mode:'new',detail:'原记录保留，可以保存笔记。'};
  if(b.cases.some(c=>c.active))return {kind:'running',title:row.active?'正在核验 '+row.case.id:'其他用例正在核验',label:'核验进行中…',mode:'wait',disabled:true,detail:'结果将在下方自动更新，请勿重复提交。'};
  if(!b.batch.parent_id&&hasProblemRecord(b,row.case.id))return {kind:'recorded',title:'问题记录已保存，尚未建立待验证版本。',label:'编写修复方案',mode:'candidate',detail:'建立候选后仍需核验完整范围。'};
  if(status==='UNRUN')return {kind:'unrun',title:row.answer?'先核验这条回答，再判断是否需要修复':'先生成回答，再核验质量',label:b.batch.source==='generated'?'生成回答并核验':'核验当前回答',mode:'selected-run',disabled:!!why,detail:why||('当前用例 '+row.case.id+' · 点击后处理此用例，不会自动运行其他用例。')};
  if(status==='EXECUTION_ERROR')return {kind:'error',title:'本次执行未完成，质量仍未知',label:'查看失败原因',mode:'result',detail:row.failure_context?.error||'查看结果区的错误记录；不会自动重试。'};
  if(status==='NEEDS_EVIDENCE')return {kind:'unknown',title:'核验已完成，但证据不足以判断',label:'查看缺失依据',mode:'result',detail:'先查看未知项，再记录补证或修复方案。'};
  if(b.batch.parent_id)return {kind:status==='PASS'?'pass':'fail',title:status==='PASS'?'当前用例通过，下一步查看完整范围':'当前用例仍有问题，需要继续修复',label:'查看回归与结论',mode:'gate-current',detail:'当前用例的结果见下方；是否通过取决于全部冻结用例。'};
  if(hasProblemRecord(b,row.case.id))return {kind:'recorded',title:'问题记录已保存，尚未建立待验证版本。',label:'编写修复方案',mode:'candidate',detail:'候选保留测试范围和核验参考，修复后仍需验证。'};
  return {kind:status==='PASS'?'pass':'fail',title:status==='PASS'?'当前用例通过，请核对下方结果':'已发现问题，先核对结果与证据',label:status==='PASS'?'查看核验依据':'记录问题，继续修复',mode:status==='PASS'?'evidence':'record',detail:'结果、原文和参考在下方；笔记不改变检查结果。'};
}
function gatePlan(b){
  const p=taskProgress(b),c=p.candidate,base=p.base;
  if(!c)return {kind:'unrun',title:'还没有待验证版本',label:'编写修复方案',mode:'candidate',detail:'从原回答建立候选，再核验固定范围。'};
  if(legacy(c))return {kind:'blocked',title:'旧配置候选，仅供查阅',label:'新建当前配置任务',mode:'new',detail:'不会把旧候选静默切换为当前模型。'};
  if(c.cases.some(x=>x.active))return {kind:'running',title:'正在核验，尚不能记录通过',label:'核验进行中…',mode:'wait',disabled:true,detail:'下方列表显示每个用例的执行进度。'};
  if(!comparable(base,c))return {kind:'blocked',title:'对比范围或核验依据不一致',label:'查看配置差异',mode:'config',detail:'先核对关联关系与参考，禁止记录比较通过。'};
  if(p.validDecision)return {kind:'pass',title:'已记录本测试范围通过结论。',label:'查看已保存结论',mode:'conclusion',detail:'仅适用于本次测试范围，不代表生产发布。'};
  const pending=c.cases.find(x=>workflow(x)==='UNRUN'),failed=c.cases.find(x=>workflow(x)==='FAIL'),uncertain=c.cases.find(x=>['EXECUTION_ERROR','NEEDS_EVIDENCE'].includes(workflow(x)));
  if(pending){const why=reasonToRun(c);return {kind:'unrun',title:'修复方案已建立，效果尚未验证。',label:'核验下一个用例 · '+pending.case.id,mode:'run',disabled:!!why,detail:why||'从下方用例逐项核验，完整范围通过后才能记录结论。'};}
  if(failed)return {kind:'fail',title:'核验已发现问题，修复效果尚未达标。',label:'继续编写修复方案',mode:'repair',detail:'先查看下方失败用例；不会用部分通过代替完整范围通过。'};
  if(uncertain)return {kind:'unknown',title:'当前证据或执行记录不足，无法判断修复效果。',label:'查看待处理用例',mode:'attention',detail:'未知和执行异常均阻断通过，可记录待补证。'};
  if(p.pass)return {kind:'pass',title:'所有必检项通过，尚未记录本范围结论。',label:'记录本范围通过结论',mode:'decision',detail:'写明依据并保存决定，才完成本次范围评审。'};
  return {kind:'unknown',title:'尚无足够结果支持通过',label:'查看待处理用例',mode:'attention',detail:'检查下方用例与阻断依据。'};
}
function taskCue(){
  const b=batch(),p=taskProgress(b),row=b.cases.find(c=>c.case.id===selected)||b.cases[0],plan=view==='gate'?gatePlan(b):inspectorPlan(b,row);
  const treatment=p.disposition?`<span class="tag">处理状态：${esc(OUTCOMES[p.disposition.outcome])}</span>`:'';
  const done=b.cases.filter(x=>['PASS','FAIL'].includes(workflow(x))).length;
  return `<section class="task-cue focus-${plan.kind}" aria-label="当前结论与下一步"><div><div class="eyebrow">${view==='gate'?'当前结论':'当前任务'} · ${done}/${b.cases.length} 用例已明确 ${treatment}</div><h2>${esc(plan.title)}</h2><p>${esc(plan.detail)}</p>${p.disposition?.outcome==='archive'?'<p class="archive-boundary">归档只结束本轮处理，不表示问题已解决或核验已通过。</p>':''}</div><div>${btn(plan.label,'next-task',plan.mode,true,busy||plan.disabled)}</div></section>`;
}
async function goTaskStep(i){
  if(!Number.isInteger(i)||i<0||i>3)return;
  if(!batch()){demoStep=i;demoReturn=null;return navigate('demo');}
  const p=taskProgress();
  if(i===0){selected=p.base?.cases.some(c=>c.case.id===selected)?selected:p.base?.cases[0]?.case.id;return navigate('inspector',p.base?.batch.id);}
  if(i===1){if(p.candidate){await navigate('gate',p.candidate.batch.id);if($('config-drawer'))$('config-drawer').open=true;$('config-heading')?.scrollIntoView?.({block:'start'});return;}current=p.base.batch.id;return candidateDialog();}
  if(!p.candidate){announce('先编写修复方案并建立待验证版本。');return candidateDialog();}
  if(i===2){selected=p.candidate.cases.find(c=>workflow(c)==='UNRUN')?.case.id||p.candidate.cases[0].case.id;return navigate('inspector',p.candidate.batch.id);}
  return navigate('gate',p.candidate.batch.id);
}
async function nextTask(mode){
  const b=batch(),p=taskProgress();
  if(mode==='new')return newDialog();
  if(mode==='wait')return;
  if(mode==='selected-run')return action('run',selected);
  if(mode==='gate-current')return navigate('gate',b.batch.id);
  if(mode==='config'){const d=$('config-drawer');if(d)d.open=true;$('config-heading')?.scrollIntoView?.({block:'start'});return;}
  if(mode==='attention'){const row=p.candidate.cases.find(c=>workflow(c)!=='PASS');selected=row.case.id;return navigate('inspector',p.candidate.batch.id);}
  if(mode==='result'){$('result-heading')?.scrollIntoView?.({block:'start'});$('result-heading')?.focus();return;}
  if(mode==='run-baseline')return action('run',selected);
  if(mode==='evidence'){const d=$('evidence-drawer');if(d)d.open=true;evidenceVisits.add(b.batch.id+':'+selected);render();$('evidence-heading').scrollIntoView?.({block:'start'});$('evidence-heading').focus();return;}
  if(mode==='record'){const d=$('notes-drawer');if(d)d.open=true;if(drafts.get('note:'+current+':'+selected)?.trim())return action('note-next',selected);$('case-note').scrollIntoView?.({block:'center'});$('case-note').focus();announce('请写下发现的问题，再保存并继续。');return;}
  if(mode==='candidate'){current=p.base.batch.id;return candidateDialog();}
  if(mode==='repair')return candidateDialog(p.candidate,p.base);
  if(mode==='preset'){demoReturn={batch:current,caseId:selected,view};demoStep=2;return navigate('demo');}
  if(mode==='run'){const row=p.candidate.cases.find(c=>workflow(c)==='UNRUN');if(!row)return;selected=row.case.id;await navigate('inspector',p.candidate.batch.id);return action('run',selected);}
  if(mode==='active'){selected=p.candidate.cases.find(c=>c.active)?.case.id||selected;return navigate('inspector',p.candidate.batch.id);}
  if(mode==='decision'){await navigate('gate',p.candidate.batch.id);if(!taskProgress().pass)throw new Error('当前完整范围仍有阻断');return decisionDialog('pass');}
  if(mode==='conclusion'){await navigate('gate',p.candidate.batch.id);if($('decision-drawer'))$('decision-drawer').open=true;$('conclusion-heading')?.scrollIntoView?.({block:'start'});return;}
  if(mode==='needs-evidence'){current=p.candidate.batch.id;return decisionDialog('needs_evidence');}
}
function refreshLiveResult(){
  if(view!=='inspector'||!batch())return;
  const b=batch(),row=b.cases.find(c=>c.case.id===selected)||b.cases[0];
  for(const [selector,markup] of [['.task-cue',taskCue()],['.result-section',resultSection(row,b)],['.case-tabs',caseSelector(b)]]){
    const node=document.querySelector(selector);if(node)node.outerHTML=markup;
  }
}
const SIDEBAR_KEY='wenheng-sidebar-collapsed:v1';
function setSidebarCollapsed(collapsed,persist=false){
  if(!document.body?.classList)return;
  document.body.classList.toggle('sidebar-collapsed',!!collapsed);
  const toggle=$('nav-toggle');if(toggle){toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',collapsed?'展开导航':'收起导航');toggle.title=collapsed?'展开导航':'收起导航';}
  if(persist)try{localStorage.setItem(SIDEBAR_KEY,collapsed?'1':'0');}catch{}
}
function restoreSidebar(){let collapsed=false;try{collapsed=localStorage.getItem(SIDEBAR_KEY)==='1';}catch{}setSidebarCollapsed(collapsed);}
if(typeof window!=='undefined')$('nav-toggle')?.addEventListener('click',()=>setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'),true));
function syncRoute(){const q=new URLSearchParams({view});if(current)q.set('batch',current);if(view==='inspector')q.set('case',selected);history.replaceState(null,'','#'+q.toString());}
function restoreRoute(){const q=new URLSearchParams(location.hash.slice(1));if(['work','inspector','gate','archive','demo'].includes(q.get('view')))view=q.get('view');current=q.get('batch');selected=q.get('case')||'F02';}
async function load(renderNow=true){state=await read('/api/state');if($('notice').textContent.startsWith('任务已提交')&&!state.batches.some(b=>b.cases.some(c=>c.active)))$('notice').textContent='';restoreNoteDrafts();if(current&&!batch()){current=null;view='work';}if(!current&&['inspector','gate'].includes(view))current=state.batches[0]?.batch.id||null;if(view==='archive'&&!archive)archive=await read('/api/archive');if(renderNow)render();else pendingRender=true;}
async function navigate(next,id){if(id)current=id;if(['inspector','gate'].includes(next)&&!batch())current=state.batches[0]?.batch.id||null;if(next==='archive'&&!archive)archive=await read('/api/archive');view=next;render();}
// Shared disclosure: hover/focus preview, click pins it open for touch and keyboard.
const help=(text,label='说明')=>`<span class="help-wrap"><button class="help-trigger" type="button" aria-label="${esc(label)}" aria-expanded="false">?</button><span class="help-content" role="note">${esc(text)}</span></span>`;
const helpHTML=(html,label='操作说明')=>`<span class="help-wrap"><button class="help-trigger" type="button" aria-label="${esc(label)}" aria-expanded="false">?</button><span class="help-content" role="note">${html}</span></span>`;
function head(kicker,title,description,actions=''){return `<div class="page-head"><div><div class="eyebrow">${esc({'work':'开始与继续','inspector':'核对回答','gate':'验证与结论','archive':'过往真实案例'}[view]||'质量治理')}</div><h1>${esc(title)} ${help(description,'页面用途')}</h1></div><div class="actions utility-actions">${actions}</div></div>`+(['inspector','gate'].includes(view)&&batch()?taskNavigation(taskProgress())+taskCue():'');}
function simplifyContent(){
  const app=$('app');
  // Policy paragraphs become contextual disclosures; actual blockers stay visible.
  app.innerHTML=app.innerHTML.replace(/<p class="hint">([\s\S]*?)<\/p>/g,(_,text)=>`<div class="context-help">${helpHTML(text)}</div>`);
}
function guide(){show('使用指南',`<div class="guide"><p class="guide-intro">查证 → 修复 → 回归 → 记录决定</p><ol class="guide-steps"><li><strong>新建排查</strong><p>在工作台新建任务，或载入 F02 构造示例。创建不会调用模型。</p></li><li><strong>对照证据</strong><p>在用例页左右对照回答与参考，查看必检结果；写下疑点并保存笔记。</p></li><li><strong>建立修复候选</strong><p>从基线修改 Prompt，冻结完整测试范围。候选不继承通过结果，需逐项核验。</p></li><li><strong>记录范围决定</strong><p>在版本页检查逐案例回归和阻断清单。全部必检项通过才可批准本测试范围；否则退回或记录待补证。</p></li></ol><details><summary>预置演示与真实任务</summary><p>工作台“体验预置闭环”展示预先编写的失败、修复、回归与范围决定。它不是模型调用或本轮规则执行，不写正式批次，也不能证明修复效果。真实模型历史请到历史实验查看。</p></details><details><summary>在线核验与执行方式</summary><p>首页显示在线核验时，可以新建任务并显式点击运行。创建、保存或浏览不会自动调用模型。独立预置结果不验证你的候选。</p><p>每次只执行用户选择的用例；同一时刻处理一个任务，失败不会自动重试。</p></details><details><summary>状态、证据与复核规则</summary><p>尚未核验、执行异常、待补证均不等于失败或通过。原始 UNKNOWN/NA 不能人工直接改成 PASS。处理意见、归档、退回不改变检查结果；正式复核会产生新修订，旧决定可能失效。</p><p>构造参考不是独立人工金标或权威金融数据；高亮仅标记裁判引用。构造基线和生成候选属于整体方案比较，不作为模型提升率或 Prompt 单变量因果结论。auto 不保证固定底层型号。</p></details><details><summary>轨迹与历史实验</summary><p>四节点轨迹只展示实际落盘记录。历史档案保留 28 次调用：12 次生成、16 次裁判，不是 28 个独立用例。数值规则只核验已抽取声明，不是全答案事实审核；公开披露快照不等于实时行情 MCP。</p></details><details><summary>保存、会话与产品边界</summary><p>笔记提交后保存至 SQLite；笔记草稿在当前浏览器7天内可恢复；清除站点数据或更换浏览器无法恢复。处置弹窗的未提交内容仍仅存于当前页面。同一浏览器 Cookie 恢复浏览器会话，清除 Cookie 不能找回。仅输入匿名测试文本。归档保留原始数据，不锁定或删除任务。</p><p>本产品不连接实时行情；当前决定仅适用于本次测试范围，不代表生产上线、金融合规认证或不可篡改存证。导出仅包含当前批次，不自动包含配对基线。</p></details></div>`);}
function render(){if(!state)return;pendingRender=false;for(const v of ['work','inspector','gate','archive']){$('nav-'+v).classList.toggle('active',view===v);if($('nav-'+v).setAttribute){$('nav-'+v).setAttribute('aria-current',view===v?'page':'false');}}$('environment').textContent=state.configured?'在线核验':'核验暂不可用';if(view==='work')work();else if(view==='inspector')inspector();else if(view==='gate')gate();else if(view==='demo')demoView();else archiveView();simplifyContent();document.querySelectorAll('[data-draft]').forEach(e=>{if(drafts.has(e.dataset.draft))e.value=drafts.get(e.dataset.draft);});rememberTask();syncRoute();}
function work(){
  const batches=state.batches,last=lastTask(),unrun=batches.filter(b=>batchStatus(b)==='UNRUN').length,failed=batches.filter(b=>batchStatus(b)==='FAIL').length;
  $('app').innerHTML=head('','检查回答，验证修复','检查投资问答中的数值错误或风险遗漏，并验证修改后的回答。')+`
  <section class="start-task"><div><span class="tag">${last?'继续你的任务':state.configured?'在线问答评估':'第一次使用 · 建议从预置示例开始'}</span><h2>检查投资问答中的数值错误与风险遗漏，验证修复效果。</h2>${last?`<p class="resume-name">上次任务：${esc(last.b.batch.name)} ${pill(batchStatus(last.b))}</p>`:(state.configured?'<p>生成回答、核对事实、验证修复，记录有依据的结论。</p>':'<p>用四个步骤，体验从核对证据到记录处理结论。</p>')}<div class="actions">${btn(last?'继续上次排查':state.configured?'开始质量排查':'体验一次完整排查',last?'resume':state.configured?'new':'demo','',true)}${btn(last?'新建排查任务':'查看操作示例',last?'new':'demo')}${btn('查看过往案例','walk-history')}</div><p class="meta">${state.configured?'支持财务口径与风险保留核验；点击运行后才调用模型。':'完整体验使用独立预置流程，不实时调用模型。新建排查当前支持预置用例。'}</p></div></section>
  ${taskNavigation(last?taskProgress(last.b):null)}
  <div class="stats"><span><strong>${batches.length}</strong>全部任务</span><span><strong>${unrun}</strong>尚未核验</span><span><strong>${failed}</strong>发现失败</span></div>
  <section class="panel task-list"><div class="section-heading"><h2>我的排查任务</h2>${help('任务仅属于当前浏览器会话；清除Cookie后不能找回。','会话范围')}</div>${batches.length?`<div class="table-wrap"><table><thead><tr><th>任务 / 版本</th><th>核验状态</th><th>处置状态</th><th>范围</th><th>下一步</th></tr></thead><tbody>${batches.map(b=>`<tr><td><strong>${esc(b.batch.name)}</strong><div class="meta">${b.batch.parent_id?'待验证版本':'原回答'} · 修订 ${b.batch.revision} · ${b.batch.source==='constructed'?'构造示例':'生成任务'}</div></td><td>${pill(batchStatus(b))}</td><td>${esc(b.dispositions?.at(-1)?.valid?OUTCOMES[b.dispositions.at(-1).outcome]:b.decisions.some(d=>d.valid)?'范围已批准':'未处置')}</td><td>${b.cases.length} 变体 / ${new Set(b.cases.map(c=>c.case.mother_id)).size} 母题</td><td>${btn(b.batch.parent_id?'验证与记录结论 →':'核对回答 →',b.batch.parent_id?'gate':'inspect',b.batch.id)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><h3>还没有正式排查任务</h3><p>新建排查任务，或查看操作示例</p></div>'}</section>${last?btn('用预置案例体验完整流程','demo'):btn('只打开F02待核对示例','quick')}`;
}
function highlightAnswer(row){const text=row.answer?.text||'尚未生成回答';if(row.active||row.runs.at(-1)?.status!=='completed'||!row.evaluation)return esc(text);const claims=row.evaluation.detail.raw_judge?.claims||[];const quote=claims.find(c=>c.quote&&text.includes(c.quote))?.quote;if(!quote)return esc(text);const index=text.indexOf(quote);return esc(text.slice(0,index))+'<mark>'+esc(quote)+'</mark>'+esc(text.slice(index+quote.length));}
function trace(row,b){const generation=row.runs.filter(r=>r.kind==='generation').at(-1),judge=row.runs.filter(r=>r.kind==='judge').at(-1);return `<div class="trace"><div><strong>1 · 生成输入与回答</strong><br>${generation?'实际生成运行：'+esc(generation.status):b.batch.source==='constructed'?'构造回答；原始生成过程未知。':'未执行生成。'} ${row.answer?'已保存回答。':''}</div><div><strong>2 · 裁判执行</strong><br>${judge?'运行状态：'+esc(judge.status)+'；'+esc(judge.error||'错误信息无'):'尚无裁判运行记录。'}</div><div><strong>3 · 规则与证据</strong><br>${row.evaluation?'存在评估记录，需结合本次运行是否有效阅读。':'尚无评估记录，不作内容正确性判断。'}</div><div><strong>4 · 人工与范围决定</strong><br>${row.reviews.length}条当前评估复核；${b.decisions.filter(d=>d.valid).length}条当前范围有效通过决定。未记录不等于已批准。</div></div>${row.failure_context?details('实际失败信息',row.failure_context):''}${row.runs.map(r=>details((r.kind==='generation'?'生成':'裁判')+' · '+r.status+' · 原始记录',r)).join('')}`;}
const casePill=value=>value==='PASS'?'<span class="pill PASS">用例通过</span>':pill(value);
const checkPill=value=>`<span class="pill ${esc(value)}">${esc({PASS:'通过',FAIL:'发现问题',UNKNOWN:'待补证',NA:'不适用'}[value]||value)}</span>`;
function caseSelector(b){return `<div class="case-tabs" aria-label="选择用例">${b.cases.map(c=>`<button data-action="case" data-id="${esc(c.case.id)}" class="${c.case.id===selected?'selected':''}"><strong>${esc(c.case.id)}</strong> · ${esc(c.case.profile.risk_tolerance)} <span>${esc(workflow(c)==='PASS'?'已通过':STATUS[workflow(c)])}</span></button>`).join('')}</div>`;}
function resultSection(row,b){
  const status=workflow(row),entries=Object.entries(row.effective_checks),canReview=!busy&&!legacy(b)&&!b.cases.some(c=>c.active)&&!!row.evaluation&&row.runs.at(-1)?.status==='completed';
  if(status==='UNRUN'&&!row.active)return `<section class="panel result-section pending-result" aria-labelledby="result-heading"><h2 id="result-heading" tabindex="-1">本次核验</h2><div class="result-empty"><span class="result-symbol" aria-hidden="true">○</span><div><h3>尚未开始核验</h3><p>点击上方主按钮开始，结果会显示在这里。</p><div class="check-scope">将检查：${row.case.checks.map(k=>esc(LABELS[k]||k)).join(' · ')}</div></div></div></section>`;
  if(row.active)return `<section class="panel result-section running-result" aria-live="polite"><h2 id="result-heading" tabindex="-1">正在核验</h2><div class="result-empty"><span class="run-spinner" aria-hidden="true"></span><div><h3>模型正在处理 ${esc(row.case.id)}</h3><p>完成后自动显示结果，刷新不会取消或重复调用。</p></div></div></section>`;
  const failed=entries.filter(([,v])=>v==='FAIL').length,unknown=entries.filter(([,v])=>['UNKNOWN','NA'].includes(v)).length;
  return `<section class="panel result-section" aria-labelledby="result-heading"><div class="section-heading"><h2 id="result-heading" tabindex="-1">核验结果</h2>${casePill(status)}</div><div class="result-totals"><span><b>${entries.filter(([,v])=>v==='PASS').length}</b> 通过</span><span class="${failed?'has-issue':''}"><b>${failed}</b> 发现问题</span><span class="${unknown?'has-unknown':''}"><b>${unknown}</b> 待补证</span></div>${row.failure_context?`<div class="execution-error"><strong>接口执行未完成，质量未知</strong><p>${esc(row.failure_context.error||'执行异常')} · 不自动重试</p></div>`:''}<div class="check-list">${entries.map(([k,v])=>`<div class="check-row"><strong>${esc(LABELS[k]||k)}</strong>${checkPill(v)}<details class="check-detail"><summary>查看依据${canReview?'与复核':''}</summary><p>${esc(row.evaluation?.detail.reason||row.evaluation?.detail.execution_error||'暂无可定位的核验依据。')}</p><div class="check-origin">原始结果 ${checkPill(row.evaluation?.raw_checks[k]||'UNKNOWN')} · 有效结果 ${checkPill(v)}</div>${canReview?btn('追加复核','review',k):''}</details></div>`).join('')}</div>${row.evaluation?details('高级：裁判与数值核验原始依据',row.evaluation):''}${row.reviews.length?details('人工复核记录',row.reviews):''}</section>`;
}
function evidenceSection(row,b){
  const reference=b.frozen.reference,open=!!row.answer&&(!row.runs.length||workflow(row)==='FAIL');
  return `<details id="evidence-drawer" class="panel review-disclosure" ${open?'open':''}><summary><span id="evidence-heading" tabindex="-1">回答与参考证据</span><small>${row.answer?'对照原文与口径':'核验开始后将生成回答'}</small></summary><div class="disclosure-body"><p class="investigation-focus">${row.case.id==='F02'?'核对方向：是否把累计增长误写成单季增长？':'核对方向：回答是否保留了必要风险？'} <span class="tag">${row.evaluation?'请结合实际核验依据':'待核对 · 不是结论'}</span></p><div class="compare"><div><h3>待核对回答</h3><p class="answer">${highlightAnswer(row)}</p><span class="tag">${row.answer?.source==='constructed'?'构造回答':row.answer?'实际生成':'未生成'}</span></div><div><h3>本案例核验参考</h3><p>单季扣非同比：<strong>${esc(reference.single_quarter?.value??'缺失')}${esc(reference.single_quarter?.unit||'')}</strong><br>累计同比：${esc(reference.cumulative?.value??'缺失')}${esc(reference.cumulative?.unit||'')}</p><p>${esc(reference.risk)}</p><span class="tag">构造参考</span>${help('资料与画像为构造样本，未独立专家金标，不代表实时金融数据。','参考来源')}</div></div><details><summary>画像、参考与生成配置</summary>${details('问题与画像',row.case)}${details('核验参考',reference)}${details('实际冻结的生成配置',{model:b.frozen.generation_model,prompt:b.frozen.prompt,generation_data:b.frozen.generation_data,evidence:b.frozen.generation_evidence})}</details></div></details>`;
}
function noteSection(row,b){const noteKey='note:'+current+':'+selected;return `<details id="notes-drawer" class="panel review-disclosure"><summary><span>问题记录与修复方案</span><small>${b.notes.filter(n=>n.case_id===selected).length} 条已保存</small></summary><div class="disclosure-body"><label for="case-note">当前用例笔记 · ${esc(selected)}</label><p id="draft-status" class="draft-status" role="status">${esc(draftLabel(noteKey))}</p><textarea maxlength="2000" id="case-note" data-draft="${esc(noteKey)}" placeholder="记录引用、疑点及下一步验证动作。保存笔记不改变结果。"></textarea><div class="actions">${btn(b.batch.parent_id?'保存问题记录，查看回归':'保存问题记录，继续编写修复方案','note-next',selected,false,busy)}${btn('记录待补证','needs-evidence',current,false,busy||legacy(b)||b.cases.some(c=>c.active)||b.decisions.some(d=>d.valid))}</div>${b.notes.filter(n=>!n.case_id||n.case_id===selected).map(n=>`<div class="record"><small>${n.case_id?'用例 '+esc(n.case_id):'批次级历史笔记'} · ${stamp(n.created_at)}</small><p>${esc(n.text)}</p></div>`).join('')}</div></details>`;}
function inspector(){
  const b=batch();if(!b){$('app').innerHTML=head('','先选择一个排查任务','先从首页选择或新建任务。',btn('回到工作台','home'));return;}
  const row=b.cases.find(c=>c.case.id===selected)||b.cases[0];selected=row.case.id;
  const retry=['failed','incomplete','interrupted'].includes(row.runs.at(-1)?.status),why=reasonToRun(b),active=b.cases.some(c=>c.active);
  $('app').innerHTML=head('','核对回答','先执行，再看核验结果；证据、笔记和高级操作按需展开。',btn('返回任务列表','home'))+`<div class="review-context"><div><strong>${esc(b.batch.name)}</strong><p>${esc(row.case.question)}</p></div><span class="meta">${esc(row.case.id)} · ${esc(row.case.profile.risk_tolerance)}</span></div>${caseSelector(b)}<div class="review-stack">${resultSection(row,b)}${evidenceSection(row,b)}${noteSection(row,b)}<details class="review-more"><summary>更多操作与原始记录</summary><div class="disclosure-body"><div class="actions">${btn('导出本批次记录','export',current)}${row.runs.length?btn('仅重评旧回答','reevaluate',selected,false,!row.answer||!!reasonToRun(b,'reevaluate')||busy):''}${retry?btn('明确重试失败项','retry',selected,false,!!why||busy):''}</div>${row.runs.length?`<details class="evidence-drawer"><summary>执行轨迹与原始记录 <span class="meta">${row.runs.length} 次运行</span></summary>${trace(row,b)}</details>`:'<p class="meta">尚未执行，没有模型运行记录。</p>'}</div></details></div>`;
}
function comparable(base,candidate){return !!base&&!!candidate&&candidate.batch.parent_id===base.batch.id&&candidate.batch.benchmark_hash===base.batch.benchmark_hash&&base.cases.map(c=>c.case.id).sort().join('|')===candidate.cases.map(c=>c.case.id).sort().join('|');}
function gate(){
  let candidate=batch(),base=candidate?.batch.parent_id?state.batches.find(b=>b.batch.id===candidate.batch.parent_id):candidate;
  if(candidate&&!candidate.batch.parent_id)candidate=state.batches.find(b=>b.batch.parent_id===base.batch.id);
  if(!base||!candidate){$('app').innerHTML=head('','验证与结论','先建立关联的候选，再比较完整范围。',btn('回到用例排查','inspect',base?.batch.id||''))+`<section class="panel"><h2>候选尚未建立</h2><p>提出修复假设后建立待验证版本。</p>${base?btn('从当前基线建立候选','candidate',base.batch.id,false,legacy(base)||busy||base.cases.some(c=>c.active)):btn('回到工作台','home')}</section>`;return;}
  current=candidate.batch.id;
  const good=comparable(base,candidate),allPass=good&&!candidate.blockers.length&&candidate.cases.length>0&&candidate.cases.every(c=>workflow(c)==='PASS'),active=candidate.cases.some(c=>c.active),locked=busy||active||legacy(candidate),hasDecision=candidate.decisions.some(d=>d.valid);
  const alternatives=state.batches.filter(b=>b.batch.parent_id===base.batch.id),passed=candidate.cases.filter(c=>workflow(c)==='PASS').length;
  $('app').innerHTML=head('','验证与结论','先看完整范围结论，再处理未通过用例；配置与审计按需查看。',btn('返回任务列表','home'))+`<div class="review-context"><div><strong>${esc(candidate.batch.name)}</strong><p>原回答 → 修复候选 · ${candidate.cases.length} 个固定用例</p></div><span class="range-counter">${passed}/${candidate.cases.length} 通过</span></div><section class="panel regression-results"><div class="section-heading"><h2 id="regression-heading" tabindex="-1">逐案例回归</h2><span class="meta">先处理未完成与未通过的用例</span></div><div class="regression-list">${candidate.cases.map(c=>{const old=base.cases.find(x=>x.case.id===c.case.id),status=workflow(c),pending=status==='UNRUN';const change=c.active?'候选执行中':pending?'候选未运行，不继承PASS':old?.overall==='FAIL'&&c.overall==='PASS'?'失败→通过（仅本范围观察）':old?.overall==='PASS'&&c.overall==='FAIL'?'新增失败':status==='NEEDS_EVIDENCE'?'待核验／证据不足':'已完成，查看依据';return `<div class="regression-row"><div class="regression-case"><strong>${esc(c.case.id)}</strong><small>${esc(c.case.profile.risk_tolerance)}</small></div><div class="regression-status"><span>原回答 ${old?casePill(workflow(old)):'无匹配案例'}</span><span>候选 ${casePill(status)}</span><p>${esc(change)}</p></div>${btn(pending?'核验此用例':'查看结果与依据','gate-case',c.case.id,false,busy)}</div>`;}).join('')}</div></section><details class="panel review-disclosure" id="config-drawer"><summary><span id="config-heading" tabindex="-1">修复了什么</span><small>规则、证据与测试范围对照</small></summary><div class="disclosure-body">${alternatives.length>1?`<label for="candidate-select">切换候选</label><select id="candidate-select">${alternatives.map(b=>`<option value="${esc(b.batch.id)}" ${b.batch.id===current?'selected':''}>${esc(b.batch.name)}</option>`).join('')}</select>`:''}<p class="${good?'hint':'warning'}">${good?'关联关系、测试范围与评测基准一致。':'关系、范围或评测基准不一致；禁止直接记录比较通过。'}</p>${configComparison(base,candidate)}${details('高级：原始配置与可比性',{baseline:{source:base.batch.source,model:base.frozen.generation_model,prompt:base.frozen.prompt,data:base.frozen.generation_data},candidate:{model:candidate.frozen.generation_model,prompt:candidate.frozen.prompt,data:candidate.frozen.generation_data},benchmark_equal:good,actual_model:'auto不等于固定底层型号'})}</div></details><details class="panel review-disclosure" id="decision-drawer"><summary><span id="conclusion-heading" tabindex="-1">处理与决定</span><small>${hasDecision?'已保存范围结论':'未记录不等于已通过'}</small></summary><div class="disclosure-body"><h3>阻断与决定</h3>${candidate.blockers.length?'<ul>'+candidate.blockers.map(x=>'<li>'+esc(x.case_id+'：'+(STATUS[x.reason]||x.reason))+'</li>').join(''):'<p>当前必检项通过，可记录有限范围决定。</p>'}<div class="actions">${btn('批准本测试范围','decision',current,false,locked||!allPass||hasDecision)}${btn('退回修复','return-fix',current,false,locked||hasDecision)}${btn('记录待补证','needs-evidence',current,false,locked||hasDecision)}${btn('归档本轮','archive-task',current,false,locked)}</div><p class="meta">处置不改变核验结果；归档不表示问题解决。</p>${candidate.decisions.map(d=>`<div class="record"><strong>${d.valid?'当前范围通过':'历史决定已失效'}</strong><p>${esc(d.reason)}</p></div>`).join('')}${(candidate.dispositions||[]).map(d=>`<div class="record"><strong>${esc(OUTCOMES[d.outcome])}${d.valid?'':' · 依据已更新'}</strong><p>${esc(d.reason)}</p></div>`).join('')}${details('追加事件记录',candidate.events)}</div></details><details class="review-more"><summary>导出与比较边界</summary><div class="disclosure-body">${btn('导出候选审计记录','export',current)}<p class="meta">构造基线与生成候选属于整体方案比较，不作为 Prompt 单变量因果结论。导出仅包含当前候选批次。</p></div></details>`;
}
function archiveView(){if(!archive){$('app').innerHTML='<section class="panel">正在读取归档…</section>';return;}const rows=archive.analysis.rows,row=rows.find(r=>r.run_id===archiveSelected)||rows[0];archiveSelected=row.run_id;$('app').innerHTML=head('HISTORICAL EVIDENCE / 04','历史真实实验','保留既有生成、裁判及离线核验记录；查看不产生新调用。',btn('返回治理工作台','home'))+`<div class="archive-summary"><div><strong>28</strong> 次历史调用 <span class="meta">12 次生成 / 16 次裁判</span> ${help('28次调用，不是28个独立用例。仅查看历史，不产生新调用；不能替代当前任务核验。','样本范围')}</div>${btn('另建构造排查','quick')}</div><section class="panel"><label for="archive-select">选择一个历史生成结果</label><select id="archive-select">${rows.map(r=>`<option value="${r.run_id}" ${r.run_id===archiveSelected?'selected':''}>${esc(r.run_id+' · '+r.model+' · '+r.overall)}</option>`).join('')}</select><div class="status-line">${pill(row.overall)}<span>${row.source_mode==='snapshot'?'公开披露下载快照，不代表实时MCP':'构造证据下的真实模型输出'}</span></div><div class="compare"><div><h3>当时生成的回答</h3><p class="answer">${esc(row.answer)}</p></div><div><h3>离线核验观察</h3><p>${esc(row.numeric_verification.reason)}</p><p>${Object.entries(row.effective_checks).map(([k,v])=>esc(LABELS[k]||k)+' '+pill(v)).join(' ')}</p>${help('数值规则核验已抽取声明，并非全答案事实审核。','离线核验范围')}</div></div>${details('既有生成请求与返回',archive.records[row.run_id])}${details('既有裁判请求与返回',archive.records['J-'+row.run_id])}${details('单条结构与引用检查',row.judge_validation)}<details><summary>样本范围与分组结果</summary>${details('组别的达标与UNKNOWN记录',archive.analysis.groups)}<ul>${archive.analysis.qualifications.map(q=>'<li>'+esc(q)+'</li>').join('')}</ul></details></section>`;}
function show(title,body){focusBeforeDialog=document.activeElement;$('modal-title').textContent=title;$('modal-body').innerHTML=body.replace(/<p class="hint">([\s\S]*?)<\/p>/g,(_,text)=>`<div class="context-help">${helpHTML(text,'表单说明')}</div>`);$('modal-body').querySelectorAll('[data-draft]').forEach(e=>{if(drafts.has(e.dataset.draft))e.value=drafts.get(e.dataset.draft);});$('modal').showModal();}
function close(){ $('modal').close(); }
function newDialog(){show('发起质量排查',`<form id="new-form" novalidate><p>先选择要检查的问题。提交只创建任务，不自动执行。</p><label>任务名称<input name="name" value="财务口径与风险排查" maxlength="80" required></label><fieldset><legend>要核验哪些问题？</legend><p id="case-selection-error" class="form-error" role="alert"></p>${state.templates.cases.map((c,i)=>`<label class="choice"><input name="case_ids" value="${c.id}" type="checkbox" ${i===0?'checked':''}><span>${c.id} · ${esc(c.question)}<br><small>画像：${esc(c.profile.risk_tolerance)}</small></span></label>`).join('')}</fieldset><label>本次目标<select name="source" id="new-source"><option value="constructed">先核对已有构造回答</option><option value="generated" ${state.configured?'selected':'disabled'}>生成回答并在线核验</option></select></label><p class="hint">${state.configured?'已接入在线模型。创建后点击运行核验，每次处理一个用例。':'公网无密钥：只能创建与查证构造示例，不会产生自动评估结果。'} 构造答案的原生成配置未知，后续候选再选择Prompt。</p><p class="form-error" role="alert"></p><div class="form-foot"><button type="submit" class="primary">创建任务，查看用例</button></div></form>`);}
function candidateDialog(seed=null,baseOverride=null){const b=baseOverride||batch(),source=seed||b;if(!b||legacy(b)||b.batch.parent_id||b.cases.some(c=>c.active))throw new Error('请从兼容、非执行中的原始基线建立候选');show('编写修复方案',`<form novalidate id="candidate-form" data-base="${esc(b.batch.id)}" data-revision="${b.batch.revision}"><p>完整范围${b.cases.map(c=>c.case.id).join(' / ')}与核验参考不变。创建后先比较配置，再逐项执行。</p><label>候选名称<input name="name" value="${esc(b.batch.name+' · 修复候选')}" maxlength="80" required></label><label>修改回答规则（Prompt）<textarea name="prompt" maxlength="3000" required>${esc(seed?.frozen.prompt||state.templates.prompts.P2)}</textarea></label><details><summary>高级：生成模型与证据</summary><label>模型路由<select name="model">${state.models.map(m=>`<option value="${esc(m)}" ${m===source.frozen.generation_model?'selected':''}>${esc(m)}</option>`).join('')}</select></label><label>生成证据<select name="generation_data"><option value="D1" ${source.frozen.generation_data==='D1'?'selected':''}>D1 · 完整口径定义</option><option value="D2-missing-single-quarter" ${source.frozen.generation_data!=='D1'?'selected':''}>D2 · 去除单季值及定义</option></select></label></details><p class="hint">构造基线来源未知，不能称Prompt单变量实验；改变生成证据不会修改核验参考。创建不调用模型。</p><p class="form-error" role="alert"></p><div class="form-foot"><button type="submit" class="primary">建立待验证版本，继续验证</button></div></form>`);}
function reviewDialog(key){const b=batch(),row=b.cases.find(c=>c.case.id===selected);if(!row.evaluation||row.active||legacy(b)||row.runs.at(-1)?.status!=='completed')throw new Error('当前评估不能复核');const unknown=['UNKNOWN','NA'].includes(row.evaluation.raw_checks[key]);show('追加复核 · '+LABELS[key],`<form novalidate id="review-form" data-revision="${b.batch.revision}" data-key="${esc(key)}" data-evaluation="${esc(row.evaluation.id)}"><p>原判定${pill(row.evaluation.raw_checks[key])}；复核不覆盖原意见。</p><label>结论<select name="target"><option value="FAIL">确认问题 · FAIL</option><option value="UNKNOWN">仍需证据 · UNKNOWN</option><option value="PASS" ${unknown?'disabled':''}>判为误报 · PASS</option></select></label>${unknown?'<p class="hint">原始未知项不能直接复核为通过。</p>':''}<label>证据与理由<textarea name="reason" maxlength="2000" required></textarea></label><input type="hidden" name="evidence_id" value="${esc(b.frozen.reference.id)}"><p class="form-error" role="alert"></p><div class="form-foot"><button type="submit" class="primary">追加复核记录</button></div></form>`);}
function decisionDialog(outcome){const b=batch();if(legacy(b)||b.cases.some(c=>c.active))throw new Error('当前任务不可记录决定');const approve=outcome==='pass';if(approve&&(b.blockers.length||b.decisions.some(d=>d.valid)))throw new Error('当前范围不能记录通过决定');show(approve?'记录测试范围通过决定':outcome==='archive'?'归档本轮':OUTCOMES[outcome],`<form novalidate id="decision-form" data-outcome="${esc(outcome)}" data-revision="${b.batch.revision}"><p>对象：${esc(b.batch.name)}；${b.cases.length}个变体，修订${b.batch.revision}。${approve?'不是上线放行。':'处置不更改检查结果；归档保留原始数据。'}</p><label>依据与下一步<textarea name="reason" data-draft="${esc('decision:'+current+':'+outcome)}" maxlength="2000" required></textarea></label><p class="form-error" role="alert"></p><div class="form-foot"><button type="submit" class="primary">保存${approve?'范围决定':'处置记录'}</button></div></form>`);}
function download(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function action(command,id){
  if(command==='next-task')return nextTask(id);
  if(command==='task-step'){if(view==='work'||!batch()){const last=lastTask();if(last){current=last.b.batch.id;selected=last.caseId||last.b.cases[0]?.case.id;}}return goTaskStep(Number(id));}
  if(command==='resume'){const last=lastTask();if(!last)return navigate('work');selected=last.caseId||last.b.cases[0]?.case.id;return navigate(last.b.batch.parent_id?'gate':'inspector',last.b.batch.id);}
  if(command==='demo-return'){const back=demoReturn;demoReturn=null;if(!back||!state.batches.some(b=>b.batch.id===back.batch))return navigate('work');selected=back.caseId;return navigate(back.view,back.batch);}
  if(command==='note-next'){await action('note',id);if(drafts.get('note:'+current+':'+selected)?.trim()){announce('问题已保存，但还有新的草稿；请确认后再继续。');return;}const b=batch();if(b.batch.parent_id)return navigate('gate',b.batch.id);return candidateDialog();}
  if(command==='demo'){demoStep=0;demoReturn=null;return navigate('demo');}
  if(command==='demo-step'){const step=Number(id);if(!Number.isInteger(step)||step<0||step>3)return;demoStep=step;return render();}
  if(command==='toggle-config'){showAllConfig=!showAllConfig;return render();}
  if(command==='evidence'){$('evidence-heading').scrollIntoView?.({behavior:'smooth',block:'start'});$('evidence-heading').focus();return;}
  if(command==='guide')return guide();
  if(command==='home')return navigate('work');
  if(command==='inspect'||command==='gate')return navigate(command==='inspect'?'inspector':'gate',id);
  if(command==='case'){selected=id;return render();}
  if(command==='gate-case'){selected=id;return navigate('inspector');}
  if(command==='new')return newDialog();
  if(command==='candidate'){if(id)current=id;return candidateDialog();}
  if(command==='review')return reviewDialog(id);
  if(command==='decision')return decisionDialog('pass');
  if(command==='return-fix')return decisionDialog('return_for_fix');
  if(command==='needs-evidence')return decisionDialog('needs_evidence');
  if(command==='archive-task')return decisionDialog('archive');
  if(command==='walk-history'){if(!archive)archive=await read('/api/archive');archiveSelected=archive.analysis.rows.find(r=>r.run_id.includes('F02'))?.run_id;return navigate('archive');}
  if(command==='export'){download(await read('/api/batches/'+current+'/export'),'评审审计记录_'+current+'.json');announce('已导出本批次记录；该文件不代表上线或不可篡改认证。');return;}
  const b=batch();let path,body,next;
  if(command==='quick'){path='/api/batches';body={name:'F02 · 构造口径排查',case_ids:['F02'],source:'constructed'};next='inspector';}
  else if(command==='note'){const text=$('case-note').value.trim();if(!text)throw new Error('请先填写笔记');path='/api/batches/'+current+'/notes';body={text,case_id:selected};}
  else if(['run','retry','reevaluate'].includes(command)){const why=reasonToRun(b,command);if(why)throw new Error(why);path='/api/batches/'+current+'/'+(command==='reevaluate'?'reevaluate':'run');body={revision:b.batch.revision,case_ids:[id],retry:command==='retry'};}
  else return;
  busy=true;try{const result=await api(path,body);if(command==='note')clearSubmittedDraft('note:'+current+':'+selected,body.text);if(next){current=result.batch_id;selected='F02';view=next;}await load();announce(command==='note'?'用例笔记已保存；检查结果不变。':command==='quick'?'构造任务已建立，尚未核验。':'任务已提交服务端；无自动重试。');}finally{busy=false;render();}
}
document.addEventListener('click',e=>{
  const trigger=e.target.closest('.help-trigger');
  document.querySelectorAll('.help-trigger[aria-expanded="true"]').forEach(b=>{if(b!==trigger){b.setAttribute('aria-expanded','false');if(b.parentElement)b.parentElement.dataset.dismissed='true';}});
  if(trigger){if(trigger.parentElement)delete trigger.parentElement.dataset.dismissed;trigger.setAttribute('aria-expanded',trigger.getAttribute('aria-expanded')==='true'?'false':'true');}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelectorAll('.help-trigger').forEach(b=>{b.setAttribute('aria-expanded','false');if(b.parentElement)b.parentElement.dataset.dismissed='true';});}});
for(const event of ['pointerover','focusin'])document.addEventListener(event,e=>{const wrap=e.target.closest('.help-wrap');if(wrap&&!wrap.contains(e.relatedTarget))delete wrap.dataset.dismissed;});
document.addEventListener('input',e=>{if(e.target.dataset.draft){storeDraft(e.target.dataset.draft,e.target.value);if(e.target.id==='case-note')$('draft-status').textContent=draftLabel(e.target.dataset.draft);}});
document.addEventListener('click',async e=>{const nav=e.target.closest('[data-view]');if(nav){if(!busy)try{await navigate(nav.dataset.view);}catch(err){announce(err.message);}return;}const target=e.target.closest('[data-action]');if(!target||target.disabled||busy)return;try{await action(target.dataset.action,target.dataset.id);}catch(err){announce(err.message);}});
document.addEventListener('submit',async e=>{const form=e.target;if(!['new-form','candidate-form','review-form','decision-form'].includes(form.id))return;e.preventDefault();if(busy||!validateForm(form))return;busy=true;const submit=form.querySelector('[type=submit]');submit.disabled=true;const values=Object.fromEntries(new FormData(form));try{let path,body,next=view;if(form.id==='new-form'){path='/api/batches';body={...values,case_ids:new FormData(form).getAll('case_ids')};next='inspector';}else if(form.id==='candidate-form'){path='/api/batches/'+form.dataset.base+'/candidate';body={...values,revision:Number(form.dataset.revision)};next='gate';}else if(form.id==='review-form'){path='/api/batches/'+current+'/reviews';body={...values,revision:Number(form.dataset.revision),evaluation_id:form.dataset.evaluation,check_key:form.dataset.key};}else{const pass=form.dataset.outcome==='pass';path='/api/batches/'+current+'/'+(pass?'decisions':'dispositions');body={...values,revision:Number(form.dataset.revision),...(pass?{}:{outcome:form.dataset.outcome})};}
  const result=await api(path,body);form.querySelectorAll('[data-draft]').forEach(el=>drafts.delete(el.dataset.draft));close();current=result.batch_id;view=next;await load();announce(form.id==='candidate-form'?'修复方案已建立，效果尚未验证。请按页面顶部的下一步继续。':'记录已保存。');
}catch(err){form.querySelector('.form-error').textContent=err.message;submit.disabled=false;}finally{busy=false;if(!$('modal').open)render();}});
document.addEventListener('change',e=>{if(e.target.id==='candidate-select'){current=e.target.value;render();}if(e.target.id==='archive-select'){archiveSelected=e.target.value;render();}});
$('refresh').addEventListener('click',async()=>{if(busy)return;try{await load(!$('modal').open);announce('已读取服务端记录；本机笔记草稿已保留。');}catch(err){announce(err.message);}});
$('modal-close').addEventListener('click',close);
$('modal').addEventListener('close',()=>{if(pendingRender)render();focusBeforeDialog?.focus?.();});
$('modal').addEventListener('click',e=>{if(e.target===$('modal')){const r=$('modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
setInterval(async()=>{if(polling||busy||!state?.batches.some(b=>b.cases.some(c=>c.active)))return;polling=true;try{const modalOpen=$('modal').open,editing=modalOpen||document.querySelector('[data-draft]:focus');await load(!editing);if(editing&&!modalOpen)refreshLiveResult();}catch(err){announce(err.message);}finally{polling=false;}},1800);
if(typeof window!=='undefined')window.addEventListener('beforeunload',e=>{if(volatileDrafts.size){e.preventDefault();e.returnValue='';}});
restoreSidebar();restoreRoute();load().catch(err=>{$('app').innerHTML='<section class="panel"><h1>暂时无法读取任务</h1><p>'+esc(err.message)+'</p><p>请确认服务可达后刷新，已有服务端记录不会因此删除。</p></section>';});
