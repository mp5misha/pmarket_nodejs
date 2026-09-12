-- Phase 2: optional scheduled reruns for a saved search. NULL/0 means the
-- search is only ever run manually ("Fetch now" or the saved-search "Run"
-- button). Kept as its own migration since 002 already shipped and ran.
ALTER TABLE saved_searches ADD COLUMN schedule_minutes INTEGER;
ALTER TABLE saved_searches ADD COLUMN last_run_at TEXT;
