-- Migration 006: Add email platform integration columns
-- Supports Instantly.ai, Smartlead, and future third-party email platforms.

-- Track which platform manages a campaign and its remote ID
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS platform_campaign_id text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS email_platform text;

-- Track platform-side lead ID for webhook event mapping
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS platform_lead_id text;

-- Index for fast webhook lookups (find campaign_lead by email + campaign)
CREATE INDEX IF NOT EXISTS idx_cl_platform_lookup
  ON campaign_leads (email_used, campaign_id)
  WHERE email_used IS NOT NULL;

-- Index for sync job: find active platform campaigns
CREATE INDEX IF NOT EXISTS idx_campaigns_platform_active
  ON campaigns (email_platform)
  WHERE platform_campaign_id IS NOT NULL
    AND status IN ('sending', 'active');
