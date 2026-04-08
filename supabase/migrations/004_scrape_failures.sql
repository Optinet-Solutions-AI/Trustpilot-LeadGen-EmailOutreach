-- Migration 004: Scrape failure tracking + job metadata columns
-- Adds per-URL failure tracking for diagnostics and retry capability

-- New table for per-URL failure tracking
CREATE TABLE IF NOT EXISTS scrape_failures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  url           text NOT NULL,
  stage         text NOT NULL CHECK (stage IN ('category','profile','website','upsert')),
  error_message text,
  retry_count   int DEFAULT 0,
  resolved      boolean DEFAULT false,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX idx_scrape_failures_job ON scrape_failures (job_id);
CREATE INDEX idx_scrape_failures_unresolved ON scrape_failures (job_id, resolved) WHERE resolved = false;

-- Add new tracking columns to scrape_jobs
ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS pid int;
ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS total_failed int DEFAULT 0;
ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS total_skipped int DEFAULT 0;
