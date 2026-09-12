-- Phase 5: manually-recorded trades, resolved automatically once their
-- market closes. payout/profit use the same buy-side formula as Phase 9's
-- profitability tracking: payout = stake / entry_price if the trade's side
-- won, else 0; profit = payout - stake.
CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  market_slug   TEXT NOT NULL,
  side          TEXT NOT NULL,
  entry_price   REAL NOT NULL,
  stake         REAL NOT NULL,
  placed_at     TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  resolved_at   TEXT,
  payout        REAL,
  profit        REAL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_slug ON trades(market_slug);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
