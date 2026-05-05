-- Migration 025 — swap primary_email priority to trustpilot-first.
--
-- Old policy: primary_email = website_email > affiliate_email > trustpilot_email
-- New policy: primary_email = trustpilot_email > website_email > affiliate_email,
--             skipping any source whose per-source status is 'invalid'.
--
-- Rationale: the Trustpilot inbox is review-focused and aligns with the
-- OptiRate reputation-management pitch. Existing rows had primary_email
-- computed under the old policy, so this one-time backfill recomputes them.
-- Idempotent — safe to re-run.

UPDATE leads SET primary_email = CASE
  WHEN trustpilot_email IS NOT NULL AND COALESCE(trustpilot_email_status, '') <> 'invalid'
    THEN trustpilot_email
  WHEN website_email    IS NOT NULL AND COALESCE(website_email_status, '')    <> 'invalid'
    THEN website_email
  WHEN affiliate_email  IS NOT NULL AND COALESCE(affiliate_email_status, '')  <> 'invalid'
    THEN affiliate_email
  ELSE COALESCE(trustpilot_email, website_email, affiliate_email)
END
WHERE trustpilot_email IS NOT NULL OR website_email IS NOT NULL OR affiliate_email IS NOT NULL;
