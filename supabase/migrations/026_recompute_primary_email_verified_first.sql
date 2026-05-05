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
-- SOURCE the resolver picked. We walk the same three-pass priority instead
-- of matching primary_email by string equality — TP and website emails are
-- often identical addresses (e.g. support@example.com on both), and string
-- equality would always pick TP's status even when the resolver actually
-- fell through to website (because TP was excluded for being invalid).
UPDATE leads SET
  verification_status = CASE
    -- Pass 1 mirror: a source explicitly verified=valid wins, brand order
    WHEN trustpilot_email IS NOT NULL AND trustpilot_email_status = 'valid'
      THEN trustpilot_email_status
    WHEN website_email IS NOT NULL AND website_email_status = 'valid'
      THEN website_email_status
    WHEN affiliate_email IS NOT NULL AND affiliate_email_status = 'valid'
      THEN affiliate_email_status

    -- Pass 2 mirror: non-invalid fallback in brand order. Returns whatever
    -- the source's status is (could be null, unknown, catch-all).
    WHEN trustpilot_email IS NOT NULL
         AND COALESCE(trustpilot_email_status, '') <> 'invalid'
      THEN trustpilot_email_status
    WHEN website_email IS NOT NULL
         AND COALESCE(website_email_status, '') <> 'invalid'
      THEN website_email_status
    WHEN affiliate_email IS NOT NULL
         AND COALESCE(affiliate_email_status, '') <> 'invalid'
      THEN affiliate_email_status

    -- Pass 3 mirror: every source is invalid, return the highest-priority's.
    WHEN trustpilot_email IS NOT NULL THEN trustpilot_email_status
    WHEN website_email IS NOT NULL THEN website_email_status
    WHEN affiliate_email IS NOT NULL THEN affiliate_email_status

    ELSE NULL
  END;

UPDATE leads SET email_verified = (verification_status = 'valid');
