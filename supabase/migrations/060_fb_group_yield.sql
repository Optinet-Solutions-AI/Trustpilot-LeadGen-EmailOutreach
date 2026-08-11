-- Migration 060 — per-group scrape yield tracking. Idempotent; safe to re-apply.
BEGIN;
ALTER TABLE fb_group_candidates
    ADD COLUMN IF NOT EXISTS scrape_count    int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_leads     int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_scraped_at timestamptz;
COMMIT;
