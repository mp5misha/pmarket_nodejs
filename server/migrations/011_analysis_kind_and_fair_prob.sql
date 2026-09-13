-- Two additions to ai_analysis:
--
-- `kind` distinguishes a regular market analysis ('market', the existing
-- default) from a new "AI analysis of Whales activity" analysis ('whales')
-- — same table/history/thread/caching machinery, just a second independent
-- stream per market so the two never mix in each other's history or cache
-- lookups. Existing rows default to 'market' (the only kind that existed
-- before this migration).
--
-- `fair_prob_yes` is DeepSeek's own probability-of-Yes estimate (0-1),
-- parsed out of a market-kind analysis's free-text response (see
-- extractFairProbability in deepseek.js) — nullable, since older analyses
-- and any response the model didn't format as asked won't have one. Only
-- ever populated for kind='market'; a whale-activity analysis doesn't
-- produce one.
ALTER TABLE ai_analysis ADD COLUMN kind TEXT NOT NULL DEFAULT 'market';
ALTER TABLE ai_analysis ADD COLUMN fair_prob_yes REAL;

CREATE INDEX IF NOT EXISTS idx_ai_analysis_slug_kind ON ai_analysis(market_slug, kind);
