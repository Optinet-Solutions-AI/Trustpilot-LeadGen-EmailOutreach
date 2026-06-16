-- Migration 050: Do-not-contact suppression
--
-- When a lead replies asking to be removed / not contacted ("please remove us
-- from your database", "unsubscribe", "do not contact", "not interested"), the
-- operator marks them do-not-contact from the Inbox. Such leads are kept in the
-- table (for audit + so we don't re-scrape them as "new") but are EXCLUDED from
-- every campaign's recipient selection, in any future campaign — not just the
-- one they replied to.
--
-- Detection is automatic (the reply trackers flag campaign_leads.opt_out_detected
-- when classifyReply finds opt-out language), but SUPPRESSION is one-click: the
-- operator confirms from the Inbox, which sets leads.do_not_contact=true. This
-- mirrors the migration 048 `blocked` pattern (marked-but-kept, excluded from
-- recipients) — recipient queries filter on both flags.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS do_not_contact        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_contact_at     timestamptz,
  ADD COLUMN IF NOT EXISTS do_not_contact_reason text;

COMMENT ON COLUMN leads.do_not_contact IS
  'true = lead asked not to be contacted (opt-out reply, confirmed by operator). Marked but kept; excluded from all campaign recipients. Default false.';
COMMENT ON COLUMN leads.do_not_contact_at IS
  'When do_not_contact was set (audit).';
COMMENT ON COLUMN leads.do_not_contact_reason IS
  'Short note on why (e.g. matched opt-out phrase or operator reason).';

-- Partial index — queries scan for do_not_contact=true (the recipient
-- exclusion), so a partial index on the true rows is the cheap choice,
-- matching idx_leads_blocked.
CREATE INDEX IF NOT EXISTS idx_leads_do_not_contact ON leads(do_not_contact) WHERE do_not_contact = true;

-- Per-reply flag set by the auto-reply detector when a human reply contains
-- opt-out language. Drives the Inbox "Opt-out?" pill + one-click "Do Not
-- Contact" action. Cleared implicitly once the operator confirms (the lead-level
-- do_not_contact flag becomes the source of truth).
ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS opt_out_detected boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN campaign_leads.opt_out_detected IS
  'true = the inbound reply on this row contained opt-out / do-not-contact language. Surfaces the Inbox suppression prompt. Default false.';

-- Verification (run manually after applying):
--   SELECT count(*) FILTER (WHERE do_not_contact) AS dnc, count(*) AS total FROM leads;
--   SELECT count(*) FILTER (WHERE opt_out_detected) AS flagged FROM campaign_leads;
