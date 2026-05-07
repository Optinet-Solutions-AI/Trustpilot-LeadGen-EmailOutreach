-- Migration 028: Auto-Reply Handling & Prospect Discovery Pipeline
--
-- When the system emails leads at scraped role addresses (support@, info@,
-- contact@), recipients frequently respond with automated replies that disclose
-- the real contact email (affiliates@, partnerships@, marketing@) or a URL to
-- a partner brand site. Today these auto-replies inflate reply-rate metrics
-- and the disclosed contact info is lost. This migration adds the schema for:
--
--   1. Distinguishing auto-replies from human replies (campaign_leads.status
--      gains 'auto_replied'; campaigns gain total_auto_replied counter).
--   2. Capturing extracted contact candidates in a review queue
--      (discovered_contacts table + leads.discovered_email columns).
--   3. A separate "discovery follow-up" campaign type that sends to the
--      discovered email rather than primary_email
--      (campaigns.campaign_type + parent_campaign_id).
--   4. Activity-log entries for the new lifecycle events
--      (lead_notes.type CHECK extension).
--
-- All changes are additive. Existing rows default to the legacy behaviour
-- (campaign_type='outreach', no discovered_email set) so the existing
-- pipeline continues to work without modification.

-- ── 1. leads: discovered email + per-source verification ───────────────
-- The discovered email is recipient-disclosed via auto-reply (or harvested
-- from a partner-brand URL the auto-reply pointed at). Treated as its own
-- source so resolve-primary-email.ts can rank it independently of
-- trustpilot_email / website_email / affiliate_email.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS discovered_email        text,
  ADD COLUMN IF NOT EXISTS discovered_email_status text,
  ADD COLUMN IF NOT EXISTS discovered_email_source jsonb;

COMMENT ON COLUMN leads.discovered_email IS
  'Email disclosed by recipient via auto-reply, or harvested from a partner-brand URL referenced in an auto-reply. Promoted from discovered_contacts on user Accept.';
COMMENT ON COLUMN leads.discovered_email_status IS
  'Verification status for discovered_email. Mirrors trustpilot/website/affiliate_email_status.';
COMMENT ON COLUMN leads.discovered_email_source IS
  'jsonb audit of the source auto-reply: { from, subject, snippet, role_score, matched_role, discovered_at, source_campaign_lead_id }.';

-- ── 2. campaign_leads.status: add 'auto_replied' ───────────────────────
-- Drop the existing CHECK and re-create with the new value. Auto-replies do
-- NOT count as replies for reply-rate analytics; they live in their own
-- terminal status.
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_status_check;
ALTER TABLE campaign_leads
  ADD CONSTRAINT campaign_leads_status_check
  CHECK (status IN ('pending', 'sent', 'opened', 'replied', 'bounced', 'auto_replied'));

-- ── 3. campaigns: total_auto_replied counter + campaign_type ───────────
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS total_auto_replied integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS campaign_type      text    DEFAULT 'outreach',
  ADD COLUMN IF NOT EXISTS parent_campaign_id uuid;

-- campaign_type CHECK — only two known values today; safe to expand later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'campaigns' AND constraint_name = 'campaigns_campaign_type_check'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_campaign_type_check
      CHECK (campaign_type IN ('outreach', 'discovery_followup'));
  END IF;
END $$;

