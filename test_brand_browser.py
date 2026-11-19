from pathlib import Path
import tempfile,threading,sys,json
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright,expect
APP=Path(__file__).resolve().parent;ROOT=APP.parents[1];OUT=APP/'品牌与导航验证';OUT.mkdir(exist_ok=True)
sys.path.insert(0,str(APP))
from server import Application,make_server,PROVIDER
from test_mvp import FakeClient
checks=[]
def check(name,value=True):assert value,name;checks.append(name)
with tempfile.TemporaryDirectory() as tmp:
    app=Application(Path(tmp)/'test.sqlite3',FakeClient())
    with app.db() as db:db.execute('UPDATE provider_budget SET used=999999 WHERE provider=?',(PROVIDER,))
    srv=make_server(app,port=0);threading.Thread(target=srv.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(srv.server_port)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1440,'height':1000});page=ctx.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)));page.goto(base,wait_until='networkidle')
            check('vector brand image loaded',page.locator('.brand-logo').evaluate('(e)=>e.complete&&e.naturalWidth>0'))
            check('favicon serves SVG',ctx.request.get(base+'/brand-mark.svg').headers['content-type']=='image/svg+xml')
            check('name and subtitle use stacked lockup',page.locator('.brand-copy').evaluate('(e)=>getComputedStyle(e).flexDirection')=='column')
            body=page.locator('body').inner_text();check('no quota/request/session badges',all(t not in body for t in ['核验额度','核验请求','匿名会话']))
            check('nav has four icons and no numeric prefixes',page.locator('#primary-nav .nav-icon').count()==4 and all(not text[:1].isdigit() for text in page.locator('#primary-nav button').all_text_contents()))
            page.screenshot(path=str(OUT/'01_展开导航_桌面.png'),full_page=True)
            expanded=page.locator('.app-sidebar').bounding_box()['width'];page.locator('#nav-toggle').click()
            expect(page.locator('#nav-toggle')).to_have_attribute('aria-expanded','false')
            page.wait_for_timeout(250)
            check('collapsed sidebar is narrower and all labels hidden',page.locator('.app-sidebar').bounding_box()['width']<expanded and page.locator('.nav-label:visible').count()==0)
            page.locator('#nav-archive').hover();check('collapsed hover exposes module name',page.locator('#nav-archive').evaluate('(e)=>getComputedStyle(e,"::after").display')=='block')
            page.screenshot(path=str(OUT/'02_收起导航_桌面.png'),full_page=True)
            page.reload(wait_until='networkidle');check('collapse persists across reload',page.locator('#nav-toggle').get_attribute('aria-expanded')=='false')
            page.locator('#nav-archive').focus();check('collapsed keyboard focus exposes module name',page.locator('#nav-archive').evaluate('(e)=>getComputedStyle(e,"::after").display')=='block')
            page.keyboard.press('Enter');expect(page.locator('#archive-select')).to_be_visible();check('icon-only keyboard navigation works',page.locator('#nav-archive').get_attribute('aria-current')=='page')
            page.locator('#nav-work').click();page.locator('#nav-toggle').click();page.get_by_role('button',name='开始质量排查',exact=True).click();page.locator('#new-form button[type=submit]').click()
            expect(page.locator('.pending-result')).to_be_visible();check('historical usage does not disable run button',page.locator('#app button.primary:visible').is_enabled())
            page.locator('#app button.primary:visible').click();expect(page.locator('.check-list')).to_be_visible(timeout=12000)
            state=ctx.request.get(base+'/api/state').json();check('uncapped dispatch executes despite very high audit counter',state['global_calls_used']==1000001 and state['global_call_cap'] is None and state['session_call_cap'] is None)
            page.set_viewport_size({'width':390,'height':844});page.locator('#nav-work').click();page.screenshot(path=str(OUT/'03_展开导航_窄屏.png'),full_page=True)
            check('mobile expanded has no document overflow',not page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            page.locator('#nav-toggle').click();page.screenshot(path=str(OUT/'04_收起导航_窄屏.png'),full_page=True)
            check('mobile collapsed keeps four accessible navigation buttons',page.locator('#primary-nav button:visible').count()==4)
            check('mobile collapsed has no document overflow',not page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            page.locator('#nav-gate').click();check('collapsed mobile navigation remains clickable',page.locator('#nav-gate').get_attribute('aria-current')=='page')
            check('no page script errors',not errors)
            browser.close()
    finally:srv.shutdown();srv.server_close();app.close()
report={'version':'v0.9.2','checked_at':datetime.now(timezone.utc).isoformat(),'surface':'ACTUAL_HEADLESS_EDGE_WITH_LOCAL_HTTP_SQLITE_AND_EXPLICIT_FAKE_MODEL','checks_passed':len(checks),'checks':checks,'simulated_calls':2,'paid_calls':0,'page_errors':errors,'viewports':['1440x1000','390x844'],'limitations':['not physical mobile','no paid provider call made']}
(APP/'品牌导航与无限次策略验证_v0.9.2.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=True))

