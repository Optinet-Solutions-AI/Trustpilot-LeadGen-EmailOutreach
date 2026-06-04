-- 044_social_connect_requests.sql
-- Adds the message-bus columns to social_accounts that let Cloud Run
-- enqueue a "Connect Facebook" request and let the Windows EC2 worker
-- claim it, spawn a remote browser, expose it via tunnel, and report
-- the URL back for the operator to drive.
--
-- The flow is:
--   1. Cloud Run sets connect_status='requested' + connect_session_id
--      + connect_started_at + connect_expires_at
--   2. EC2 worker polls for connect_status='requested', claims by
--      setting status='provisioning' (with optimistic-concurrency on
--      connect_session_id to avoid double-claim)
--   3. EC2 worker writes connect_tunnel_url, sets connect_status='ready'
--   4. Frontend polls /connect-status, embeds the URL
--   5. EC2 worker detects FB session cookie, writes encrypted cookies
--      to social_accounts.encrypted_cookies, sets social_accounts.status
--      ='active' + connect_status='captured'
--   6. Operator's modal closes
--
-- All connect_* fields are nullable so existing rows are unaffected.

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS connect_session_id   text,
  ADD COLUMN IF NOT EXISTS connect_tunnel_url   text,
  ADD COLUMN IF NOT EXISTS connect_status       text
    CHECK (connect_status IS NULL OR connect_status IN
      ('requested', 'provisioning', 'ready', 'captured', 'expired', 'failed')),
  ADD COLUMN IF NOT EXISTS connect_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS connect_expires_at   timestamptz,
  ADD COLUMN IF NOT EXISTS connect_error        text;

-- Index used by the EC2 worker's claim query (every poll):
--   WHERE platform = $1 AND connect_status = 'requested'
--   ORDER BY connect_started_at ASC
-- Partial index keeps it cheap - most rows have NULL connect_status.
CREATE INDEX IF NOT EXISTS idx_social_accounts_connect_pending
  ON social_accounts (platform, connect_started_at)
  WHERE connect_status = 'requested';

-- Unique constraint on connect_session_id so a stale request can't
-- collide with a freshly-minted one. Nullable column + UNIQUE means
-- multiple NULLs are allowed (the default in Postgres).
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_accounts_connect_session
  ON social_accounts (connect_session_id)
  WHERE connect_session_id IS NOT NULL;
