import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * SQLite bootstrap for the local runtime.
 *
 * The schema is declared in one place and applied idempotently on boot. All
 * timestamps are ISO-8601 UTC strings, every table is keyed by a text id, and
 * every query is parameterised by the repositories that use this connection.
 */
export interface Database {
  readonly raw: DatabaseSync
  close(): void
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS investigations (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  objective     TEXT NOT NULL,
  topic         TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investigations_owner ON investigations(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS evidence (
  id                    TEXT PRIMARY KEY,
  investigation_id      TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  owner_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  url                   TEXT NOT NULL,
  url_normalized        TEXT NOT NULL,
  domain                TEXT NOT NULL DEFAULT '',
  snippet               TEXT NOT NULL DEFAULT '',
  retrieved_content     TEXT,
  published_at          TEXT,
  author                TEXT,
  collected_at          TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'exa',
  source_metadata       TEXT NOT NULL DEFAULT '{}',
  content_availability  TEXT NOT NULL DEFAULT '[]',
  relevance_score       REAL,
  relevance_breakdown   TEXT,
  validation_status     TEXT NOT NULL DEFAULT 'pending',
  note                  TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (investigation_id, url_normalized)
);
CREATE INDEX IF NOT EXISTS idx_evidence_investigation ON evidence(investigation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_owner ON evidence(owner_id);

CREATE TABLE IF NOT EXISTS analyses (
  id                      TEXT PRIMARY KEY,
  investigation_id        TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  owner_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evidence_ids            TEXT NOT NULL DEFAULT '[]',
  model                   TEXT NOT NULL,
  status                  TEXT NOT NULL,
  executive_summary       TEXT NOT NULL DEFAULT '',
  findings                TEXT NOT NULL DEFAULT '[]',
  key_points              TEXT NOT NULL DEFAULT '[]',
  supported_claims        TEXT NOT NULL DEFAULT '[]',
  contradictions          TEXT NOT NULL DEFAULT '[]',
  limitations             TEXT NOT NULL DEFAULT '[]',
  information_gaps        TEXT NOT NULL DEFAULT '[]',
  objective_alignment     TEXT NOT NULL DEFAULT '',
  reference_ids           TEXT NOT NULL DEFAULT '[]',
  insufficient_evidence   INTEGER NOT NULL DEFAULT 0,
  raw_structured_output   TEXT,
  usage                   TEXT,
  error_message           TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_investigation ON analyses(investigation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS validations (
  id                TEXT PRIMARY KEY,
  investigation_id  TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  evidence_id       TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL,
  previous_status   TEXT,
  justification     TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_validations_evidence ON validations(evidence_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validations_investigation ON validations(investigation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS activity_logs (
  id                TEXT PRIMARY KEY,
  investigation_id  TEXT REFERENCES investigations(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  description       TEXT NOT NULL,
  metadata          TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_owner ON activity_logs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_investigation ON activity_logs(investigation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_records (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  operation         TEXT NOT NULL,
  status            TEXT NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 1,
  investigation_id  TEXT,
  error_code        TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_owner_time ON usage_records(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_operation ON usage_records(operation, created_at DESC);

CREATE TABLE IF NOT EXISTS research_queries (
  id                TEXT PRIMARY KEY,
  investigation_id  TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query_hash        TEXT NOT NULL,
  query             TEXT NOT NULL,
  result_count      INTEGER NOT NULL DEFAULT 0,
  provider_request  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_hash ON research_queries(owner_id, query_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`

export function openDatabase(path: string): Database {
  const absolute = path === ':memory:' ? path : resolve(path)
  if (absolute !== ':memory:') {
    mkdirSync(dirname(absolute), { recursive: true })
  }
  const raw = new DatabaseSync(absolute)
  raw.exec(SCHEMA)
  return {
    raw,
    close: () => raw.close(),
  }
}

/** Read/write helpers that keep every query parameterised. */
export function run(db: Database, sql: string, params: unknown[] = []): void {
  db.raw.prepare(sql).run(...(params as never[]))
}

export function all<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  return db.raw.prepare(sql).all(...(params as never[])) as unknown as T[]
}

export function get<T>(db: Database, sql: string, params: unknown[] = []): T | null {
  const row = db.raw.prepare(sql).get(...(params as never[])) as unknown as T | undefined
  return row ?? null
}

/** Run a set of statements atomically. */
export function transaction(db: Database, fn: () => void): void {
  db.raw.exec('BEGIN')
  try {
    fn()
    db.raw.exec('COMMIT')
  } catch (error) {
    db.raw.exec('ROLLBACK')
    throw error
  }
}
