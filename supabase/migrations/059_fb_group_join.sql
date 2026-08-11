-- Migration 059 — FB auto-join-groups: pending-approval status + per-account
-- join budget. Idempotent; safe to re-apply. Design:
-- docs/superpowers/specs/2026-08-10-fb-auto-join-groups-design.md
-- 'questions' = a join was attempted but the group requires membership
-- questions we do not auto-answer; the row leaves the candidate pool and
-- awaits a manual answer.
BEGIN;

-- Allow the "join request sent, awaiting admin approval" state.
ALTER TABLE fb_group_candidates DROP CONSTRAINT IF EXISTS fb_group_candidates_status_check;
ALTER TABLE fb_group_candidates ADD CONSTRAINT fb_group_candidates_status_check
    CHECK (status IN ('candidate', 'joined', 'ignored', 'requested', 'questions'));

-- Separate join budget from the comment budget. group_join_used_date lets the
-- join action self-reset the daily counter (no dependency on an external cron).
ALTER TABLE social_accounts
    ADD COLUMN IF NOT EXISTS group_join_daily_cap  int NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS group_join_used_today int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS group_join_used_date  date;

COMMIT;
