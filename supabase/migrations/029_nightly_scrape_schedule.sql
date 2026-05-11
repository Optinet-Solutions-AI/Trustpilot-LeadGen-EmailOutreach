-- 029_nightly_scrape_schedule.sql
-- Adds app_settings (single-row) for the nightly scrape scheduler,
-- and tags scrape_jobs with `source` so manual vs scheduler jobs can be
-- distinguished for parallelism counting and the activity feed.

CREATE TABLE IF NOT EXISTS app_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  nightly_scrape_enabled bool NOT NULL DEFAULT false,
  nightly_scrape_start_hour int NOT NULL DEFAULT 0,
  nightly_scrape_end_hour int NOT NULL DEFAULT 14,
  nightly_scrape_timezone text NOT NULL DEFAULT 'Asia/Manila',
  nightly_scrape_rescrape_days int NOT NULL DEFAULT 7,
  nightly_scrape_parallelism int NOT NULL DEFAULT 2,
  nightly_scrape_verify bool NOT NULL DEFAULT true,
  nightly_scrape_min_rating real NOT NULL DEFAULT 1.0,
  nightly_scrape_max_rating real NOT NULL DEFAULT 3.5,
  nightly_scheduler_last_tick_at timestamptz,
  nightly_scheduler_paused_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_source_status_completed
  ON scrape_jobs (source, status, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_country_category_completed
  ON scrape_jobs (country, category, completed_at DESC)
  WHERE status = 'completed';
