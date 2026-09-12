-- Phase 2: Market Discovery — saved search configurations and an audit
-- trail of every catalog fetch (ad hoc or from a saved search).

CREATE TABLE IF NOT EXISTS saved_searches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  tag             TEXT,
  resolution_from TEXT,
  resolution_to   TEXT,
  min_volume      REAL,
  min_liquidity   REAL,
  keyword         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_search_id INTEGER REFERENCES saved_searches(id) ON DELETE SET NULL,
  filters_json    TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  markets_added   INTEGER NOT NULL DEFAULT 0,
  markets_updated INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running',
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_fetch_runs_saved_search ON fetch_runs(saved_search_id);
CREATE INDEX IF NOT EXISTS idx_fetch_runs_started ON fetch_runs(started_at);
