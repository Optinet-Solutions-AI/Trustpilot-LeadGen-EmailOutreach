-- Migration 002: add tags column to leads
-- Run in Supabase SQL editor: Dashboard → SQL Editor → New query

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

-- Index for fast tag filtering (e.g. WHERE 'vip' = ANY(tags))
CREATE INDEX IF NOT EXISTS idx_leads_tags ON leads USING gin(tags);
