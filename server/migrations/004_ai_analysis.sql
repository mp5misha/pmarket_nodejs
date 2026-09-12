-- Phase 3: persisted AI analysis history. Every DeepSeek call (not just the
-- latest) is kept as its own row, so multiple analyses of the same market
-- can be viewed and compared over time. `input_hash` (market + prompt +
-- model + reasoning effort) is used to serve a cached result instead of
-- re-calling DeepSeek, unless the caller explicitly re-runs.
CREATE TABLE IF NOT EXISTS ai_analysis (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  market_slug        TEXT NOT NULL,
  prompt_template_id INTEGER,
  prompt_text        TEXT NOT NULL,
  input_hash         TEXT NOT NULL,
  model_name         TEXT NOT NULL,
  reasoning_effort   TEXT,
  result_text        TEXT,
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  tokens_used        INTEGER,
  cost_estimate      REAL,
  status             TEXT NOT NULL DEFAULT 'completed',
  error              TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_slug ON ai_analysis(market_slug);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_input_hash ON ai_analysis(input_hash);
