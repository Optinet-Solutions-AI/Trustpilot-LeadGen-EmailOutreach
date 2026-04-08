-- 005: Campaign enhancements for redesigned outreach UI
-- Adds filter persistence for campaign duplication, and reply snippet storage

-- Store the filters used when creating a campaign (for duplication)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS filter_country text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS filter_category text;

-- Store reply snippet directly on campaign_leads for fast display
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS reply_snippet text;
