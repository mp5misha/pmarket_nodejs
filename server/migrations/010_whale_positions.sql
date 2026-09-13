-- Persists the last successful "Whales trades" rescan (see server/src/
-- whales.js) so it survives a server restart instead of living only in
-- whales.js's in-memory cache, and gives fetchWhalePositions something to
-- fall back to if a live rescan fails outright. One row per position, with
-- the whole scan's trader_count/failed_wallet_count/fetched_at denormalized
-- onto every row (simplest option at this table's small scale — capped at
-- 50 top-50 traders' handful of positions each) rather than a separate
-- one-row "last scan" table joined in.
CREATE TABLE IF NOT EXISTS whale_positions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_id             TEXT,
  slug                     TEXT,
  event_slug               TEXT,
  title                    TEXT,
  outcome                  TEXT,
  size                     REAL,
  avg_price                REAL,
  cur_price                REAL,
  current_value            REAL,
  cash_pnl                 REAL,
  percent_pnl              REAL,
  trader_wallet            TEXT,
  trader_name              TEXT,
  trader_pnl               REAL,
  trader_volume            REAL,
  scan_trader_count        INTEGER NOT NULL,
  scan_failed_wallet_count INTEGER NOT NULL,
  fetched_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whale_positions_slug ON whale_positions(slug);
CREATE INDEX IF NOT EXISTS idx_whale_positions_fetched_at ON whale_positions(fetched_at);
