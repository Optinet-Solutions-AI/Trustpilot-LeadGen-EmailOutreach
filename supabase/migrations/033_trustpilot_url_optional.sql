-- ============================================================
-- 033_trustpilot_url_optional.sql
-- Phase 5 prep — allow leads with NO Trustpilot presence.
--
-- The leads table was Trustpilot-only when first authored, so
-- trustpilot_url was UNIQUE NOT NULL. Migration 032 generalized
-- the data model into leads + lead_platform_presences, but kept
-- the NOT NULL because three production code paths still upsert
-- with ON CONFLICT (trustpilot_url) and any change to those is
-- a Phase 2+ ingest refactor (done; see upsert_leads.py).
--
-- TripAdvisor-only leads have no Trustpilot URL — `trustpilot_url`
-- needs to be NULL on those rows. Postgres allows multiple NULLs
-- in UNIQUE columns by default, so the UNIQUE constraint stays
-- intact and the existing ON CONFLICT path keeps working for
-- Trustpilot leads.
-- ============================================================

ALTER TABLE leads
  ALTER COLUMN trustpilot_url DROP NOT NULL;

-- ============================================================
-- Verification:
--   SELECT is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'leads'
--      AND column_name = 'trustpilot_url';
--   -- expect 'YES'
-- ============================================================
