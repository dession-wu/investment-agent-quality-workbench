"""Local image startup + persistent volume smoke test. No provider credentials/calls.
Creates and removes only its own random-name test container and volume.
"""
from pathlib import Path
from urllib.request import Request,build_opener,HTTPCookieProcessor
from http.cookiejar import CookieJar
from datetime import datetime,timezone
import json,subprocess,time,uuid

def docker(*args):
    return subprocess.run(['docker',*args],check=True,text=True,capture_output=True,encoding='utf-8').stdout.strip()

def run():
    suffix=uuid.uuid4().hex[:10]
    name='investment-v07-check-'+suffix
    volume=name+'-data'
    created=False
    volume_created=False
    try:
        docker('volume','create',volume);volume_created=True
        docker('run','-d','--name',name,'-p','127.0.0.1::8765','--mount','source='+volume+',target=/data','investment-agent-mvp:v0.8.2');created=True
        port=json.loads(docker('inspect','--format','{{json .NetworkSettings.Ports}}',name))['8765/tcp'][0]['HostPort']
        base='http://127.0.0.1:'+port
        opener=build_opener(HTTPCookieProcessor(CookieJar()))
        def get(path):
            with opener.open(base+path,timeout=3) as response:return json.load(response)
        def ready():
            deadline=time.monotonic()+25
            while True:
                try:return get('/api/health')
                except Exception:
                    if time.monotonic()>deadline:raise RuntimeError('容器未就绪')
                    time.sleep(.2)
        ready()
        initial=get('/api/state');assert not initial['configured']
        def post(path,body):
            req=Request(base+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())},method='POST')
            with opener.open(req,timeout=5) as response:return json.load(response)
        bid=post('/api/batches',{'name':'容器持久化验证','case_ids':['F02'],'source':'constructed'})['batch_id']
        post('/api/batches/'+bid+'/notes',{'text':'容器重启后必须仍在SQLite卷内'})
        before=get('/api/batches/'+bid)
        docker('restart',name)
        port=json.loads(docker('inspect','--format','{{json .NetworkSettings.Ports}}',name))['8765/tcp'][0]['HostPort']
        base='http://127.0.0.1:'+port
        ready()
        after=get('/api/batches/'+bid)
        assert before==after
        archive=get('/api/archive');assert len(archive['records'])==28
        assert get('/api/state')['session_calls']==0
        report={'version':'v0.8.2','checked_at':datetime.now(timezone.utc).isoformat(),'image_id':docker('image','inspect','--format','{{.Id}}','investment-agent-mvp:v0.8.2'),'image_user':docker('inspect','--format','{{.Config.User}}',name),'startup_http':'PASS','volume_write':'PASS','restart_restores_cookie_bound_batch_and_note':before==after,'archive_records':len(archive['records']),'provider_configured':False,'new_api_calls':0,'public_deployment':'NOT_RUN','browser':'NOT_RUN','test_container_and_volume':'removed in finally'}
        (Path(__file__).parent/'容器验证结果_v0.8.2.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2))
    finally:
        if created:docker('rm','-f',name)
        if volume_created:docker('volume','rm',volume)

if __name__=='__main__':run()
