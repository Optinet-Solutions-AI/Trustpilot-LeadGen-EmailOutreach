-- Migration 027 — reconcile per-source statuses for leads where the same
-- email address sits in BOTH trustpilot_email and website_email.
--
-- Background: the old verify route deduped by address (good — one ZeroBounce
-- credit per unique email) but only stamped the result on one source slot.
-- A lead with trustpilot_email=website_email='X' could end up with
-- trustpilot_email_status='invalid' AND website_email_status=null, even
-- though both columns hold the same address. The lead matrix then showed
-- the TP cell crossed out and the website cell looking clean.
--
-- Rule: when the two columns hold the same address and only one has a
-- non-null status, copy that status into the empty slot. When both have a
-- non-null status, keep the WORSE of the two (most conservative — protects
-- the send-gate from acting on stale-fresh disagreements).
--
-- After this runs, re-run migration 026 to recompute primary_email and
-- verification_status against the cleaned-up per-source statuses.
--
-- Idempotent.

-- ── Worse-of helper inlined as CASE: invalid > catch-all > unknown > valid
-- For each row where the addresses match, replace BOTH per-source statuses
-- with the worst non-null status across the two columns. NULL on one side
-- is treated as "no opinion" and the other side wins outright.
WITH ranked AS (
  SELECT
    id,
    trustpilot_email_status AS tp,
    website_email_status    AS web,
    CASE
      WHEN trustpilot_email_status = 'invalid'   OR website_email_status = 'invalid'   THEN 'invalid'
      WHEN trustpilot_email_status = 'catch-all' OR website_email_status = 'catch-all' THEN 'catch-all'
      WHEN trustpilot_email_status = 'unknown'   OR website_email_status = 'unknown'   THEN 'unknown'
      WHEN trustpilot_email_status = 'valid'     OR website_email_status = 'valid'     THEN 'valid'
      ELSE NULL
    END AS reconciled
  FROM leads
  WHERE trustpilot_email IS NOT NULL
    AND website_email    IS NOT NULL
    AND trustpilot_email = website_email
)
UPDATE leads l
   SET trustpilot_email_status = r.reconciled,
       website_email_status    = r.reconciled
  FROM ranked r
 WHERE l.id = r.id
   AND r.reconciled IS NOT NULL
   AND (l.trustpilot_email_status IS DISTINCT FROM r.reconciled
        OR l.website_email_status IS DISTINCT FROM r.reconciled);
