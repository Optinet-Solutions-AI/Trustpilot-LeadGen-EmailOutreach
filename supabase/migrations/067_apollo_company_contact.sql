-- Apollo's free plan carries company contact data but NO email of any kind.
--
-- Verified 2026-09-10 against the live API: organizations/enrich returns 68
-- fields (name, phone, linkedin_url, headcount, address, industry...) and not
-- one is an email; every people endpoint — mixed_people/search, people/match,
-- mixed_companies/search — answers 403 API_INACCESSIBLE. So apollo_email will
-- stay NULL until the plan is upgraded, and the Apollo column would otherwise
-- read "needs paid plan" on all 138 rows while real, usable contact data sat
-- unshown.
--
-- The LinkedIn company URL is the more valuable of the two: Apollo will not
-- name a Head of Marketing for free, but its company page lists the people,
-- which is the practical route to the brands Snov's exhausted trial never
-- reached.
--
-- Measured on the Brazilian licensed-brand segment: 25 of 70 brands have an
-- Apollo record, 11 carry a switchboard number (bet365, Betfair, Novibet, MGM,
-- Pinnacle, Stake, Meridianbet...), 25 carry a LinkedIn page. The remaining 45
-- are small Brazilian sites Apollo has no record of — retried with backoff in
-- case a 429 masked them, and recovered zero.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS apollo_phone    text,
  ADD COLUMN IF NOT EXISTS apollo_linkedin text;

COMMENT ON COLUMN leads.apollo_phone IS
  'Company switchboard from Apollo organizations/enrich. Not a direct line.';
COMMENT ON COLUMN leads.apollo_linkedin IS
  'Apollo company LinkedIn URL — the free-plan route to finding named staff.';
