-- Migration 012: Email warmup system
-- Run this in the Supabase SQL Editor

-- 1. Warmup config per account
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS warmup_enabled      boolean   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warmup_daily_target integer   NOT NULL DEFAULT 5;
  -- warmup_daily_target: how many warmup emails to SEND per day from this account

-- 2. Warmup email log — tracks each send/open/reply cycle
CREATE TABLE IF NOT EXISTS warmup_emails (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account     text        NOT NULL,  -- sender email
  to_account       text        NOT NULL,  -- recipient email (both are our accounts)
  subject          text        NOT NULL,
  body             text        NOT NULL,
  warmup_uid       text        NOT NULL UNIQUE,  -- short ID embedded in subject for searching
  gmail_message_id text,                          -- A's sent message ID (for threading)
  gmail_thread_id  text,                          -- thread ID for reply threading
  reply_body       text,                          -- body of B's reply (chosen randomly at send time)
  stage            text        NOT NULL DEFAULT 'pending_open',
  -- stages: pending_open → pending_reply → pending_read → complete | failed
  process_after    timestamptz NOT NULL,  -- when to run the next stage action (randomised 5–30 min)
  sent_at          timestamptz NOT NULL DEFAULT now(),
  opened_at        timestamptz,
  replied_at       timestamptz,
  reply_read_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Index for scheduler polling
CREATE INDEX IF NOT EXISTS idx_warmup_emails_stage_process
  ON warmup_emails (stage, process_after)
  WHERE stage NOT IN ('complete', 'failed');