-- parent_campaign_id FK (optional, links a discovery_followup campaign to the
-- outreach campaign whose auto-reply produced the discovered email).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'campaigns' AND constraint_name = 'campaigns_parent_campaign_id_fkey'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_parent_campaign_id_fkey
      FOREIGN KEY (parent_campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN campaigns.campaign_type IS
  'outreach = cold outreach campaign (default). discovery_followup = follow-up to a contact discovered via auto-reply; sends to leads.discovered_email rather than primary_email.';
COMMENT ON COLUMN campaigns.parent_campaign_id IS
  'For discovery_followup campaigns: the outreach campaign whose auto-replies surfaced the discovered emails being targeted here.';
COMMENT ON COLUMN campaigns.total_auto_replied IS
  'Count of campaign_leads.status=auto_replied. Tracked separately from total_replied so reply-rate metrics stay human-only.';

-- ── 4. lead_notes.type: extend for new lifecycle events ────────────────
-- Drop and recreate so we can add the new event types alongside the
-- originals. The original constraint name on the initial schema is the
-- default-generated table_column_check pattern.
ALTER TABLE lead_notes DROP CONSTRAINT IF EXISTS lead_notes_type_check;
ALTER TABLE lead_notes
  ADD CONSTRAINT lead_notes_type_check
  CHECK (type IN (
    'note', 'status_change',
    'email_sent', 'email_opened', 'email_replied', 'email_bounced',
    'call', 'follow_up', 'verification',
    -- new in 028:
    'auto_reply_received',          -- auto-reply detected, candidates extracted (or empty)
    'auto_reply_no_contacts',       -- auto-reply detected but extractor found nothing useful (pre-gate)
    'auto_reply_candidate',         -- feature-flag-off shadow log for offline precision review
    'discovered_contact_accepted',  -- user accepted a discovery → primary_email may have rebuilt
    'discovered_contact_dismissed', -- user dismissed a discovery
    'lead_spawned_from_discovery'   -- new lead created from a discovered partner-brand URL
  ));

-- ── 5. discovered_contacts: review queue ───────────────────────────────
-- One row per email or URL extracted from an auto-reply. Status starts
-- 'pending_review'; transitions to 'accepted' / 'dismissed' / 'spawned_lead'
-- via the routes in server/src/routes/discovered-contacts.ts.
CREATE TABLE IF NOT EXISTS discovered_contacts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                  uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_campaign_lead_id  uuid REFERENCES campaign_leads(id) ON DELETE SET NULL,

  kind                     text NOT NULL CHECK (kind IN ('email', 'url')),
  value                    text NOT NULL,
  role                     text,                     -- e.g. 'affiliate', 'partnerships', 'press' — null for URLs / unmatched
  score                    integer NOT NULL DEFAULT 0,
  verification_status      text CHECK (verification_status IS NULL
                             OR verification_status IN ('valid', 'invalid', 'catch-all', 'unknown')),

  scrape_result            jsonb,                    -- for kind='url': { company_name, emails[], screenshot_path }

  status                   text NOT NULL DEFAULT 'pending_review'
                             CHECK (status IN ('pending_review', 'accepted', 'dismissed', 'spawned_lead')),

  auto_reply_message_id    text,                     -- gmail message id or imap UID:folder for audit
  auto_reply_metadata      jsonb,                    -- full headers + body snippet + classifier signals

  created_at               timestamptz NOT NULL DEFAULT now(),
  reviewed_at              timestamptz,
  reviewed_by              text                      -- user identifier (email/sub) when accepted/dismissed
);

-- Index for the per-lead lookup (LeadDetail banner + accept-by-id flow)
CREATE INDEX IF NOT EXISTS idx_dc_lead_status
  ON discovered_contacts(lead_id, status);

-- Index for the review queue (Prospects view) — pending rows ranked by score
CREATE INDEX IF NOT EXISTS idx_dc_status_score
  ON discovered_contacts(status, score DESC, created_at DESC)
  WHERE status = 'pending_review';

-- Helpful for the "did we already discover this email for this lead?" dedupe
-- when wiring repeat auto-replies — case-insensitive on value.
CREATE INDEX IF NOT EXISTS idx_dc_lead_value
  ON discovered_contacts(lead_id, lower(value));

COMMENT ON TABLE discovered_contacts IS
  'Review queue for emails and partner-brand URLs extracted from auto-replies. Verified email candidates promote to leads.discovered_email on user accept; URL candidates can spawn a new lead.';

-- ── 6. Done ────────────────────────────────────────────────────────────
-- Verification queries (run manually after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'leads' AND column_name LIKE 'discovered_%';
--   SELECT con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--     WHERE rel.relname = 'campaign_leads' AND con.contype = 'c';
--   SELECT * FROM discovered_contacts LIMIT 0;
