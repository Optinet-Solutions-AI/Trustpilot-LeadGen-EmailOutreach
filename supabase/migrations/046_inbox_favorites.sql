-- Migration 046: Star/favorite inbox messages.
--
-- campaign_leads.is_favorite:
--   false (default) → normal inbox row
--   true            → user starred this message in the Outreach Inbox
--
-- The flag lives on the campaign_lead, so a starred row appears in BOTH the
-- Replies and Sent folders. Toggled by POST /api/inbox/toggle-favorite and
-- surfaced by GET /api/inbox/campaign-replies. The inbox "Favorites only"
-- filter narrows the list to rows where is_favorite = true.

ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;

-- Partial index — the "favorites only" feed only cares about starred rows.
CREATE INDEX IF NOT EXISTS idx_cl_favorites
  ON campaign_leads (replied_at DESC)
  WHERE is_favorite = true;
