-- Migration 011: Scheduled sending support + persistent warmup state
-- Run this in the Supabase SQL Editor

-- 1. Add scheduled_at to campaign_leads so we can store and display when each email will fire
ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

-- Index for polling "what emails are due now"
CREATE INDEX IF NOT EXISTS idx_campaign_leads_scheduled_at
  ON campaign_leads (scheduled_at)
  WHERE status = 'pending';

-- 2. Persistent warmup state per account (replaces ephemeral .tmp/warmup-state.json)
CREATE TABLE IF NOT EXISTS email_warmup_state (
  account_email  text        PRIMARY KEY,
  start_date     timestamptz NOT NULL DEFAULT now(),
  lifetime_sent  integer     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
