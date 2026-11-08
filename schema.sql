CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 既定値を DB 側にも持たせ、NULL が混ざらないようにする
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '{i}',
  delay REAL NOT NULL DEFAULT 0.35,
  jitter REAL NOT NULL DEFAULT 0.15,
  concurrency INTEGER NOT NULL DEFAULT 1,
  retries INTEGER NOT NULL DEFAULT 4,
  ping_everyone INTEGER NOT NULL DEFAULT 0,
  embed INTEGER NOT NULL DEFAULT 0,
  embed_title TEXT NOT NULL DEFAULT '{rand}',
  embed_desc TEXT NOT NULL DEFAULT '{i}',
  embed_color INTEGER NOT NULL DEFAULT 5793266,
  image TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  tts INTEGER NOT NULL DEFAULT 0,
  username_override TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  delete_webhook INTEGER NOT NULL DEFAULT 0,
  log_mode TEXT NOT NULL DEFAULT 'sample'
);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cfg TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

-- 実行ロック。jobs に列を足さないので既存 DB でもそのまま流せる
CREATE TABLE IF NOT EXISTS locks (
  job_id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  code INTEGER,
  msg TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_job ON logs(job_id, id);
CREATE INDEX IF NOT EXISTS idx_hooks_user ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_locks_at ON locks(at);
CREATE TABLE IF NOT EXISTS discord (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL DEFAULT '',
  guild_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tuning (
  user_id INTEGER PRIMARY KEY,
  batch INTEGER NOT NULL DEFAULT 60,
  lanes INTEGER NOT NULL DEFAULT 6
);