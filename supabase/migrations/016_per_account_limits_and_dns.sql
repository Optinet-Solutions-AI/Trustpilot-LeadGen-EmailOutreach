-- Migration 016: Per-account limits, DNS cache, and sender tracking
-- Makes the Email Accounts page fully functional per account (not hardcoded).

-- ── Per-account send limits (NULL = fall back to env EMAIL_DAILY_CAP / EMAIL_HOURLY_CAP) ──
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS daily_cap       integer,
  ADD COLUMN IF NOT EXISTS hourly_cap      integer,
  ADD COLUMN IF NOT EXISTS dns_mx          boolean,
  ADD COLUMN IF NOT EXISTS dns_spf         boolean,
  ADD COLUMN IF NOT EXISTS dns_dmarc       boolean,
  ADD COLUMN IF NOT EXISTS dns_checked_at  timestamptz;

-- ── Record which account sent each campaign_leads row, so per-account daily/hourly counts
--    can be computed from the authoritative send log (survives restarts, no in-memory drift) ──
ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS sender_email    text;

CREATE INDEX IF NOT EXISTS campaign_leads_sender_sent_at_idx
  ON campaign_leads (sender_email, sent_at DESC)
  WHERE sender_email IS NOT NULL AND sent_at IS NOT NULL;
