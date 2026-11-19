"""Read-only online checks. Never submits a paid run."""
from pathlib import Path
from urllib.request import Request,build_opener,HTTPCookieProcessor
from urllib.error import HTTPError
from http.cookiejar import CookieJar
from datetime import datetime,timezone
import json
BASE='https://podnotes.cloud/investment/'
def main():
    opener=build_opener(HTTPCookieProcessor(CookieJar()))
    def get(path):
        with opener.open(Request(BASE+path,headers={'User-Agent':'Mozilla/5.0'}),timeout=20) as r:return r.read()
    before=json.loads(get('api/state'))
    assert before['version']=='v0.9.0' and before['configured']
    index=get('').decode();script=get('app.js').decode()
    assert '问衡' in index and 'QA <' not in index and 'v0.' not in index
    assert 'Token Plan' not in script and '百炼' not in script
    assert json.loads(get('api/health'))['version']=='v0.9.0'
    assert len(json.loads(get('api/archive'))['records'])==28
    for path in ['server.py','.env','qwen-token-plan.local.json','investment.sqlite3']:
        try:
            get(path)
            raise AssertionError('Private path accessible')
        except HTTPError as e:assert e.code in {403,404}
    after=json.loads(get('api/state'));assert after['global_calls_used']==before['global_calls_used']
    report={'version':'v0.9.0','checked_at':datetime.now(timezone.utc).isoformat(),'surface':'READ_ONLY_ACTUAL_PUBLIC_HTTPS_NOT_BROWSER','brand':'PASS','health':'PASS','model_configured':True,'archive_28':'PASS','private_paths':'BLOCKED','new_paid_calls':0,'calls_before':before['global_calls_used'],'calls_after':after['global_calls_used']}
    (Path(__file__).parent/'公网只读验收_v0.9.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=True))
if __name__=='__main__':main()
