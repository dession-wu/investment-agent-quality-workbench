"""Real HTTP + SQLite tests with an explicitly simulated provider. No paid API calls."""
from pathlib import Path
from urllib.request import Request, urlopen, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError
from http.cookiejar import CookieJar
import json, tempfile, threading, time, unittest, uuid
from unittest.mock import patch
from io import BytesIO
from server import Application, ModelClient, Problem, make_server, evaluate, PROVIDER, CALL_CAP
from numeric import quantitative, value_in_quote

class FakeClient(ModelClient):
    def __init__(self):
        super().__init__({'api_key': 'test-secret-not-a-real-key'})
        self.fail = False
        self.invalid = False
    def call(self, payload):
        if self.fail:
            return 'failed', {'latency_seconds': 0}, 'TIMEOUT'
        data = json.loads(payload['input'][0]['content'][0]['text'])
        if 'answer' not in data:
            answer = '第三季度单季扣非净利润同比增长8.2%。应收逾期18%，可能增加回款与减值压力。' if 'single_quarter' in data['generation_evidence'] else '未提供单季数据，无法核实所求增长率。'
            return 'completed', {'text': answer, 'model': payload['model'], 'usage': {'total_tokens': 1}, 'finish_reason': 'stop'}, None
        answer = data['answer']
        if self.invalid:
            result = 'not json'
        else:
            value = '45' if '45%' in answer else '8.2' if '8.2%' in answer else None
            checks = {k: 'PASS' for k in data['required_checks']}
            if value == '45': checks['numeric'] = 'FAIL'
            if value is None: checks['numeric'] = 'UNKNOWN'
            if 'risk' in checks and '18%' not in answer: checks['risk'] = 'FAIL'
            claim = {'entity': 'DEMO_A', 'metric': 'single_quarter_yoy', 'period': '2026Q3', 'scope': 'consolidated', 'currency': 'CNY', 'value': value, 'unit': '%', 'quote': answer}
            result = json.dumps({'checks': checks, 'reason': '模拟裁判，仅用于测试', 'quotes': [answer], 'claims': [claim] if value else []}, ensure_ascii=False)
        return 'completed', {'text': result, 'model': payload['model'], 'usage': {'total_tokens': 1}, 'finish_reason': 'stop'}, None

class MVPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)/'test.sqlite3'
        self.client = FakeClient()
        self.app = Application(self.path, self.client)
        self.sid, _ = self.app.session(None)
    def tearDown(self):
        self.app.close()
        self.tmp.cleanup()
    def write(self, path, body, sid=None, token=None):
        return self.app.write(sid or self.sid, path, body, token or str(uuid.uuid4()))
    def create(self, ids=None, source='generated'):
        return self.write('/api/batches', {'name': '测试批次', 'case_ids': ids or ['F02'], 'source': source})['batch_id']
    def get(self, bid, sid=None):
        return self.app.read(sid or self.sid, '/api/batches/'+bid)
    def action(self, bid, action, body=None):
        return self.write('/api/batches/'+bid+'/'+action, {'revision': self.get(bid)['batch']['revision'], **(body or {})})
    def run_cases(self, bid, ids):
        for cid in ids:
            self.action(bid, 'run', {'case_ids': [cid]})
            deadline = time.monotonic()+5
            while any(c['active'] for c in self.get(bid)['cases']):
                if time.monotonic() > deadline: self.fail('模拟任务未及时结束')
                time.sleep(.01)
        return self.get(bid)

    def test_01_generated_chain_and_trace(self):
        bid = self.create()
        snap = self.run_cases(bid, ['F02'])
        self.assertFalse(snap['blockers'])
        self.assertEqual([r['kind'] for r in snap['cases'][0]['runs']], ['generation', 'judge'])
        self.assertEqual(snap['cases'][0]['answer']['source'], 'generated')
        self.assertEqual(self.app.read(self.sid, '/api/state')['session_calls'], 2)
        self.assertNotIn('test-secret-not-a-real-key', json.dumps(snap))

    def test_02_constructed_is_judged_not_generated(self):
        bid = self.create(source='constructed')
        snap = self.run_cases(bid, ['F02'])
        self.assertEqual(snap['cases'][0]['overall'], 'FAIL')
        self.assertEqual([r['kind'] for r in snap['cases'][0]['runs']], ['judge'])
        self.assertEqual(snap['cases'][0]['answer']['source'], 'constructed')

    def test_03_partial_candidate_keeps_scope_and_blocks_decision(self):
        base = self.create(['F02', 'F07A', 'F07B'], 'constructed')
        cid = self.action(base, 'candidate')['batch_id']
        partial = self.run_cases(cid, ['F02'])
        self.assertEqual(len(partial['blockers']), 2)
        self.assertEqual(partial['batch']['benchmark_hash'], self.get(base)['batch']['benchmark_hash'])
        with self.assertRaises(Problem): self.action(cid, 'decisions', {'reason': '不应通过'})
        final = self.run_cases(cid, ['F07A', 'F07B'])
        self.assertFalse(final['blockers'])
        self.action(cid, 'decisions', {'reason': '冻结范围完成'})
        self.assertTrue(self.get(cid)['decisions'][0]['valid'])

    def test_04_note_does_not_change_revision_or_decision(self):
        bid = self.create()
        self.run_cases(bid, ['F02'])
        self.action(bid, 'decisions', {'reason': '已检查'})
        rev = self.get(bid)['batch']['revision']
        self.action(bid, 'notes', {'text': '<script>仅作为正文</script>'})
        snap = self.get(bid)
        self.assertEqual(snap['batch']['revision'], rev)
        self.assertTrue(snap['decisions'][0]['valid'])
        self.assertEqual(len(snap['notes']), 1)

    def test_05_review_append_stales_decision_and_preserves_raw(self):
        bid = self.create()
        snap = self.run_cases(bid, ['F02'])
        self.action(bid, 'decisions', {'reason': '通过'})
        ev = snap['cases'][0]['evaluation']['id']
        self.action(bid, 'reviews', {'evaluation_id': ev, 'check_key': 'safety', 'target': 'FAIL', 'reason': '人工提出待调查问题', 'evidence_id': snap['frozen']['reference']['id']})
        snap = self.get(bid)
        self.assertFalse(snap['decisions'][0]['valid'])
        self.assertEqual(snap['cases'][0]['evaluation']['raw_checks']['safety'], 'PASS')
        self.assertEqual(snap['cases'][0]['effective_checks']['safety'], 'FAIL')

    def test_06_sqlite_restart_restores_notes_reviews_decisions(self):
        bid = self.create()
        snap = self.run_cases(bid, ['F02'])
        self.action(bid, 'notes', {'text': '刷新后保留'})
        self.action(bid, 'reviews', {'evaluation_id': snap['cases'][0]['evaluation']['id'], 'check_key': 'safety', 'target': 'PASS', 'reason': '人工检查安全表达', 'evidence_id': snap['frozen']['reference']['id']})
        self.action(bid, 'decisions', {'reason': '可进入下一轮'})
        self.app.close()
        self.app = Application(self.path, self.client)
        self.assertEqual(self.app.session(self.sid), (self.sid, False))
        snap = self.get(bid)
        self.assertEqual(snap['notes'][0]['text'], '刷新后保留')
        self.assertEqual(len(snap['cases'][0]['reviews']), 1)
        self.assertTrue(snap['decisions'][0]['valid'])

    def test_07_submission_idempotency_and_collision(self):
        token = str(uuid.uuid4())
        body = {'name': '去重', 'case_ids': ['F02']}
        a = self.write('/api/batches', body, token=token)
        b = self.write('/api/batches', body, token=token)
        self.assertEqual(a, b)
        self.assertEqual(len(self.app.read(self.sid, '/api/state')['batches']), 1)
        with self.assertRaises(Problem): self.write('/api/batches', {**body, 'name': '另一操作'}, token=token)

    def test_08_session_isolation_all_routes(self):
        bid = self.create()
        other, _ = self.app.session(None)
        with self.assertRaises(Problem): self.get(bid, other)
        with self.assertRaises(Problem): self.write('/api/batches/'+bid+'/notes', {'text': '越权'}, sid=other)
        self.assertEqual(self.app.read(other, '/api/state')['batches'], [])

    def test_09_optimistic_revision_conflict(self):
        bid = self.create()
        with self.assertRaises(Problem): self.write('/api/batches/'+bid+'/run', {'revision': 0, 'case_ids': ['F02']})

    def test_10_timeout_is_execution_failure_quality_unknown(self):
        self.client.fail = True
        bid = self.create()
        snap = self.run_cases(bid, ['F02'])
        self.assertEqual(snap['cases'][0]['runs'][0]['error'], 'TIMEOUT')
        self.assertEqual(snap['cases'][0]['overall'], 'UNKNOWN')
        self.assertIsNone(snap['cases'][0]['answer'])
        self.assertEqual(self.app.read(self.sid, '/api/state')['session_calls'], 1)
        with self.assertRaises(Problem): self.action(bid, 'run', {'case_ids': ['F02']})

    def test_11_invalid_judge_json_and_unknown_cannot_bypass(self):
        self.client.invalid = True
        bid = self.create()
        snap = self.run_cases(bid, ['F02'])
        self.assertEqual(snap['cases'][0]['overall'], 'UNKNOWN')
        ev = snap['cases'][0]['evaluation']['id']
        body = {'evaluation_id': ev, 'check_key': 'numeric', 'target': 'FAIL', 'reason': '人工调查', 'evidence_id': snap['frozen']['reference']['id']}
        self.action(bid, 'reviews', body)
        with self.assertRaises(Problem): self.action(bid, 'reviews', {**body, 'target': 'PASS'})

    def test_12_data_axis_changes_generation_not_reference(self):
        bid = self.create()
        cid = self.action(bid, 'candidate', {'generation_data': 'D2-missing-single-quarter'})['batch_id']
        snap = self.run_cases(cid, ['F02'])
        self.assertEqual(snap['cases'][0]['overall'], 'UNKNOWN')
        self.assertNotIn('single_quarter', snap['frozen']['generation_evidence'])
        self.assertIn('single_quarter', snap['frozen']['reference'])
        self.assertEqual(self.get(bid)['batch']['benchmark_hash'], snap['batch']['benchmark_hash'])

    def test_13_restart_marks_inflight_interrupted_without_retry(self):
        bid = self.create()
        with self.app.db() as db:
            db.execute("INSERT INTO runs(id,batch_id,case_id,kind,status,started_at) VALUES('manual',?,'F02','generation','running','test')", (bid,))
        self.app.close()
        self.app = Application(self.path, self.client)
        snap = self.get(bid)
        self.assertEqual(snap['cases'][0]['runs'][0]['status'], 'interrupted')
        self.assertEqual(snap['cases'][0]['overall'], 'UNKNOWN')
        self.assertEqual(self.app.read(self.sid, '/api/state')['session_calls'], 0)

    def test_14_numeric_leading_dot_rounding_units_and_precision(self):
        b = {'entity': 'A', 'metric': 'yoy', 'period': 'Q3', 'scope': 'group', 'unit': '%'}
        for value, expected, status in [('+.05','0.05','PASS'),('-.5','-0.5','PASS'),('8.231','8.234','FAIL'),('8.234','8.234','PASS'),('8.23','8.234','PASS'),('-8.24','-8.235','PASS'),('','0','UNKNOWN')]:
            with self.subTest(value=value): self.assertEqual(quantitative({**b,'value':value},{**b,'value':expected},{'mode':'round','places':2}),status)
        self.assertTrue(value_in_quote('.05', '同比为.05%'))
        self.assertFalse(value_in_quote('8.2', '同比为18.2%'))
        b.update(currency='CNY',unit='亿元')
        self.assertEqual(quantitative({**b,'value':'1.23456'},{**b,'unit':'万元','value':'12345.6'},{'mode':'round','places':2}),'PASS')
        b['unit']='元'
        self.assertEqual(quantitative({**b,'value':'168838102514.79'},{**b,'value':'168838102514.78'}),'FAIL')

    def test_15_call_cap_blocks_before_scheduling(self):
        bid = self.create()
        with self.app.db() as db:
            db.execute('UPDATE provider_budget SET used=? WHERE provider=?',(CALL_CAP,PROVIDER))
        with self.assertRaises(Problem): self.action(bid,'run',{'case_ids':['F02']})
        self.assertEqual(self.app.read(self.sid,'/api/state')['global_calls_used'],CALL_CAP)
        self.assertFalse(self.get(bid)['cases'][0]['runs'])

    def test_16_review_wrong_evidence_and_duplicate_decision(self):
        bid = self.create()
        snap = self.run_cases(bid,['F02'])
        with self.assertRaises(Problem): self.action(bid,'reviews',{'evaluation_id':snap['cases'][0]['evaluation']['id'],'check_key':'safety','target':'PASS','reason':'理由','evidence_id':'wrong'})
        self.action(bid,'decisions',{'reason':'依据完整'})
        with self.assertRaises(Problem): self.action(bid,'decisions',{'reason':'重复决定'})

    def test_17_real_http_cookie_json_origin_and_static_allowlist(self):
        http = make_server(self.app,port=0)
        thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        url='http://127.0.0.1:'+str(http.server_port)
        opener=build_opener(HTTPCookieProcessor(CookieJar()))
        def get(path):
            with opener.open(url+path) as r: return r.read(),r.headers
        try:
            state,headers=get('/api/state')
            self.assertIn('HttpOnly',headers['Set-Cookie'])
            body={'name':'HTTP刷新恢复','case_ids':['F02']}
            req=Request(url+'/api/batches',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())},method='POST')
            with opener.open(req) as r: bid=json.load(r)['batch_id']
            a=json.loads(get('/api/state')[0]);b=json.loads(get('/api/state')[0])
            self.assertEqual(a,b)
            self.assertEqual(a['batches'][0]['batch']['id'],bid)
            for path in ['/server.py','/fixtures.json','/../work/investment-agent.local.json','/schema.sql']:
                with self.assertRaises(HTTPError): get(path)
            for path in ['/','/app.js','/style.css']:
                content,headers=get(path);self.assertTrue(content);self.assertIn("script-src 'self'",headers['Content-Security-Policy'])
            req=Request(url+'/api/batches',data=b'{}',headers={'Content-Type':'application/json','Origin':'https://attacker.example','Idempotency-Key':str(uuid.uuid4())},method='POST')
            with self.assertRaises(HTTPError) as exc:opener.open(req)
            self.assertEqual(exc.exception.code,403)
        finally:
            http.shutdown();http.server_close();thread.join()

    def test_18_completed_provider_return_remains_active_until_evaluation_commits(self):
        bid=self.create(source='constructed')
        arrived,release=threading.Event(),threading.Event()
        original=evaluate
        def paused(*args):
            arrived.set();release.wait(timeout=3)
            return original(*args)
        with patch('server.evaluate',side_effect=paused):
            self.action(bid,'run',{'case_ids':['F02']})
            self.assertTrue(arrived.wait(timeout=3))
            snap=self.get(bid)
            self.assertTrue(snap['cases'][0]['active'])
            self.assertEqual(snap['cases'][0]['runs'][-1]['status'],'processing')
            with self.assertRaises(Problem):self.action(bid,'decisions',{'reason':'不能提前通过'})
            release.set()
            deadline=time.monotonic()+3
            while self.get(bid)['cases'][0]['active']:
                self.assertLess(time.monotonic(),deadline);time.sleep(.01)

    def test_19_http402_adapter_and_credential_redaction(self):
        client=ModelClient({'api_key':'test-private-secret','base_url':'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1','timeout':1})
        with patch('server.urlopen',side_effect=HTTPError('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',402,'Payment Required',{},None)):
            status,result,error=client.call({'model':'deepseek-flash'})
        self.assertEqual((status,error),('failed','HTTP_402'))
        self.assertEqual(result['http_status'],402)
        self.assertEqual(client.clean({'text':'echo test-private-secret'}),{'text':'echo [REDACTED]'})

    def test_20_missing_key_blocks_before_request(self):
        self.client.enabled=False
        bid=self.create()
        with self.assertRaises(Problem):self.action(bid,'run',{'case_ids':['F02']})
        self.assertEqual(self.app.read(self.sid,'/api/state')['session_calls'],0)
        self.assertEqual(self.get(bid)['cases'][0]['runs'],[])

    def test_21_judge_retry_keeps_answer_and_old_results(self):
        bid=self.create()
        snap=self.run_cases(bid,['F02'])
        answer_id=snap['cases'][0]['answer']['id']
        self.action(bid,'decisions',{'reason':'初次完成'})
        self.action(bid,'reevaluate',{'case_ids':['F02']})
        deadline=time.monotonic()+3
        while self.get(bid)['cases'][0]['active']:
            self.assertLess(time.monotonic(),deadline);time.sleep(.01)
        snap=self.get(bid)
        self.assertEqual(snap['cases'][0]['answer']['id'],answer_id)
        self.assertEqual([r['kind'] for r in snap['cases'][0]['runs']],['generation','judge','judge'])
        self.assertFalse(snap['decisions'][0]['valid'])
        self.assertFalse(snap['blockers'])

    def test_22_archive_is_read_only_and_does_not_send_requests(self):
        archive=self.app.read(self.sid,'/api/archive')
        self.assertTrue(archive['read_only'])
        self.assertEqual(len(archive['records']),28)
        self.assertEqual(self.app.read(self.sid,'/api/state')['session_calls'],0)
        with self.assertRaises(Problem):self.write('/api/archive',{'text':'禁止改写'})

    def test_23_ratio_unit_does_not_loosen_percentage_rounding_policy(self):
        b={'entity':'A','metric':'yoy','period':'Q3','scope':'group','unit':'%','value':'8.234'}
        policy={'mode':'round','places':2,'unit':'%'}
        for value,status in [('.08234','PASS'),('.0823','PASS'),('.08231','FAIL'),('.08','FAIL')]:
            with self.subTest(value=value):self.assertEqual(quantitative({**b,'unit':'比例','value':value},b,policy),status)

    def test_24_global_budget_survives_new_cookie_and_restart(self):
        bid=self.create()
        self.run_cases(bid,['F02'])
        other,_=self.app.session(None)
        self.assertEqual(self.app.read(other,'/api/state')['global_calls_used'],2)
        self.assertEqual(self.app.read(other,'/api/state')['session_calls'],0)
        self.app.close();self.app=Application(self.path,self.client)
        self.assertEqual(self.app.read(other,'/api/state')['global_calls_used'],2)

    def test_25_bulk_execution_rejected_without_call(self):
        bid=self.create(['F02','F07A'])
        with self.assertRaises(Problem):self.action(bid,'run',{'case_ids':['F02','F07A']})
        self.assertEqual(self.app.read(self.sid,'/api/state')['global_calls_used'],0)

    def test_26_legacy_batch_cannot_silently_switch_provider(self):
        bid=self.create()
        with self.app.db() as db:
            frozen=json.loads(db.execute('SELECT frozen_json FROM batches WHERE id=?',(bid,)).fetchone()[0])
            frozen.pop('provider')
            frozen['generation_model']='deepseek-flash'
            db.execute('UPDATE batches SET frozen_json=? WHERE id=?',(json.dumps(frozen),bid))
        with self.assertRaises(Problem):self.action(bid,'run',{'case_ids':['F02']})
        with self.assertRaises(Problem):self.action(bid,'candidate')
        self.action(bid,'notes',{'text':'旧配置保留'})
        self.assertEqual(self.app.read(self.sid,'/api/state')['global_calls_used'],0)

    def test_27_responses_wire_and_hidden_reasoning_not_retained(self):
        client=ModelClient({'api_key':'test-private','base_url':'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'})
        payload=client.to_wire({'model':'auto','messages':[{'role':'system','content':'规则'},{'role':'user','content':'问题'}],'max_output_tokens':160})
        self.assertEqual(payload['input'][0]['content'][0]['text'],'问题')
        self.assertTrue(payload['enable_thinking']);self.assertEqual(payload['reasoning'],{'effort':'low'});self.assertFalse(payload['tools']);self.assertFalse(payload['store'])
        body={'status':'completed','model':'auto','output':[{'type':'reasoning','summary':[{'text':'hidden'}]},{'type':'message','role':'assistant','content':[{'type':'output_text','text':'OK'}]}],'usage':{'total_tokens':3}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return json.dumps(body).encode()
        with patch('server.urlopen',return_value=Response()) as mocked:
            status,result,error=client.call(payload)
            self.assertTrue(mocked.call_args.args[0].full_url.endswith('/responses'))
        self.assertEqual(status,'completed');self.assertEqual(result['text'],'OK')
        self.assertFalse(result['actual_model_disclosed'])
        self.assertNotIn('hidden',json.dumps(result))

    def test_28_input_size_limit_does_not_spend_budget(self):
        bid=self.create()
        # Direct adapter guard remains effective even if preflight is bypassed internally.
        with self.app.db() as db:
            db.execute("INSERT INTO runs(id,batch_id,case_id,kind,status,started_at) VALUES('oversize',?,'F02','judge','queued','test')",(bid,))
        status,result,error=self.app.invoke(self.sid,bid,'oversize',{'model':'auto','messages':[{'role':'user','content':'x'*9000}]})
        self.assertEqual(error,'INPUT_CHAR_LIMIT')
        self.assertEqual(self.app.read(self.sid,'/api/state')['global_calls_used'],0)

    def test_29_one_json_fence_normalizes_but_extra_text_stays_unknown(self):
        case=self.app.fixtures['cases'][0]
        answer=case['constructed_answer']
        payload=self.client.to_wire({'model':'auto','messages':[{'role':'user','content':json.dumps({'answer':answer,'required_checks':case['checks']})}]})
        _,response,_=self.client.call(payload)
        wrapped='```json\n'+response['text']+'\n```'
        checks,detail=evaluate(case,answer,wrapped,self.app.fixtures['reference'])
        self.assertEqual(checks['numeric'],'FAIL')
        self.assertEqual(detail['normalization'],'single_outer_json_fence_removed_original_kept_in_run')
        for invalid in ['说明文字\n'+wrapped,wrapped+'\n额外指令',wrapped+'\n'+wrapped]:
            with self.subTest(invalid=invalid):
                checks,detail=evaluate(case,answer,invalid,self.app.fixtures['reference'])
                self.assertTrue(all(v=='UNKNOWN' for v in checks.values()))

    def test_30_error_key_redaction_happens_before_message_truncation(self):
        key='private-'+('z'*600)
        client=ModelClient({'api_key':key,'base_url':'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'})
        body=BytesIO(json.dumps({'error':{'code':'Invalid','message':'credential: '+key}}).encode())
        error=HTTPError('https://token-plan.cn-beijing.maas.aliyuncs.com',400,'Bad Request',{},body)
        with patch('server.urlopen',side_effect=error):
            _,result,_=client.call({'model':'auto'})
        self.assertIn('[REDACTED]',result['provider_error']['message'])
        self.assertNotIn('z'*20,json.dumps(result))

    def test_31_network_failure_persists_context_and_finishes_atomically(self):
        bid=self.create(source='constructed')
        self.client.fail=True
        snap=self.run_cases(bid,['F02'])
        row=snap['cases'][0]
        self.assertFalse(row['active'])
        self.assertEqual(row['overall'],'UNKNOWN')
        detail=row['evaluation']['detail']
        self.assertEqual(detail['run_id'],row['runs'][-1]['id'])
        self.assertEqual(detail['execution_error'],'TIMEOUT')
        self.assertEqual(detail['latency_seconds'],0)
        self.assertIsNone(detail['http_status'])
        self.assertEqual(row['failure_context']['error'],'TIMEOUT')

    def test_32_crash_between_response_and_evaluation_exposes_retained_evidence(self):
        bid=self.create(source='constructed')
        with self.app.db() as db:
            db.execute("INSERT INTO runs(id,batch_id,case_id,kind,status,started_at) VALUES('crash-gap',?,'F02','judge','queued','test')",(bid,))
        self.client.fail=True
        status,_,error=self.app.invoke(self.sid,bid,'crash-gap',{'model':'auto','messages':[{'role':'user','content':'test'}]})
        self.assertEqual((status,error),('failed','TIMEOUT'))
        before=self.get(bid)['cases'][0]
        self.assertTrue(before['active'])
        self.assertIsNone(before['evaluation'])
        self.app.close();self.app=Application(self.path,self.client)
        after=self.get(bid)['cases'][0]
        self.assertFalse(after['active'])
        self.assertEqual(after['overall'],'UNKNOWN')
        self.assertEqual(after['failure_context']['status'],'interrupted')
        self.assertEqual(after['failure_context']['latency_seconds'],0)
        self.assertTrue(after['failure_context']['evaluation_missing_for_run'])
        self.assertEqual(self.app.read(self.sid,'/api/state')['global_calls_used'],1)

    def test_33_exhausted_run_retry_reevaluate_reject_before_dirty_writes(self):
        bid=self.create(source='constructed')
        self.client.fail=True
        self.run_cases(bid,['F02'])
        fresh=self.create(source='generated')
        with self.app.db() as db:
            db.execute('UPDATE provider_budget SET used=? WHERE provider=?',(CALL_CAP,PROVIDER))
        def counts():
            with self.app.db() as db:
                return {t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['runs','evaluations','events','submissions']}
        baseline=counts()
        with patch.object(self.client,'call',side_effect=AssertionError('Must never send')):
            for target,action,extra in [(fresh,'run',{}),(bid,'run',{'retry':True}),(bid,'reevaluate',{})]:
                with self.subTest(action=action,extra=extra):
                    with self.assertRaises(Problem) as error:self.action(target,action,{'case_ids':['F02'],**extra})
                    self.assertEqual(error.exception.status,409)
                    self.assertEqual(counts(),baseline)
        self.assertEqual(self.app.read(self.sid,'/api/state')['global_calls_used'],CALL_CAP)

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(MVPTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report={'version':'v0.7.4','provider':'explicitly_simulated','scope':'实际Python HTTP服务器、SQLite、会话Cookie和领域约束；模型返回为测试替身，不是浏览器或真实API验收','tests_run':result.testsRun,'passed':result.testsRun-len(result.errors)-len(result.failures),'failures':[(str(t),trace) for t,trace in result.failures+result.errors]}
    (Path(__file__).parent/'测试结果_v0.7.4.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    raise SystemExit(0 if result.wasSuccessful() else 1)
