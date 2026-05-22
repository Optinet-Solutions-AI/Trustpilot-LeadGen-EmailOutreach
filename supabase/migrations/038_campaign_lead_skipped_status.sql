-- Migration 038: Mark dedup-skipped campaign_leads with a real terminal status.
--
-- The send route at server/src/routes/campaigns.ts filters out leads whose
-- email_used was already sent in any prior campaign (via getSentEmails()).
-- Previously the dedup ran in memory and the dropped rows were never
-- written back to the database -- they stayed at status='pending' with
-- scheduled_at=null forever, producing a misleading "Pending" pill in
-- CampaignDetail.tsx (the UI's "already contacted in another campaign"
-- footer text was a heuristic guess based on the row's stuck state).
--
-- This migration:
--   1. Adds 'skipped' to the campaign_leads.status CHECK constraint.
--   2. Adds a skip_reason text column so the UI can render a precise label
--      and the backend can extend the reason set without another migration.
--   3. Backfills existing ghost-pending rows: any campaign_leads row with
--      status='pending', scheduled_at IS NULL, sent_at IS NULL, where the
--      email_used appears in the global "already contacted" set, is
--      retroactively marked skipped with reason='already_contacted_in_another_campaign'.
--
-- The send route, addLeadsToCampaign, and the campaign wizard picker are
-- all updated in this same change to write/use the new status.

-- ── 1. campaign_leads.status: add 'skipped' ────────────────────────────
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_status_check;
ALTER TABLE campaign_leads
  ADD CONSTRAINT campaign_leads_status_check
  CHECK (status IN ('pending', 'sent', 'opened', 'replied', 'bounced', 'auto_replied', 'skipped'));

-- ── 2. campaign_leads.skip_reason ──────────────────────────────────────
ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS skip_reason text;

COMMENT ON COLUMN campaign_leads.skip_reason IS
  'When status=''skipped'', records why. Known values: ''already_contacted_in_another_campaign'' (email was already sent/opened/replied/auto_replied/bounced in any other campaign).';

-- ── 3. Backfill existing ghost-pending rows ────────────────────────────
-- Mark every row whose email_used is in the global "already contacted" set
-- as skipped. These rows were silently dropped by the send dedup at some
-- point in the past and have been showing as "Pending" in the UI ever since.
WITH already_sent_emails AS (
  SELECT DISTINCT lower(email_used) AS email_used
  FROM campaign_leads
  WHERE status IN ('sent', 'opened', 'replied', 'auto_replied', 'bounced')
    AND email_used IS NOT NULL
)
UPDATE campaign_leads cl
   SET status      = 'skipped',
       skip_reason = 'already_contacted_in_another_campaign'
  FROM already_sent_emails ase
 WHERE cl.status = 'pending'
   AND cl.scheduled_at IS NULL
   AND cl.sent_at IS NULL
   AND cl.email_used IS NOT NULL
   AND lower(cl.email_used) = ase.email_used;
