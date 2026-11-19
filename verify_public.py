"""Real HTTPS workflow check of the keyless public deployment; no provider calls."""
from pathlib import Path
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError
from http.cookiejar import CookieJar
from datetime import datetime,timezone
import json,uuid

BASE='https://podnotes.cloud/investment'
opener=build_opener(HTTPCookieProcessor(CookieJar()))
def request(path,body=None,client=opener):
    headers={'User-Agent':'Mozilla/5.0','Origin':'https://podnotes.cloud'}
    if body is not None:headers.update({'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())})
    req=Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    with client.open(req,timeout=20) as r:
        raw=r.read();return (json.loads(raw) if 'application/json' in r.headers.get('Content-Type','') else raw.decode()),r.status
def post(path,body):return request(path,body)[0]
checks={}
page,status=request('/')
assert status==200 and './app.js' in page and '0.7.4' in page;checks['public_html_relative_assets']='PASS'
for path in ['/app.js','/style.css']:
    _,status=request(path);assert status==200
state,_=request('/api/state');assert state['version']=='v0.7.4' and not state['configured'];used=state['global_calls_used']
bid=post('/api/batches',{'name':'公网HTTPS验收 · 匿名构造F02','case_ids':['F02'],'source':'constructed'})['batch_id']
post('/api/batches/'+bid+'/notes',{'text':'公网验收意见：只验证匿名测试记录保存与恢复，不解除UNKNOWN阻断。'})
snap,_=request('/api/batches/'+bid)
assert len(snap['notes'])==1 and snap['blockers'] and snap['cases'][0]['overall']=='UNKNOWN';checks['create_note_and_reload_read']='PASS'
candidate=post('/api/batches/'+bid+'/candidate',{'revision':snap['batch']['revision'],'name':'公网验收 · P2关联候选','prompt':state['templates']['prompts']['P2'],'model':'auto','generation_data':'D1'})['batch_id']
cand,_=request('/api/batches/'+candidate)
assert cand['batch']['benchmark_hash']==snap['batch']['benchmark_hash'] and cand['blockers'];checks['candidate_freezes_benchmark']='PASS'
try:
    post('/api/batches/'+bid+'/run',{'revision':snap['batch']['revision'],'case_ids':['F02']})
    raise AssertionError('Keyless execution unexpectedly accepted')
except HTTPError as e:assert e.code==409
checks['keyless_execution_blocks_before_provider']='PASS'
try:
    request('/api/batches/'+bid,client=build_opener(HTTPCookieProcessor(CookieJar())))
    raise AssertionError('Cross session read allowed')
except HTTPError as e:assert e.code==404
checks['session_isolation']='PASS'
archive,_=request('/api/archive');assert len(archive['records'])==28;checks['real_history_archive']='PASS'
final,_=request('/api/state');assert final['global_calls_used']==used;checks['provider_calls_unchanged']='PASS'
for path in ['/server.py','/.env','/work/qwen-token-plan.local.json']:
    try:request(path);raise AssertionError('Private path exposed')
    except HTTPError as e:assert e.code==404
checks['private_paths_not_served']='PASS'
with opener.open(Request('https://podnotes.cloud/',headers={'User-Agent':'Mozilla/5.0'}),timeout=20) as r:assert r.status==200
checks['existing_homepage_reachable']='PASS'
report={'version':'v0.7.4','checked_at':datetime.now(timezone.utc).isoformat(),'url':BASE+'/','surface':'ACTUAL_PUBLIC_HTTPS_HTTP_CLIENT_NOT_BROWSER','checks':checks,'global_calls_before':used,'global_calls_after':final['global_calls_used'],'configured':False,'new_paid_calls':0,'browser_visual':'NOT_VERIFIED','limitation':'Reload verified by subsequent HTTPS GET with same cookie, not a real browser F5. Public instance has no model credentials.'}
(Path(__file__).parent/'公网验收结果_v0.7.4.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
