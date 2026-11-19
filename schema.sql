PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), name TEXT NOT NULL, parent_id TEXT REFERENCES batches(id), source TEXT NOT NULL, frozen_json TEXT NOT NULL, benchmark_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answers(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), case_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), case_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT, result_json TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), case_id TEXT NOT NULL, answer_id TEXT REFERENCES answers(id), run_id TEXT REFERENCES runs(id), checks_json TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), evaluation_id TEXT NOT NULL REFERENCES evaluations(id), check_key TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, evidence_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), revision INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), revision INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions(session_id TEXT NOT NULL, token TEXT NOT NULL, route TEXT NOT NULL, body_hash TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(session_id,token));
CREATE INDEX IF NOT EXISTS idx_batch_session ON batches(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id);
CREATE INDEX IF NOT EXISTS idx_eval_batch ON evaluations(batch_id,case_id);

CREATE TABLE IF NOT EXISTS provider_budget(provider TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS provider_calls(session_id TEXT NOT NULL REFERENCES sessions(id), provider TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id,provider));

CREATE TABLE IF NOT EXISTS dispositions(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),revision INTEGER NOT NULL,outcome TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
