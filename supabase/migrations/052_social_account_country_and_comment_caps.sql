-- Migration 052 — Country-pin social accounts + comment write caps.
-- Adds geo-pinning (country + optional proxy override) so a scrape's
-- target country selects the matching account, and a SEPARATE write
-- budget for the optional operator-reviewed comment path.
-- Idempotent: IF NOT EXISTS guards everywhere. Re-applying is safe.

BEGIN;

ALTER TABLE social_accounts
    ADD COLUMN IF NOT EXISTS country            text,
    ADD COLUMN IF NOT EXISTS proxy_location      text,
    ADD COLUMN IF NOT EXISTS comment_daily_cap   int  NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS comment_used_today  int  NOT NULL DEFAULT 0;

-- Country-scoped account selection reads (platform, status, country).
CREATE INDEX IF NOT EXISTS social_accounts_country_idx
    ON social_accounts (platform, status, country)
    WHERE status = 'active';

COMMIT;
