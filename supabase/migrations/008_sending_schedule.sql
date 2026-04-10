-- Migration 008: Add sending_schedule JSONB column to campaigns
-- Stores timezone, start/end hour, active days, and daily limit per campaign.
-- Used to configure the Instantly (or other platform) sending window at campaign creation.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS sending_schedule jsonb;

-- Backfill existing campaigns with null (schedule not set = platform default)
-- No action needed — column defaults to NULL.
