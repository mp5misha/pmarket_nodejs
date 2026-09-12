-- Phase 9: an optional estimated probability recorded alongside a trade
-- (typically whatever was typed into the Kelly stake calculator) — powers
-- the average-edge and Brier-score calibration metrics. NULL for trades
-- where no estimate was recorded; those are simply excluded from those two
-- metrics rather than treated as zero.
ALTER TABLE trades ADD COLUMN estimated_prob REAL;
