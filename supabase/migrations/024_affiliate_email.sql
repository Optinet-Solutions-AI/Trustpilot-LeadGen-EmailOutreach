-- Migration 024: Affiliate email column
-- Captures emails discovered by the lateral-prospecting tier of the website
-- enricher (e.g. an affiliate program landing page like roosterpartners.com
-- linked from a casino's main marketing domain). Kept separate from
-- website_email so we can tell at a glance which leads required lateral
-- discovery vs. a direct site contact.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS affiliate_email        text,
  ADD COLUMN IF NOT EXISTS affiliate_email_status text;

COMMENT ON COLUMN leads.affiliate_email IS
  'Email discovered by lateral-prospecting fallback (affiliate/partner page). Distinct from website_email which is the main-domain contact.';

COMMENT ON COLUMN leads.affiliate_email_status IS
  'Verification status for affiliate_email. Mirrors trustpilot_email_status / website_email_status (valid / invalid / catch-all / unknown / null).';
