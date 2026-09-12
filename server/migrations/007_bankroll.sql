-- Phase 7: a bankroll ledger layered on top of the starting bankroll
-- amount (stored as a setting, see index.js's BANKROLL_SETTING) — current
-- balance = starting amount + sum(deposit/credit) - sum(withdrawal/debit).
-- entry_type: 'deposit' | 'withdrawal' (manual) | 'debit' | 'credit' (auto,
-- tied to a trade via trade_id — debited on entry, credited on a win).
CREATE TABLE IF NOT EXISTS bankroll_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type  TEXT NOT NULL,
  amount      REAL NOT NULL,
  trade_id    INTEGER REFERENCES trades(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bankroll_ledger_trade ON bankroll_ledger(trade_id);
CREATE INDEX IF NOT EXISTS idx_bankroll_ledger_created ON bankroll_ledger(created_at);
