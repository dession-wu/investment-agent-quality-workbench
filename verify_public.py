"""Actual public HTTPS contract verification, not real browser clicks. No provider calls."""
from pathlib import Path
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError,URLError
from http.cookiejar import CookieJar
from datetime import datetime,timezone
import json,uuid,time
BASE='https://podnotes.cloud/investment'
client=build_opener(HTTPCookieProcessor(CookieJar()))
def req(path,body=None,opener=client):
    headers={'User-Agent':'Mozilla/5.0','Origin':'https://podnotes.cloud'}
    if body is not None:headers.update({'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())})
    # Reuse one idempotency key across transport retries; never retry HTTP errors.
    for attempt in range(3):
        try:
            with opener.open(Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,headers=headers),timeout=20) as r:
                raw=r.read();return json.loads(raw) if 'application/json' in r.headers.get('Content-Type','') else raw.decode()
        except HTTPError:raise
        except (URLError,TimeoutError):
            if attempt==2:raise
            time.sleep(.5)
checks={}
page=req('/');assert 'v0.8.2' in page and 'nav-inspector' in page and 'nav-gate' in page;checks['four_view_public_entry']='PASS'
for path in ['/app.js','/style.css']:assert len(req(path))>100
state=req('/api/state');assert state['version']=='v0.8.2' and not state['configured'];used=state['global_calls_used']
bid=req('/api/batches',{'name':'v0.8.2 HTTPS验收 · F02构造','case_ids':['F02'],'source':'constructed'})['batch_id']
before=req('/api/batches/'+bid);assert before['cases'][0]['workflow_status']=='UNRUN'
req('/api/batches/'+bid+'/notes',{'case_id':'F02','text':'接口验收笔记；不解除未知阻断。'})
snapshot=req('/api/batches/'+bid)
assert snapshot['notes'][-1]['case_id']=='F02' and snapshot['batch']['revision']==before['batch']['revision'] and snapshot['blockers']==before['blockers'];checks['case_note_persists_and_does_not_unblock']='PASS'
candidate=req('/api/batches/'+bid+'/candidate',{'revision':snapshot['batch']['revision'],'name':'v0.8.2 HTTPS候选','prompt':state['templates']['prompts']['P2'],'model':'auto','generation_data':'D1'})['batch_id']
c=req('/api/batches/'+candidate);assert c['batch']['parent_id']==bid and c['batch']['benchmark_hash']==snapshot['batch']['benchmark_hash'] and c['cases'][0]['workflow_status']=='UNRUN';checks['candidate_is_frozen_and_unrun']='PASS'
req('/api/batches/'+candidate+'/dispositions',{'revision':c['batch']['revision'],'outcome':'needs_evidence','reason':'演示无密钥，记录待核验，不制造通过。'})
updated=req('/api/batches/'+candidate);assert updated['dispositions'][-1]['outcome']=='needs_evidence' and updated['blockers']==c['blockers'];checks['needs_evidence_audit_without_override']='PASS'
req('/api/batches/'+candidate+'/dispositions',{'revision':updated['batch']['revision'],'outcome':'return_for_fix','reason':'记录修复动作，检查仍未运行。'})
updated=req('/api/batches/'+candidate);assert updated['dispositions'][-1]['outcome']=='return_for_fix';checks['return_for_fix_audit']='PASS'
req('/api/batches/'+candidate+'/dispositions',{'revision':updated['batch']['revision'],'outcome':'archive','reason':'接口验收结束；保留全部原始记录。'})
exported=req('/api/batches/'+candidate+'/export');assert len(exported['snapshot']['dispositions'])==3 and exported['snapshot']['cases'][0]['overall']=='UNKNOWN' and 'session_id' not in exported['snapshot']['batch'];checks['archive_and_audit_export']='PASS'
for path,body in [('/api/batches/'+candidate+'/run',{'revision':c['batch']['revision'],'case_ids':['F02']}),('/api/batches/'+candidate+'/decisions',{'revision':c['batch']['revision'],'reason':'must be blocked'})]:
    try:req(path,body);raise AssertionError('Must reject')
    except HTTPError as e:assert e.code==409
checks['keyless_execution_and_unknown_approval_blocked']='PASS'
other=build_opener(HTTPCookieProcessor(CookieJar()))
try:req('/api/batches/'+candidate+'/export',opener=other);raise AssertionError('Cross session export')
except HTTPError as e:assert e.code==404
checks['export_session_isolation']='PASS'
try:req('/api/batches/'+bid+'/notes',{'case_id':'F07A','text':'invalid scope'});raise AssertionError('Invalid scope')
except HTTPError as e:assert e.code==400
checks['note_case_scope_guard']='PASS'
assert len(req('/api/archive')['records'])==28;checks['readonly_28_calls']='PASS'
for path in ['/server.py','/.env','/data/investment.sqlite3']:
    try:req(path);raise AssertionError('Private path exposed')
    except HTTPError as e:assert e.code==404
checks['private_paths_not_served']='PASS'
final=req('/api/state');assert final['global_calls_used']==used;checks['no_provider_calls']='PASS'
with client.open(Request('https://podnotes.cloud/',headers={'User-Agent':'Mozilla/5.0'}),timeout=20) as r:assert r.status==200
checks['homepage_unaffected']='PASS'
report={'version':'v0.8.2','checked_at':datetime.now(timezone.utc).isoformat(),'url':BASE+'/','surface':'ACTUAL_PUBLIC_HTTPS_HTTP_CLIENT_NOT_BROWSER','checks':checks,'global_calls_before':used,'global_calls_after':final['global_calls_used'],'new_paid_calls':0,'browser_visual':'NOT_VERIFIED','video':'NOT_RECORDED'}
(Path(__file__).parent/'公网验收结果_v0.8.2.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
