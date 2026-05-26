-- 041_claim_lock_smoke_test.sql
--
-- Tiny standalone table used by /api/admin/test-claim-lock-with-warmup-peers
-- to exercise the same atomic-claim pattern the sequence/campaign schedulers
-- use, but against a row with no FK constraints back to campaigns/leads.
-- Lets us prove the fix prevents the 2026-05 duplicate-send race under
-- real concurrent load WITHOUT needing to unpause cold sending or touch
-- real campaign_leads rows.
--
-- Rows are inserted by the endpoint, claimed concurrently, and deleted at
-- the end of each run — the table is meant to hold transient test state.

CREATE TABLE IF NOT EXISTS _claim_lock_smoke_test (
  id           text PRIMARY KEY,
  scheduled_at timestamptz NOT NULL,
  marker       text,
  created_at   timestamptz DEFAULT now()
);
