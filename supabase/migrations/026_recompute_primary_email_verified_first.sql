-- Migration 026 — recompute primary_email under the new "verified-first"
-- policy. Mirrors server/src/services/email/resolve-primary-email.ts:
--   Pass 1: prefer any source with *_email_status='valid', brand order
--           trustpilot > website > affiliate within the same tier.
--   Pass 2: no source strictly valid → fall back to any non-'invalid'
--           source in the same brand order.
--   Pass 3: every non-null source is invalid → keep whatever exists so
--           the row doesn't lose its display email.
--
-- Idempotent. Source columns (trustpilot_email, website_email,
-- affiliate_email) are NOT touched; only primary_email is rewritten.
-- Run it any time the verification statuses change in bulk and you want
-- the lead matrix display to catch up.

-- Step 1 — primary_email: pick the strongest source under verified-first.
UPDATE leads SET primary_email = CASE
  -- Pass 1: verified wins, by brand order
  WHEN trustpilot_email IS NOT NULL AND trustpilot_email_status = 'valid'
    THEN trustpilot_email
  WHEN website_email IS NOT NULL AND website_email_status = 'valid'
    THEN website_email
  WHEN affiliate_email IS NOT NULL AND affiliate_email_status = 'valid'
    THEN affiliate_email

  -- Pass 2: non-invalid fallback, by brand order
  WHEN trustpilot_email IS NOT NULL
       AND COALESCE(trustpilot_email_status, '') <> 'invalid'
    THEN trustpilot_email
  WHEN website_email IS NOT NULL
       AND COALESCE(website_email_status, '') <> 'invalid'
    THEN website_email
  WHEN affiliate_email IS NOT NULL
       AND COALESCE(affiliate_email_status, '') <> 'invalid'
    THEN affiliate_email

  -- Pass 3: last resort
  ELSE COALESCE(trustpilot_email, website_email, affiliate_email)
END;

-- Step 2 — verification_status: mirror the per-source status of whichever
-- email primary_email now points to, so the lead-level badge in the wizard
-- and the send-gate at /api/campaigns/:id/send agree with the *displayed*
-- email instead of the old worst-of-all-sources policy.
UPDATE leads SET
  verification_status = CASE
    WHEN primary_email IS NULL THEN NULL
    WHEN primary_email = trustpilot_email THEN trustpilot_email_status
    WHEN primary_email = website_email    THEN website_email_status
    WHEN primary_email = affiliate_email  THEN affiliate_email_status
    ELSE NULL
  END,
  email_verified = (
    CASE
      WHEN primary_email IS NULL THEN NULL
      WHEN primary_email = trustpilot_email THEN trustpilot_email_status
      WHEN primary_email = website_email    THEN website_email_status
      WHEN primary_email = affiliate_email  THEN affiliate_email_status
      ELSE NULL
    END
  ) = 'valid';
