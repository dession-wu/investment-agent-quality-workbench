from pathlib import Path
import sys,tempfile,threading,json
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright,expect
APP=Path(__file__).resolve().parent;ROOT=APP.parents[1];OUT=APP/'浏览器验证';OUT.mkdir(exist_ok=True)
sys.path.insert(0,str(APP))
from server import Application,make_server
from test_mvp import FakeClient
checks=[];measurements=[]
def check(n,v=True):assert v,n;checks.append(n)
with tempfile.TemporaryDirectory() as d:
    app=Application(Path(d)/'data.sqlite3',FakeClient());srv=make_server(app,port=0);threading.Thread(target=srv.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(srv.server_port)
    ext=Path(d)/'extension';ext.mkdir();(ext/'manifest.json').write_text(json.dumps({'manifest_version':3,'name':'Zoom test only','version':'1.0','permissions':['tabs'],'background':{'service_worker':'background.js'}}));(ext/'background.js').write_text('chrome.runtime.onInstalled.addListener(()=>{});')
    try:
        with sync_playwright() as p:
            ctx=p.chromium.launch_persistent_context(str(Path(d)/'profile'),channel='msedge',headless=True,ignore_default_args=['--disable-extensions'],no_viewport=True,args=['--window-size=1440,1000','--disable-extensions-except='+str(ext),'--load-extension='+str(ext)])
            page=ctx.pages[0];errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(base,wait_until='networkidle')
            worker=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
            for z in [.8,1,1.25,1.5]:
                actual=worker.evaluate('async z=>{let t=(await chrome.tabs.query({active:true}))[0];await chrome.tabs.setZoom(t.id,z);return await chrome.tabs.getZoom(t.id)}',z);page.wait_for_timeout(250)
                metrics=page.evaluate('({inner:innerWidth,dpr:devicePixelRatio,sidebar:document.querySelector("aside").getBoundingClientRect().width,cols:getComputedStyle(document.querySelector(".task-navigation")).gridTemplateColumns,nav:getComputedStyle(document.querySelector("#primary-nav")).display,bodyWidth:document.body.getBoundingClientRect().width})')
                print(metrics,flush=True);check(str(int(z*100))+'% actual browser zoom preserves desktop columns',abs(actual-z)<.01 and abs(metrics['sidebar']-224)<1 and metrics['nav']=='grid' and len(metrics['cols'].split())==4)
                measurements.append({'browser_zoom':actual,**metrics});page.screenshot(path=str(OUT/(str(int(z*100))+'pct_桌面布局.png')),full_page=True)
            worker.evaluate('async()=>{let t=(await chrome.tabs.query({active:true}))[0];await chrome.tabs.setZoom(t.id,1)}');page.wait_for_timeout(250)
            check('clear full product name',page.locator('.brand-copy strong').inner_text()=='投资 Agent 质量治理平台')
            page.locator('#nav-toggle').click();page.reload(wait_until='networkidle');check('collapsed navigation survives refresh',page.locator('#nav-toggle').get_attribute('aria-expanded')=='false')
            page.locator('#nav-archive').focus();page.keyboard.press('Enter');expect(page.locator('#archive-select')).to_be_visible();check('keyboard navigation reaches historical archive')
            ctx.close()
            b=p.chromium.launch(channel='msedge',headless=True);mobile=b.new_context(viewport={'width':390,'height':844},screen={'width':390,'height':844},is_mobile=True,has_touch=True);mp=mobile.new_page();mp.goto(base,wait_until='networkidle')
            check('physical narrow screen uses mobile navigation',mp.locator('#primary-nav').evaluate('(e)=>getComputedStyle(e).gridTemplateColumns.split(" ").length')==2)
            check('mobile full title stays inside viewport',mp.locator('.brand').bounding_box()['width']<390 and not mp.evaluate('document.documentElement.scrollWidth>innerWidth'))
            mp.screenshot(path=str(OUT/'移动设备_390.png'),full_page=True);b.close();check('no script errors',not errors)
    finally:srv.shutdown();srv.server_close();app.close()
report={'version':'v1.0.0','checked_at':datetime.now(timezone.utc).isoformat(),'surface':'ACTUAL_HEADLESS_EDGE_BROWSER_ZOOM_VIA_TEMP_TEST_EXTENSION','checks_passed':len(checks),'checks':checks,'zoom_measurements':measurements,'new_paid_calls':0,'extension_scope':'temporary isolated test profile only; not installed in user browser','limitations':['headless Edge','narrow-device emulation, not physical handset']}
(APP/'品牌与真实浏览器缩放验证_v1.0.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=True))

