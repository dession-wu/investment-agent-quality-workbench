# Explicit live check: may perform up to three billable model requests.
from pathlib import Path
from datetime import datetime,timezone
import json,time
from playwright.sync_api import sync_playwright,expect
APP=Path(__file__).resolve().parent;ROOT=APP.parents[1];OUT=APP/'公网完整走查';OUT.mkdir(exist_ok=True)
checks=[]
def check(n,v=True):assert v,n;checks.append(n)
BASE='https://podnotes.cloud/investment/'
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1440,'height':1000});page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(BASE,wait_until='networkidle');before=ctx.request.get(BASE+'api/state').json();check('latest public live configured',before['version']=='v1.0.0' and before['configured'])
    page.get_by_role('button',name='开始质量排查',exact=True).click()
    page.locator('#new-form input[value=F02]').uncheck();page.locator('#new-form button[type=submit]').click();expect(page.locator('#case-selection-error')).to_contain_text('至少选择');check('empty selection Chinese inline validation')
    page.locator('#new-form input[value=F02]').check();page.locator('#new-form input[name=name]').fill('最终演示·财务口径核验');page.locator('#new-source').select_option('constructed');page.locator('#new-form button[type=submit]').click();expect(page.locator('.pending-result')).to_be_visible()
    state=ctx.request.get(BASE+'api/state').json();baseline=state['batches'][0]['batch']['id'];check('create task makes zero model calls',state['global_calls_used']==before['global_calls_used'])
    page.locator('#app button.primary:visible').click();expect(page.locator('.check-list')).to_be_visible(timeout=150000)
    state=ctx.request.get(BASE+'api/state').json();b=next(b for b in state['batches'] if b['batch']['id']==baseline);check('baseline real evaluation persisted',bool(b['cases'][0].get('evaluation')))
    page.screenshot(path=str(OUT/'01_原回答真实核验.png'),full_page=True)
    page.locator('#notes-drawer>summary').click() if not page.locator('#notes-drawer').evaluate('(e)=>e.open') else None
    page.locator('#case-note').fill('单季8.2%与累计45%不能混用；修复要求先明确指标期间，保留不确定性。');page.get_by_role('button',name='保存问题记录，继续编写修复方案',exact=True).click();expect(page.locator('#candidate-form')).to_be_visible()
    page.locator('#candidate-form input[name=name]').fill('最终演示·区分单季与累计');page.locator('#candidate-form button[type=submit]').click();expect(page.locator('.regression-results')).to_be_visible();check('candidate freezes scope and remains pending','未运行' in page.locator('.regression-results').inner_text())
    state=ctx.request.get(BASE+'api/state').json();candidate=next(b['batch']['id'] for b in state['batches'] if b['batch']['parent_id']==baseline)
    page.locator('#app button.primary:visible').click();expect(page.locator('.check-list')).to_be_visible(timeout=150000)
    state=ctx.request.get(BASE+'api/state').json();c=next(b for b in state['batches'] if b['batch']['id']==candidate);check('candidate generated answer and real evaluation persisted',c['cases'][0]['answer']['source']=='generated' and bool(c['cases'][0]['evaluation']))
    page.screenshot(path=str(OUT/'02_候选真实核验.png'),full_page=True)
    page.locator('#nav-gate').click();expect(page.locator('.regression-results')).to_be_visible();page.locator('#config-drawer>summary').click();check('configuration comparison readable',page.locator('.config-diff').is_visible())
    page.screenshot(path=str(OUT/'03_回归比较.png'),full_page=True)
    page.locator('#decision-drawer>summary').click()
    if not c['blockers']:
        page.get_by_role('button',name='批准本测试范围',exact=True).click();outcome='pass'
    else:
        page.get_by_role('button',name='记录待补证',exact=True).click();outcome='needs_evidence'
    page.locator('#decision-form textarea[name=reason]').fill('依据本次真实调用与固定F02参考，仅记录当前测试范围结论；不代表生产发布或总体准确率。');page.locator('#decision-form button[type=submit]').click();expect(page.locator('#modal')).not_to_be_visible()
    page.reload(wait_until='networkidle');check('saved conclusion survives public refresh',('已记录' in page.locator('.task-cue').inner_text()) or '待补证' in page.locator('body').inner_text())
    page.locator('summary').filter(has_text='导出与比较边界').click()
    with page.expect_download() as download:page.get_by_role('button',name='导出候选审计记录',exact=True).click()
    download.value.save_as(str(OUT/'真实候选审计导出.json'));check('audit JSON download succeeds',(OUT/'真实候选审计导出.json').stat().st_size>100)
    page.locator('#nav-archive').click();expect(page.locator('#archive-select')).to_be_visible();check('historical archive remains read only',len(ctx.request.get(BASE+'api/archive').json()['records'])==28)
    other=browser.new_context();other.new_page().goto(BASE,wait_until='networkidle');check('separate browser session cannot see created tasks',not any(b['batch']['id']==baseline for b in other.request.get(BASE+'api/state').json()['batches']));other.close()
    after=ctx.request.get(BASE+'api/state').json();check('paid calls stay within planned three',0<after['global_calls_used']-before['global_calls_used']<=3);check('no page errors',not errors)
    ctx.storage_state(path=str(ROOT/'work/final-video-session.private.json'))
    (ROOT/'work/final-video-targets.json').write_text(json.dumps({'baseline':baseline,'candidate':candidate,'outcome':outcome}),encoding='utf-8')
    report={'version':'v1.0.0','checked_at':datetime.now(timezone.utc).isoformat(),'surface':'ACTUAL_PUBLIC_HTTPS_EDGE_WITH_REAL_PROVIDER','checks_passed':len(checks),'checks':checks,'paid_calls_before':before['global_calls_used'],'paid_calls_after':after['global_calls_used'],'new_paid_calls':after['global_calls_used']-before['global_calls_used'],'baseline_id':baseline,'candidate_id':candidate,'baseline_overall':b['cases'][0]['overall'],'candidate_overall':c['cases'][0]['overall'],'candidate_blockers':c['blockers'],'recorded_outcome':outcome,'baseline_runs':b['cases'][0]['runs'],'candidate_runs':c['cases'][0]['runs'],'page_errors':errors,'limits':['single constructed F02 case, not overall accuracy','browser automation, not usability study','no real-time MCP or independent expert gold label']}
    (APP/'公网真实主链路验收_v1.0.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:v for k,v in report.items() if k not in ['baseline_runs','candidate_runs']},ensure_ascii=True));browser.close()

