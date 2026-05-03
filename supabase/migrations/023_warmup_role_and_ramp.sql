-- Migration 023: Warmup role + per-account ramp
-- Splits accounts into cold-senders vs warmup-only peers, and adds per-account
-- auto-ramping daily caps so each sender ramps independently from the day it
-- was added (instead of relying on a single global env-keyed warmup state).

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS is_cold_sender    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS warmup_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS warmup_target_cap integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS warmup_ramp_days  integer NOT NULL DEFAULT 21;

COMMENT ON COLUMN email_accounts.is_cold_sender IS
  'When false, account participates in the warmup pool only and is never selected for campaign sends.';
COMMENT ON COLUMN email_accounts.warmup_started_at IS
  'Set on first warmup-enable. Sticky across off/on toggles. Reset via /api/warmup/:email/restart-ramp.';
COMMENT ON COLUMN email_accounts.warmup_target_cap IS
  'Daily cold-send cap to ramp to by Day warmup_ramp_days. Floor of 10 on Day 1.';
COMMENT ON COLUMN email_accounts.warmup_ramp_days IS
  'Length of the ramp curve in days. Default 21.';

-- Index used by buildSenderPool() to skip warmup-only peers cheaply.
CREATE INDEX IF NOT EXISTS email_accounts_cold_sender_idx
  ON email_accounts (is_cold_sender, status)
  WHERE is_cold_sender = true;
