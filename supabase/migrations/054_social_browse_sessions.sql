-- 054_social_browse_sessions.sql — adds 'browse' mode to the connect-flow
-- columns so a user can open an account's EXISTING logged-in profile as a
-- streamed interactive session (not a fresh login). Idempotent.
BEGIN;
ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS connect_mode         text NOT NULL DEFAULT 'connect',
  ADD COLUMN IF NOT EXISTS connect_target_url   text,
  ADD COLUMN IF NOT EXISTS connect_requested_by text;

-- Widen connect_status to allow the browse lifecycle ('active' while held,
-- 'ended' on teardown). Drop+recreate the CHECK (Postgres can't ALTER it).
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_connect_status_check;
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_connect_status_check
  CHECK (connect_status IS NULL OR connect_status IN
    ('requested','provisioning','ready','captured','expired','failed','active','ended'));
COMMIT;
