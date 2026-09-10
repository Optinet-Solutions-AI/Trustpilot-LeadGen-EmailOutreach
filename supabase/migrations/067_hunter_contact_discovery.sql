-- Hunter.io as a third contact-discovery provider.
--
-- Why a third: Snov's free trial allowed ~10 domain searches before answering
-- "you ran out of credits" (its get-balance still reports 40.00 — that is a
-- different bucket from the prospect-search one), and Apollo's free plan 403s
-- every people endpoint. Hunter is the only provider this account holds real
-- credit on: ~1,495 domain searches remaining.
--
-- Measured 2026-09-10 on the same 10 operator domains: filtering Hunter
-- server-side with department=marketing returned 2 people in total, because
-- its department tagging is sparse. Fetching every contact and ranking the
-- titles locally found 3 usable contacts across those same domains —
-- alegria@stake.com (Marketing Manager), luyd@pixbet.com (Head of CRM),
-- burak.hun@kto.com (PPC Specialist).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS hunter_email        text,
  ADD COLUMN IF NOT EXISTS hunter_contact_name text,
  ADD COLUMN IF NOT EXISTS hunter_position     text,
  ADD COLUMN IF NOT EXISTS hunter_checked_at   timestamptz;

COMMENT ON COLUMN leads.hunter_email IS
  'Best title-matched contact from Hunter domain-search. The provider with actual free credit.';

CREATE INDEX IF NOT EXISTS idx_leads_hunter_checked_at
  ON leads (hunter_checked_at)
  WHERE hunter_checked_at IS NOT NULL;
