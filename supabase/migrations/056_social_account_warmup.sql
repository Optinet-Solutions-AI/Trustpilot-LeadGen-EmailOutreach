-- 056_social_account_warmup.sql
-- Comment-budget warmup ramp for pooled social accounts.
--
-- A freshly-onboarded FB/IG account that posts at its full daily comment cap on
-- day one is a checkpoint magnet. `warmup_started_at` lets the app ramp the
-- effective comment cap over the first ~3 weeks (see effectiveCommentCap in
-- server/src/services/pool-account-resolver.ts):
--   week 1 -> 1/day, week 2 -> 2/day, week 3 -> 3/day, day 21+ -> full cap.
--
-- NULL means "not tracked / already warmed" -> full configured cap. Existing
-- accounts are left NULL so warmed accounts (e.g. james) are unaffected; the
-- app stamps now() on newly created accounts.

ALTER TABLE social_accounts
    ADD COLUMN IF NOT EXISTS warmup_started_at timestamptz;

COMMENT ON COLUMN social_accounts.warmup_started_at IS
    'When the account''s comment-budget warmup ramp began. NULL = already warmed (full cap). Set on account creation.';
