# Public browser check; creates a test task but never submits model requests.
from pathlib import Path
import json
from playwright.sync_api import sync_playwright,expect
APP=Path(__file__).resolve().parent;ROOT=APP.parents[1];checks=[];BASE='https://podnotes.cloud/investment/'
def check(n,v=True):assert v,n;checks.append(n)
with sync_playwright() as p:
    b=p.chromium.launch(channel='msedge',headless=True);ctx=b.new_context(viewport={'width':1440,'height':1000});page=ctx.new_page();page.goto(BASE,wait_until='networkidle');before=ctx.request.get(BASE+'api/state').json()['global_calls_used']
    page.get_by_role('button',name='开始质量排查',exact=True).click();page.locator('#new-form input[value=F02]').uncheck();page.locator('#new-form input[value=F07A]').check();page.locator('#new-form input[value=F07B]').check();page.locator('#new-source').select_option('constructed');page.locator('#new-form input[name=name]').fill('验收·画像与草稿恢复');page.locator('#new-form button[type=submit]').click();expect(page.locator('.pending-result')).to_be_visible()
    page.locator('#notes-drawer>summary').click();page.locator('#case-note').fill('未提交草稿：激进画像不能省略必要风险。');page.reload(wait_until='networkidle');page.locator('#notes-drawer>summary').click();check('unsaved draft restored after refresh',page.locator('#case-note').input_value().startswith('未提交草稿'))
    page.locator('button[data-action=note-next]').click();page.locator('#modal-close').click();page.reload(wait_until='networkidle');page.locator('#notes-drawer>summary').click();check('saved note persists on server','激进画像不能' in page.locator('#notes-drawer').inner_text())
    page.locator('button[data-action=case][data-id=F07B]').click();check('switching profile does not inherit other draft',page.locator('#case-note').input_value()=='')
    page.locator('#evidence-drawer>summary').click() if not page.locator('#evidence-drawer').evaluate('(e)=>e.open') else None
    check('aggressive profile shows same fixed 8.2 and 45 facts','8.2%' in page.locator('#evidence-drawer').inner_text() and '45%' in page.locator('#evidence-drawer').inner_text())
    check('profile page retains required risk reference','18%' in page.locator('#evidence-drawer').inner_text());check('unrun profile not misrepresented as passed',page.locator('.pending-result').is_visible())
    page.get_by_role('button',name='使用指南',exact=True).click();expect(page.locator('#modal')).to_be_visible();page.keyboard.press('Escape');expect(page.locator('#modal')).not_to_be_visible();check('guide dialog opens and Escape closes')
    after=ctx.request.get(BASE+'api/state').json()['global_calls_used'];check('no new model calls',after==before);b.close()
report={'version':'v1.0.0','surface':'ACTUAL_PUBLIC_EDGE_NO_MODEL_DISPATCH','checks_passed':len(checks),'checks':checks,'calls_before':before,'calls_after':after,'created_tasks':1,'new_paid_calls':0,'limits':['profile content and persistence checked; no new F07 model quality conclusion']}
(APP/'公网草稿与画像补充验收_v1.0.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=True))

