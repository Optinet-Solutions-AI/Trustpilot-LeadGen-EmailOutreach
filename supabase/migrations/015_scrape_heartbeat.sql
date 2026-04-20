-- ============================================================
-- 015_scrape_heartbeat.sql
-- Adds a heartbeat timestamp to scrape_jobs so server startup can
-- distinguish genuinely orphaned jobs (heartbeat stale) from jobs
-- that are still being actively driven by another Cloud Run instance.
-- ============================================================

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status_heartbeat
  ON scrape_jobs (status, last_heartbeat_at);
