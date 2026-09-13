-- Persists the top-10-most-profitable-traders snapshot computed alongside
-- each "Whales trades" rescan (see server/src/whales.js) — Polymarket's own
-- leaderboard stats (name, wallet, realized P&L, volume) for whichever
-- traders currently rank highest by pnl, independent of whether they hold
-- a position matching whale_positions' size threshold. Same "replace the
-- whole snapshot on every successful rescan" pattern as whale_positions
-- (010_whale_positions.sql), and for the same reason: durable "last known
-- good" data for the chart/list to fall back to if a live rescan fails.
CREATE TABLE IF NOT EXISTS whale_top_traders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rank       INTEGER NOT NULL,
  wallet     TEXT,
  name       TEXT,
  pnl        REAL,
  volume     REAL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whale_top_traders_rank ON whale_top_traders(rank);
