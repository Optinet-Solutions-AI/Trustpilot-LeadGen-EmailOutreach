-- Migration 019: Layered email verification.
--
-- Adds domain-level intel cache + per-stage breakdown columns on leads so the
-- UI can show *which* stage produced each verdict ("Proven via SMTP RCPT-TO 250"
-- vs "ZeroBounce: catch-all"). The verification_status column on leads keeps
-- its existing 4-state enum and is set by the orchestrator's verdict ladder.

-- ── Domain intel cache (one row per scraped email domain) ──
-- Catch-all probe is the expensive bit (one SMTP roundtrip per domain), so we
-- cache the answer for 7 days. provider_type drives whether the per-address
-- SMTP probe is even worth attempting — Gmail/Outlook365 always say 250.
CREATE TABLE IF NOT EXISTS domain_email_intel (
  domain         text PRIMARY KEY,
  mx_top         text,
  provider_type  text
    CHECK (provider_type IS NULL
        OR provider_type IN ('google_workspace', 'outlook365', 'cpanel_or_other')),
  is_catch_all   boolean,
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS domain_email_intel_checked_at_idx
  ON domain_email_intel (checked_at DESC);

-- ── Per-stage breakdown on leads ──
-- These are read-only audit trails for the UI tooltip. The authoritative
-- verdict still lives on verification_status / trustpilot_email_status /
-- website_email_status. verified_at lets us age out stale verifications.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS verify_syntax_ok       boolean,
  ADD COLUMN IF NOT EXISTS verify_mx_ok           boolean,
  ADD COLUMN IF NOT EXISTS verify_smtp_result     text
    CHECK (verify_smtp_result IS NULL
        OR verify_smtp_result IN ('250', '550', 'unknown', 'skipped_catchall', 'skipped_giant', 'skipped_no_mx', 'error')),
  ADD COLUMN IF NOT EXISTS verify_zerobounce_result text
    CHECK (verify_zerobounce_result IS NULL
        OR verify_zerobounce_result IN ('valid', 'invalid', 'catch-all', 'unknown')),
  ADD COLUMN IF NOT EXISTS verify_live_probe_result text
    CHECK (verify_live_probe_result IS NULL
        OR verify_live_probe_result IN ('delivered_no_bounce', 'bounced', 'pending')),
  ADD COLUMN IF NOT EXISTS verified_at            timestamptz;
