import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 只保存元数据与哈希（方案 §8.1）：网关 key 哈希、请求日志、会话线状态、thinking 来源登记。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  allowed_models TEXT
);
CREATE TABLE IF NOT EXISTS request_log (
  ts INTEGER NOT NULL,
  req_id TEXT NOT NULL,
  key_id TEXT,
  ip TEXT,
  session TEXT,
  agent TEXT,
  req_class TEXT,
  model TEXT,
  channel TEXT,
  upstream_model TEXT,
  stream INTEGER,
  status INTEGER,
  ms INTEGER,
  ttfb_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER,
  cache_creation INTEGER,
  error_type TEXT,
  error_class TEXT,
  diags TEXT
);
CREATE INDEX IF NOT EXISTS request_log_ts ON request_log(ts);
CREATE TABLE IF NOT EXISTS auth_failures (
  ts INTEGER NOT NULL,
  ip TEXT,
  key_prefix TEXT,
  path TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS auth_failures_ts ON auth_failures(ts);
CREATE TABLE IF NOT EXISTS session_lines (
  line TEXT PRIMARY KEY,
  last_model TEXT NOT NULL,
  prev_model TEXT,
  switched_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS thinking_ledger (
  hash TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  const cols = (db.prepare('PRAGMA table_info(request_log)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('error_class')) db.exec('ALTER TABLE request_log ADD COLUMN error_class TEXT');
  return db;
}

export function pruneDb(db: Db, now: number, retentionDays: number, sessionTtlHours: number): void {
  db.prepare('DELETE FROM request_log WHERE ts < ?').run(now - retentionDays * 86400_000);
  db.prepare('DELETE FROM auth_failures WHERE ts < ?').run(now - retentionDays * 86400_000);
  db.prepare('DELETE FROM session_lines WHERE updated_at < ?').run(now - sessionTtlHours * 3600_000);
  db.prepare('DELETE FROM thinking_ledger WHERE created_at < ?').run(now - sessionTtlHours * 3600_000 * 2);
}
