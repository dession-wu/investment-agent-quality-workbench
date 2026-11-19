from pathlib import Path
from datetime import datetime,timezone
import json
from playwright.sync_api import sync_playwright,expect
APP=Path(__file__).resolve().parent;checks=[]
def check(n,v=True):assert v,n;checks.append(n)
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1440,'height':1000});page=ctx.new_page();errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)));base='https://podnotes.cloud/investment/'
    page.goto(base,wait_until='networkidle');before=ctx.request.get(base+'api/state').json()
    check('public latest configured and uncapped',before['version']=='v0.9.2' and before['configured'] and before['global_call_cap'] is None and before['session_call_cap'] is None)
    check('new logo loads publicly',page.locator('.brand-logo').evaluate('(e)=>e.complete&&e.naturalWidth>0'))
    check('no quota request anonymous badge',all(t not in page.locator('body').inner_text() for t in ['核验额度','核验请求','匿名会话']))
    page.screenshot(path=str(APP/'品牌与导航验证/05_公网首页_桌面.png'),full_page=True)
    page.locator('#nav-toggle').click();page.reload(wait_until='networkidle');check('public collapsed state persists',page.locator('#nav-toggle').get_attribute('aria-expanded')=='false')
    page.locator('#nav-archive').focus();page.keyboard.press('Enter');expect(page.locator('#archive-select')).to_be_visible();check('public keyboard icon navigation works')
    page.locator('#nav-work').click();page.get_by_role('button',name='开始质量排查',exact=True).click();page.locator('#new-form input[name=name]').fill('导航验收·未运行');page.locator('#new-form button[type=submit]').click()
    expect(page.locator('.pending-result')).to_be_visible();expect(page.locator('#app button.primary:visible')).to_be_enabled();check('public former exhausted counter no longer disables manual run')
    page.set_viewport_size({'width':390,'height':844});page.locator('#nav-work').click();page.locator('#nav-toggle').click();page.screenshot(path=str(APP/'品牌与导航验证/06_公网导航_窄屏.png'),full_page=True)
    check('public narrow viewport no page overflow',not page.evaluate('document.documentElement.scrollWidth>innerWidth'))
    check('all four public nav modules visible',page.locator('#primary-nav button:visible').count()==4)
    after=ctx.request.get(base+'api/state').json();check('public call counter unchanged',before['global_calls_used']==after['global_calls_used']);check('no page errors',not errors);browser.close()
report={'version':'v0.9.2','checked_at':datetime.now(timezone.utc).isoformat(),'surface':'ACTUAL_PUBLIC_HTTPS_HEADLESS_EDGE','checks_passed':len(checks),'checks':checks,'new_paid_calls':0,'calls_before':before['global_calls_used'],'calls_after':after['global_calls_used'],'created_tasks':1,'run_button_clicked':False,'page_errors':errors,'limitations':['no additional live model invocation','not physical mobile','screenshots not a continuous video']}
(APP/'公网浏览器验收_v0.9.2.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=True))
