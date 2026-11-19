from pathlib import Path
import sys,threading,tempfile,time,json,urllib.request
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright,expect
APP=Path(__file__).resolve().parent;ROOT=APP.parent.parent;OUT=APP/'浏览器验证_模拟模型';OUT.mkdir(exist_ok=True)
sys.path.insert(0,str(APP))
from server import Application,make_server
from test_mvp import FakeClient
class ControlledFake(FakeClient):
    def __init__(self):super().__init__();self.proceed=threading.Event();self.proceed.set();self.calls=0
    def call(self,payload):
        self.calls+=1
        assert self.proceed.wait(18),'Local test gate timed out'
        return super().call(payload)
def public_count():
    req=urllib.request.Request('https://podnotes.cloud/investment/api/state',headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)['global_calls_used']
before=public_count();checks=[]
def check(label,condition=True):assert condition,label;checks.append(label)
with tempfile.TemporaryDirectory() as tmp:
    client=ControlledFake();app=Application(Path(tmp)/'test.sqlite3',client);server=make_server(app,port=0)
    threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True)
            context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page();errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(url,wait_until='networkidle')
            def shot(name):page.screenshot(path=str(OUT/(name+'.png')),full_page=True)
            def primary():return page.locator('#app button.primary:visible')
            def create(source='generated',name='交互走查',multi=False):
                page.locator('#nav-work').click()
                page.locator('button[data-action=new]').first.click()
                page.locator('#new-form input[name=name]').fill(name)
                page.locator('#new-source').select_option(source)
                if multi:page.locator('#new-form input[value=F07A]').check()
                page.locator('#new-form button[type=submit]').click()
                page.locator('.result-section').wait_for()
            create(name='多用例首次核验',multi=True)
            check('unrun has exactly one visible strong action',primary().count()==1)
            check('unrun hides matrix and review',not page.locator('.check-list').is_visible() and not page.get_by_role('button',name='追加复核',exact=True).count())
            check('empty generation comparison and notes are collapsed',not page.locator('#evidence-drawer').evaluate('(e)=>e.open') and not page.locator('#notes-drawer').evaluate('(e)=>e.open'))
            shot('01_首次进入_桌面')
            client.proceed.clear();primary().click()
            expect(page.locator('.running-result')).to_be_visible(timeout=8000)
            check('original batch run disables its only primary',primary().is_disabled())
            shot('02_运行中_桌面')
            page.locator('#notes-drawer>summary').click();page.locator('#case-note').fill('运行中保留草稿，不丢失光标。')
            page.locator('#case-note').focus();client.proceed.set()
            expect(page.locator('.check-list')).to_be_visible(timeout=12000)
            check('polling result updates even while note editor focused',page.locator('#result-heading').inner_text()=='核验结果')
            check('polling preserves draft and editor focus',page.locator('#case-note').input_value()=='运行中保留草稿，不丢失光标。' and page.locator('#case-note').evaluate('(e)=>document.activeElement===e'))
            shot('03_结果优先_桌面')
            page.locator('button[data-action=case][data-id=F07A]').click()
            expect(page.locator('.pending-result')).to_be_visible()
            check('switching to unrun case does not inherit previous pass',page.locator('.task-cue').inner_text().find('F07A')>=0 and '尚未开始核验' in page.locator('.result-section').inner_text())
            check('other case completion does not auto-run next case',client.calls==2)
            page.set_viewport_size({'width':390,'height':844});shot('04_首次进入_窄屏')
            check('inspector narrow emulated device has no overflow',not page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            page.set_viewport_size({'width':1440,'height':1000})
            create(source='constructed',name='修复候选与回归')
            page.locator('#notes-drawer>summary').click();page.locator('#case-note').fill('累计与单季口径不同，修复需明确期间。')
            page.locator('button[data-action=note-next]').click();page.locator('#candidate-form').wait_for()
            page.locator('#candidate-form button[type=submit]').click();page.locator('.regression-results').wait_for()
            check('candidate creation leads directly to pending regression',primary().inner_text().startswith('核验下一个用例'))
            check('gate puts regression above configuration',page.locator('.regression-results').bounding_box()['y']<page.locator('#config-drawer').bounding_box()['y'])
            check('gate configuration and decision controls are initially collapsed',not page.locator('#config-drawer').evaluate('(e)=>e.open') and not page.locator('#decision-drawer').evaluate('(e)=>e.open'))
            shot('05_回归待核验_桌面')
            primary().click();expect(page.locator('.check-list')).to_be_visible(timeout=12000)
            primary().click();expect(page.locator('.regression-results')).to_be_visible()
            check('all-pass gate leads to an explicit range decision','记录本范围通过结论' in primary().inner_text())
            expect(primary()).to_be_enabled();shot('06_回归通过_桌面')
            page.set_viewport_size({'width':390,'height':844});shot('07_回归通过_窄屏')
            check('gate narrow emulated device has no overflow',not page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            page.set_viewport_size({'width':1440,'height':1000})
            primary().click();page.locator('#decision-form textarea[name=reason]').fill('仅本次构造F02固定范围通过，不授权真实生产发布。')
            page.locator('#decision-form button[type=submit]').click();expect(page.locator('.task-cue')).to_contain_text('已记录本测试范围通过结论')
            primary().click();check('view conclusion opens saved decision history',page.locator('#decision-drawer').evaluate('(e)=>e.open'))
            page.reload(wait_until='networkidle');check('saved conclusion survives reload','已记录本测试范围通过结论' in page.locator('.task-cue').inner_text())
            create(source='constructed',name='失败状态走查');primary().click();expect(page.locator('.check-list')).to_be_visible(timeout=12000)
            check('failure gives record-and-repair action','记录问题，继续修复' in primary().inner_text())
            check('failure automatically opens evidence',page.locator('#evidence-drawer').evaluate('(e)=>e.open'))
            shot('08_失败与证据_桌面');primary().click();check('record action opens notes',page.locator('#notes-drawer').evaluate('(e)=>e.open'))
            client.invalid=True;create(source='constructed',name='未知状态走查');primary().click();expect(page.locator('.check-list')).to_be_visible(timeout=12000)
            check('invalid judge stays unknown and points to missing evidence','证据不足以判断' in page.locator('.task-cue').inner_text())
            shot('09_未知状态_桌面')
            check('no page script errors',not errors)
            browser.close()
    finally:client.proceed.set();server.shutdown();server.server_close();app.close()
after=public_count()
check('public paid call counter unchanged',after==before)
report={'version':'v1.0.0','checked_at':datetime.now(timezone.utc).isoformat(),'surface':'ACTUAL_HEADLESS_EDGE_DOM_LOCAL_HTTP_SQLITE_WITH_EXPLICIT_FAKE_MODEL','paid_provider_calls':0,'simulated_model_calls':client.calls,'public_paid_counter_before':before,'public_paid_counter_after':after,'browser_scenarios_passed':len(checks),'checks':checks,'viewports':['1440x1000','390x844'],'page_errors':errors,'limits':['headless Edge only','not physical mobile','simulated results do not prove model quality','not a demo video']}
(APP/'浏览器交互验证_v1.0.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=True))
