-- Migration 003: Gmail tracking columns for reply detection
-- Run this in the Supabase SQL editor

-- Add Gmail message/thread IDs to campaign_leads for reply tracking
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS gmail_message_id text;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS gmail_thread_id text;

-- Index for efficient thread lookup during reply polling
CREATE INDEX IF NOT EXISTS idx_cl_gmail_thread
  ON campaign_leads (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cl_gmail_message
  ON campaign_leads (gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;

-- Allow 'sending' status while a campaign is in progress
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('draft', 'sending', 'sent', 'completed'));
