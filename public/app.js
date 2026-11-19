'use strict';
const API_BASE = new URL('.',location.href).pathname.replace(/\/$/,'');
const request=(path,options)=>fetch(API_BASE+path,options);
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={task:'任务完成',numeric:'数值口径',risk:'必要风险',safety:'表达安全'};
let state=null,current=null,selected='F02',view='work',busy=false,polling=false,focusBeforeDialog=null,pendingRender=false;
const pendingKeys=new Map();
let archive=null,archiveSelected=null;
const stamp=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间':'—';
const pill=x=>`<span class="pill ${['PASS','FAIL','UNKNOWN'].includes(x)?x:''}">${esc(x)}</span>`;
const button=(label,action,id='',primary=false,disabled=false)=>`<button data-action="${action}" data-id="${esc(id)}" class="${primary?'primary':''}" ${disabled?'disabled':''}>${label}</button>`;
function announce(message){$('notice').textContent=message;}
function activeBatch(){return state?.batches.find(b=>b.batch.id===current);}
function jsonDetails(label,value){return `<details><summary>${esc(label)}</summary><pre>${esc(JSON.stringify(value,null,2))}</pre></details>`;}
async function api(path,body){
  const signature=path+JSON.stringify(body);
  if(!pendingKeys.has(signature))pendingKeys.set(signature,crypto.randomUUID());
  const response=await request(path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':pendingKeys.get(signature)},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok){pendingKeys.delete(signature);throw new Error(data.error||'提交失败');}
  pendingKeys.delete(signature);return data;
}
async function load(renderNow=true){
  const response=await request('/api/state');
  if(!response.ok)throw new Error('记录读取失败，请稍后刷新');
  state=await response.json();
  $('provider-status').textContent=state.provider+' · auto · '+state.global_calls_used+'/'+state.global_call_cap+' 次全局调用'+(state.configured?'':' · 未配置');
  if(current&&!activeBatch()){current=null;view='work';}
  if(renderNow)render();else pendingRender=true;
}
function render(){
  pendingRender=false;
  $('nav-work').classList.toggle('active',view==='work');$('nav-review').classList.toggle('active',view==='review');
  $('nav-archive').classList.toggle('active',view==='archive');
  if(!state)return;
  if(view==='work')work();else if(view==='archive')archiveView();else detail();
  if(view!=='archive')$('app').insertAdjacentHTML('afterbegin','<div class="notice">默认：百炼 Token Plan / auto · 低思考强度 / 禁用工具 · 单次1个变体 · 全局最多6次请求 · 不自动重试或切换供应商。auto不是固定Qwen型号，实际模型以返回记录为准。</div>');
  if(view==='review'&&(activeBatch()?.frozen.provider!==state.provider_id||activeBatch()?.frozen.postprocess_version!==state.postprocess_version))$('app').insertAdjacentHTML('afterbegin','<div class="warning">旧供应商或不兼容参数批次保持冻结，仅可查看历史及追加处理意见。请在工作台新建Token Plan批次。</div>');
  if(!state.configured)$('app').insertAdjacentHTML('afterbegin','<div class="warning">本部署未配置模型密钥，执行入口不可用。可新建冻结批次、保存意见、建立候选及查看真实历史实验；这些操作不产生模型调用。历史记录不是本次在线生成结果。</div>');
  if(state.provider_warning)$('app').insertAdjacentHTML('afterbegin',`<div class="warning">${esc(state.provider_warning.message)} 可先查看“历史实验”的既有真实记录，无需新调用。</div>`);
}
function archiveView(){
  if(!archive){$('app').innerHTML='<section class="empty">正在读取历史记录…</section>';return;}
  const rows=archive.analysis.rows;
  const row=rows.find(r=>r.run_id===archiveSelected)||rows[0];archiveSelected=row.run_id;
  const generation=archive.records[row.run_id],judge=archive.records['J-'+row.run_id];
  $('app').innerHTML=`<div class="page-head"><div><div class="eyebrow">EVIDENCE ARCHIVE / 03</div><h1>真实实验，原样留存</h1><p class="muted">v0.6 的既有调用 · v0.6.1 离线复核 · 只读查看</p></div>${pill('只读')}</div><div class="notice">这里展示既有28次调用：12条生成、16次裁判（含4条对照）。打开本页新增调用0次。构造输入、真实披露快照分别标记；不用于替代本版真实执行验收。</div><section class="panel"><h2>分组结果</h2><div class="table-wrap"><table><thead><tr><th>组别</th><th>变体达标 k/n</th><th>UNKNOWN</th><th>母题达标 k/n</th></tr></thead><tbody>${Object.entries(archive.analysis.groups).map(([k,g])=>`<tr><td>${k}</td><td>${g.pass}/${g.variants}</td><td>${g.unknown}</td><td>${g.pass_mothers}/${g.mothers}</td></tr>`).join('')}</tbody></table></div><p class="muted">A/B/C仅2母题3变体；D/E/REAL为独立单例。没有总体精度、普遍提升或统计显著性结论。</p></section><label for="archive-select">选择一条实际生成记录</label><select id="archive-select">${rows.map(r=>`<option value="${r.run_id}" ${r.run_id===row.run_id?'selected':''}>${r.run_id} · ${r.model} · ${r.overall}</option>`).join('')}</select><div class="grid subtle"><div class="column"><section class="panel"><h2>${esc(row.run_id)} ${pill(row.overall)}</h2><p>${row.source_mode==='snapshot'?'真实公开披露快照':'构造证据'} · 实际模型调用输出</p><div class="answer">${esc(row.answer)}</div><p>有效检查：${Object.entries(row.effective_checks).map(([k,v])=>esc(labels[k]||k)+' '+pill(v)).join(' ')}</p><p>${esc(row.numeric_verification.reason)}</p>${jsonDetails('原始生成请求与返回（既有记录）',generation)}${jsonDetails('原始裁判请求与返回（既有记录）',judge)}</section></div><div class="column"><section class="panel"><h2>证据边界</h2><ul>${archive.analysis.qualifications.map(x=>'<li>'+esc(x)+'</li>').join('')}</ul><p>16条裁判返回可解析JSON；全部已检查字段满足约束为15/16。四条设计对照符合预期不等于准确率。</p><p>历史记录不在本页编辑；需新执行时回工作台建立批次，不会把旧结果伪装成新调用。</p>${jsonDetails('单条复核及结构检查',row.judge_validation)}${jsonDetails('原始记录SHA256索引',archive.source_record_sha256)}</section></div></div>`;
}
function work(){
  const b=state.batches,blocked=b.filter(x=>x.blockers.length),running=b.filter(x=>x.cases.some(c=>c.active));
  $('app').innerHTML=`<div class="page-head"><div><div class="eyebrow">REVIEW OPERATIONS / 01</div><h1>让每一次评审，都有依据</h1><p class="muted">固定样例与参考基准，分别保留模型意见、规则结果和人工判断。</p></div>${button('＋ 新建评测','new','',true)}</div><div class="notice">本版覆盖 F02 / F07 · 2 个母题、3 个变体。构造参考证据，模型调用在服务端真实执行。刷新可恢复本浏览器会话记录。</div><div class="stats"><div class="stat"><small>当前会话批次</small><strong>${b.length}</strong><small>基线与候选分别留存</small></div><div class="stat"><small>范围仍有阻断</small><strong>${blocked.length}</strong><small>未知与未运行均不能通过</small></div><div class="stat"><small>执行中的批次</small><strong>${running.length}</strong><small>不会自动重试或切换模型</small></div></div><section class="panel"><div class="page-head"><h2>评测任务</h2><small>仅本浏览器会话 · 服务器持久保存</small></div>${b.length?`<div class="table-wrap"><table><thead><tr><th>批次 / 来源</th><th>冻结范围</th><th>配置</th><th>当前状态</th><th>下一步</th></tr></thead><tbody>${b.map(x=>`<tr><td><strong>${esc(x.batch.name)}</strong><br><small>${x.batch.source==='constructed'?'构造回答 · 原生成配置未知':'真实生成待执行 / 已执行见详情'}${x.batch.parent_id?' · 候选':''}</small><br><span class="mono">${esc(x.batch.id)}</span></td><td>${new Set(x.cases.map(c=>c.case.mother_id)).size} 母题 / ${x.cases.length} 变体<br><small>${x.cases.map(c=>c.case.id).join(' / ')}</small></td><td><span class="mono">${esc(x.batch.source==='constructed'?'来源模型未知':x.frozen.generation_model)}</span><br><small>${esc(x.frozen.generation_data)} · 参考 ${esc(x.frozen.reference.id)}</small></td><td>${x.cases.some(c=>c.active)?'<span class="progress loading">执行中…</span>':pill(x.blockers.length?(x.cases.some(c=>c.overall==='FAIL')?'FAIL':'UNKNOWN'):'PASS')}<br><small>${x.blockers.length} 个变体阻断</small></td><td>${button('查看并评审','open',x.batch.id)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><h3>从一条口径问题开始</h3><p>载入 F02 构造回答，核验“45%”究竟属于单季还是累计。</p>'+button('建立首个评测','new','',true)+'</div>'}</section><details><summary>本版覆盖与限制</summary><ul>${state.limits.map(x=>'<li>'+esc(x)+'</li>').join('')}</ul><p>清除 Cookie 或换浏览器将创建新会话；不提供账号恢复。全局累计最多6次模型请求（跨会话与重启保留），价格未核验，不显示估算费用。</p></details>`;
}
function detail(){
  const b=activeBatch();
  if(!b){view='work';return work();}
  const row=b.cases.find(x=>x.case.id===selected)||b.cases[0];selected=row.case.id;
  const parent=state.batches.find(x=>x.batch.id===b.batch.parent_id);
  const parentRow=parent?.cases.find(x=>x.case.id===selected);
  const legacy=b.frozen.provider!==state.provider_id||b.frozen.judge_parameters?.enable_thinking===false||b.frozen.postprocess_version!==state.postprocess_version;
  const unrun=b.cases.filter(c=>!c.runs.length),active=b.cases.some(c=>c.active);
  const remaining=Math.max(0,state.global_call_cap-state.global_calls_used),need=b.batch.source==='generated'?2:1;
  const cannotRun=legacy||active||!state.configured||busy;
  $('app').innerHTML=`<div class="page-head"><div><div class="eyebrow">VERSION REVIEW / 02</div><h1>${esc(b.batch.name)}</h1><p class="muted">修订 ${b.batch.revision} · ${b.cases.length} 个冻结变体 · ${b.batch.source==='constructed'?'构造回答，原始生成配置未知':'新生成配置 '+esc(b.frozen.generation_model)}</p></div><div class="actions">${button('执行下一未运行项','run-all','',true,!unrun.length||cannotRun||remaining<need)}<small>全局剩余 ${remaining} 次；执行本项最多需 ${need} 次，重评需1次</small>${!parent?button('建立关联候选','candidate','',false,busy||legacy):button('查看基线','open',parent.batch.id)}</div></div><div class="notice">${parent?'候选完整继承基线范围与评测基准；未执行项不继承基线 PASS。':'参考与样例已冻结；评估已有构造回答只调用裁判，不冒充真实生成。'} ${active?'<span class="loading">任务正在服务端执行，刷新不会取消。少量历史请求约10–15秒，实际可能更久；超时将保留UNKNOWN，不自动重试。</span>':''}${remaining<need?' 当前额度不足以启动本项；可继续查看记录、保存意见。':''}</div><label for="batch-select">切换任务 / 候选</label><select id="batch-select">${state.batches.map(x=>`<option value="${x.batch.id}" ${x.batch.id===current?'selected':''}>${esc(x.batch.name+' · '+x.batch.id)}</option>`).join('')}</select><div class="case-tabs">${b.cases.map(c=>`<button data-action="case" data-id="${c.case.id}" class="${c.case.id===selected?'selected':''}">${c.case.id} ${c.active?'执行中':c.overall}</button>`).join('')}</div><div class="grid"><div class="column"><section class="panel"><div class="actions"><h2>${esc(row.case.id)} · 案例与回答</h2>${pill(row.overall)}</div><p>${esc(row.case.question)}</p><small>问答时点 ${esc(row.case.question_as_of)} · 风险承受能力 ${esc(row.case.profile.risk_tolerance)}</small>${parentRow?`<div class="pair"><div><h3>基线回答</h3><small>${esc(parentRow.answer?.source||'尚未生成')}</small><div class="answer">${esc(parentRow.answer?.text||'尚无回答')}</div></div><div><h3>候选回答</h3><small>${row.answer?'实际生成 · '+esc(b.frozen.generation_model):'尚未生成'}</small><div class="answer">${esc(row.answer?.text||'未执行项，不沿用旧回答')}</div></div></div>`:`<div class="answer">${esc(row.answer?.text||'尚未生成；执行后将在此保存实际输出')}</div><small>回答来源：${esc(row.answer?.source||'未执行')}</small>`}${row.active?'<p class="progress loading">服务端执行中… 请求结果将自动更新。</p>':''}${button('只执行此项','run-one',row.case.id,false,!!row.runs.length||cannotRun||remaining<need)} ${button('重新评估已有回答（1次请求）','reevaluate',row.case.id,false,!row.answer||!row.runs.length||cannotRun||remaining<1)} ${row.runs.length&&['failed','incomplete','interrupted'].includes(row.runs.at(-1).status)?button('明确重试此失败项','retry',row.case.id,false,cannotRun||remaining<need):''}${jsonDetails('用户条件与问题信息',row.case)}</section><section class="panel"><h2>检查结果与人工复核</h2><p class="muted">数值规则核验裁判提取的声明，语义项仍依赖裁判。UNKNOWN 不能直接改为通过。</p><div class="table-wrap"><table><thead><tr><th>必检项</th><th>原始有效结果</th><th>人工后有效结果</th><th>操作</th></tr></thead><tbody>${Object.entries(row.effective_checks).map(([key,value])=>`<tr><td>${labels[key]||key}</td><td>${pill(row.evaluation?.raw_checks[key]||'UNKNOWN')}</td><td>${pill(value)}</td><td>${button('追加复核','review',key,false,legacy||!row.evaluation||row.active||row.runs.at(-1)?.status!=='completed'||busy)}</td></tr>`).join('')}</tbody></table></div>${row.failure_context?'<p class="warning">接口执行未完成，质量未知；'+esc(row.failure_context.error||row.failure_context.status)+'。HTTP状态：'+esc(row.failure_context.http_status??'未取得')+'；耗时：'+esc(row.failure_context.latency_seconds??'未记录')+'秒。</p>'+jsonDetails('失败运行证据',row.failure_context):''}${row.evaluation?jsonDetails('裁判原意见、规则依据与结构校验',row.evaluation.detail):'<p class="muted">尚无评估记录；未运行不等于通过。</p>'}${row.reviews.length?'<h3>当前评估的人工复核记录</h3>'+row.reviews.map(r=>`<div class="record"><p>${esc(labels[r.check_key])} → ${pill(r.target)}</p><p>${esc(r.reason)}</p><small>${stamp(r.created_at)} · ${esc(r.evidence_id)}</small></div>`).join(''):''}</section><section class="panel"><h2>证据与实际运行轨迹</h2><p>参考：${esc(b.frozen.reference.id)} · 构造证据 · 单季 8.2% / 累计 45%</p><p>${esc(b.frozen.reference.risk)}</p>${jsonDetails('冻结参考证据',b.frozen.reference)}${jsonDetails('生成配置及生成证据（与评测参考分列）',{model:b.frozen.generation_model,prompt:b.frozen.prompt,data:b.frozen.generation_data,evidence:b.frozen.generation_evidence})}${row.runs.length?row.runs.map(r=>`<details><summary>${r.kind==='generation'?'生成':'裁判'} · ${esc(r.status)} · ${esc(r.error||r.result?.model||'等待中')}</summary><p class="mono">${esc(r.id)} · ${stamp(r.started_at)}</p><pre>${esc(JSON.stringify({request:r.request,result:r.result,error:r.error},null,2))}</pre></details>`).join(''):'<p class="muted">本项尚无实际请求，不展示虚构调用节点。</p>'}</section></div><div class="column"><section class="panel"><h2>固定范围评审</h2><p>${b.blockers.length?pill('UNKNOWN')+' 仍有 '+b.blockers.length+' 个变体阻断':pill('PASS')+' 当前范围无阻断'}</p>${b.blockers.length?'<ul>'+b.blockers.map(x=>'<li>'+esc(x.case_id+'：'+x.reason)+'</li>').join('')+'</ul>':'<p>可以记录本范围进入下一轮的决定。</p>'}<label for="note-text">处理意见</label><textarea id="note-text" placeholder="记录调查依据或下一步；保存意见不会解除阻断"></textarea><div class="actions subtle">${button('保存处理意见','note','',false,busy)}${button('记录范围通过决定','decision','',true,legacy||!!b.blockers.length||busy||b.decisions.some(d=>d.valid))}</div><small>意见与决定分别追加保存。意见不改变评估修订；判断变化会使旧决定失效。</small>${b.notes.length?'<h3>已保存处理意见 · 服务端</h3>'+b.notes.map(n=>`<div class="record"><p>${esc(n.text)}</p><small>${stamp(n.created_at)} · 依据修订 ${n.revision}</small></div>`).join(''):''}${b.decisions.length?'<h3>范围决定</h3>'+b.decisions.map(d=>`<div class="record"><p>${d.valid?'有效 · 进入下一轮':'已失效 · 依据发生变化'}</p><p>${esc(d.reason)}</p><small>${stamp(d.created_at)} · 依据修订 ${d.revision}</small></div>`).join(''):''}</section><section class="panel"><h2>比较边界</h2><p>${b.cases.length} 变体 / ${new Set(b.cases.map(c=>c.case.mother_id)).size} 母题</p><p class="muted">生成模型、Prompt、生成数据可建立候选比较；评测参考与裁判保持冻结。构造回答与新生成的差异不作为模型提升率。</p><small>评测基准摘要</small><p class="mono">${esc(b.batch.benchmark_hash)}</p>${parent?'<p>与基线基准 '+(b.batch.benchmark_hash===parent.batch.benchmark_hash?'一致':'不一致，不得直接比较')+'</p>':''}${jsonDetails('操作历史（追加记录）',b.events)}</section></div></div>`;
}
function show(title,body){focusBeforeDialog=document.activeElement;$('modal-title').textContent=title;$('modal-body').innerHTML=body;const form=$('modal-body').querySelector('form');if(form&&activeBatch())form.dataset.revision=activeBatch().batch.revision;$('modal').showModal();}
function closeDialog(){$('modal').close();focusBeforeDialog?.focus?.();}
function scopeOptions(cases,defaultAll=true){return cases.map((c,i)=>`<label class="check-label"><input type="checkbox" name="case_ids" value="${c.id}" ${defaultAll||i===0?'checked':''}><span>${c.id} · ${esc(c.profile.risk_tolerance)} · ${esc(c.question)}</span></label>`).join('');}
function modelOptions(selectedModel){return state.models.map(m=>`<option ${m===selectedModel?'selected':''}>${esc(m)}</option>`).join('');}
function newDialog(){show('新建评测',`<form id="new-form"><p class="muted">先冻结范围和参考，再执行。当前不会自动调用模型。</p><label for="batch-name">批次名称</label><input id="batch-name" name="name" value="F02 口径排查" maxlength="80" required><label>样例范围</label>${scopeOptions(state.templates.cases,false)}<label for="source">回答来源</label><select id="source" name="source"><option value="constructed">核验预置构造回答（每项 1 次裁判请求）</option><option value="generated">真实生成后核验（每项 2 次请求）</option></select><label for="model">生成模型 / 后续重跑模板</label><select id="model" name="model">${modelOptions(state.models[0])}</select><label for="prompt">生成 Prompt / 后续重跑模板</label><textarea id="prompt" name="prompt" maxlength="3000" required>${esc(state.templates.prompts.P1)}</textarea><small>构造回答的原生成配置保持未知；这里选择的模板不追认其来源。</small><p class="form-error" role="alert"></p><div class="form-foot"><button class="primary" type="submit">建立冻结批次</button></div></form>`);}
function candidateDialog(){const b=activeBatch();show('建立关联候选',`<form id="candidate-form"><p>冻结范围仍是 ${b.cases.map(c=>c.case.id).join(' / ')}。本次只选择部分执行时，其余项仍阻断范围决定。</p><label for="candidate-name">候选名称</label><input id="candidate-name" name="name" value="${esc(b.batch.name+' · 候选')}" maxlength="80" required><label for="candidate-model">生成模型</label><select id="candidate-model" name="model">${modelOptions(b.frozen.generation_model)}</select><label for="candidate-prompt">生成 Prompt</label><textarea id="candidate-prompt" name="prompt" maxlength="3000" required>${esc(state.templates.prompts.P2)}</textarea><label for="generation-data">生成证据</label><select id="generation-data" name="generation_data"><option value="D1">D1 · 完整且显式定义口径</option><option value="D2-missing-single-quarter">D2 · 移除单季值及其定义</option></select><p class="muted">改变生成证据不会修改评测参考。建立候选不会立即扣费，请在候选页选择执行范围。</p><p class="form-error" role="alert"></p><div class="form-foot"><button type="submit" class="primary">建立候选批次</button></div></form>`);}
function reviewDialog(key){const b=activeBatch(),row=b.cases.find(c=>c.case.id===selected);show('追加人工复核 · '+labels[key],`<form id="review-form" data-key="${key}" data-evaluation="${row.evaluation.id}"><p>当前结果 ${pill(row.effective_checks[key])}。人工意见仅针对此评估，原始裁判意见不覆盖。</p><label for="review-target">复核结论</label><select id="review-target" name="target"><option value="FAIL">确认存在问题 / FAIL</option><option value="UNKNOWN">仍待核验 / UNKNOWN</option><option value="PASS">判为误报并通过 / PASS</option></select><label for="review-reason">依据与理由</label><textarea id="review-reason" name="reason" maxlength="2000" required></textarea><label for="evidence-id">绑定冻结参考证据 ID</label><input id="evidence-id" name="evidence_id" value="${esc(b.frozen.reference.id)}" required><p class="form-error" role="alert"></p><div class="form-foot"><button type="submit" class="primary">追加复核记录</button></div></form>`);}
async function runAction(action,id){
  const b=activeBatch();let response;
  if(action==='new')return newDialog();
  if(action==='open'){current=id;view='review';selected=activeBatch().cases[0].case.id;return render();}
  if(action==='case'){selected=id;return render();}
  if(b&&['candidate','review','decision','run-all','run-one','retry','reevaluate'].includes(action)&&(b.frozen.provider!==state.provider_id||b.frozen.judge_parameters?.enable_thinking===false||b.frozen.postprocess_version!==state.postprocess_version))throw new Error('旧配置批次仅可查看和保存处理意见');
  if(action==='candidate')return candidateDialog();
  if(action==='review')return reviewDialog(id);
  if(action==='decision'){show('记录固定范围决定',`<form id="decision-form"><p>仅对本次 ${b.cases.length} 个变体、当前修订 ${b.batch.revision} 记录进入下一轮评审，不是生产发布。</p><label for="decision-reason">评审依据与限制</label><textarea id="decision-reason" name="reason" maxlength="2000" required></textarea><p class="form-error" role="alert"></p><div class="form-foot"><button type="submit" class="primary">保存范围决定</button></div></form>`);return;}
  busy=true;
  try{
    if(action==='note'){
      const value=$('note-text').value;
      response=await api(`/api/batches/${current}/notes`,{text:value});
      $('note-text').value='';
      announce('处理意见已保存到服务端；不解除阻断，刷新后可恢复。');
    }else if(['run-all','run-one','retry','reevaluate'].includes(action)){
      const ids=action==='run-all'?b.cases.filter(c=>!c.runs.length).slice(0,1).map(c=>c.case.id):[id];
      response=await api(`/api/batches/${current}/${action==='reevaluate'?'reevaluate':'run'}`,{revision:b.batch.revision,case_ids:ids,retry:action==='retry'});
      announce('已安排 '+ids.length+' 个变体；每项最多 '+(b.batch.source==='generated'&&action!=='reevaluate'?2:1)+' 次请求，无自动重试。');
    }
    await load();
  }finally{const draft=$('note-text')?.value;busy=false;render();if(draft&&$('note-text'))$('note-text').value=draft;}
}
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target||busy)return;
  if(['note','run-all','run-one','retry','reevaluate'].includes(target.dataset.action))target.disabled=true;
  try{await runAction(target.dataset.action,target.dataset.id);}catch(error){announce(error.message);}
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!['new-form','candidate-form','review-form','decision-form'].includes(form.id))return;
  event.preventDefault();if(busy)return;busy=true;
  const submit=form.querySelector('[type=submit]');submit.disabled=true;form.querySelector('.form-error').textContent='';
  try{
    const values=Object.fromEntries(new FormData(form));let response;
    if(form.id==='new-form')response=await api('/api/batches',{...values,case_ids:new FormData(form).getAll('case_ids')});
    if(form.id==='candidate-form')response=await api(`/api/batches/${current}/candidate`,{...values,revision:Number(form.dataset.revision)});
    if(form.id==='review-form')response=await api(`/api/batches/${current}/reviews`,{...values,check_key:form.dataset.key,evaluation_id:form.dataset.evaluation,revision:Number(form.dataset.revision)});
    if(form.id==='decision-form')response=await api(`/api/batches/${current}/decisions`,{...values,revision:Number(form.dataset.revision)});
    closeDialog();current=response.batch_id;view='review';await load();announce('记录已保存。');
  }catch(error){form.querySelector('.form-error').textContent=error.message;submit.disabled=false;}
  finally{busy=false;}
});
document.addEventListener('change',event=>{if(event.target.id==='batch-select'){current=event.target.value;selected=activeBatch().cases[0].case.id;render();}if(event.target.id==='archive-select'){archiveSelected=event.target.value;render();}});
$('refresh').addEventListener('click',()=>load().then(()=>announce('已从服务端重新读取记录。')).catch(e=>announce(e.message)));
$('nav-work').addEventListener('click',()=>{view='work';render();});
$('nav-review').addEventListener('click',()=>{if(!current&&state?.batches.length)current=state.batches[0].batch.id;if(current){view='review';render();}else announce('请先建立评测批次。');});
$('nav-archive').addEventListener('click',async()=>{try{if(!archive){const response=await request('/api/archive');if(!response.ok)throw new Error('历史实验读取失败');archive=await response.json();}view='archive';render();}catch(e){announce(e.message);}});
$('modal-close').addEventListener('click',closeDialog);
$('modal').addEventListener('close',()=>{if(pendingRender){const draft=$('note-text')?.value;render();if(draft&&$('note-text'))$('note-text').value=draft;}focusBeforeDialog?.focus?.();});
$('modal').addEventListener('click',event=>{if(event.target===$('modal')){const r=$('modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
$('modal').addEventListener('cancel',()=>{focusBeforeDialog?.focus?.();});
// Poll only active server work. Do not replace a form or erase a note being typed.
setInterval(async()=>{
  if(polling||busy||!state?.batches.some(b=>b.cases.some(c=>c.active)))return;
  polling=true;
  try{const draft=$('note-text')?.value;const canRender=!$('modal').open&&!draft;await load(canRender);}catch(e){announce(e.message);}finally{polling=false;}
},1800);
load().catch(e=>{$('app').innerHTML='<section class="empty">服务端暂不可用，请确认服务已启动，然后刷新记录。</section>';announce(e.message);});
