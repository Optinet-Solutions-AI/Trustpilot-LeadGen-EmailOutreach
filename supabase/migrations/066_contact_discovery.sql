-- Named decision-maker contacts discovered per lead, per provider.
--
-- The platform emails we scrape are role addresses (support@, suporte@,
-- ouvidoria@) that land in a shared inbox. For the Brazilian licensed-brand
-- segment the operator wants a named marketing lead — Head of Marketing,
-- Director of Marketing, CMO — so the pitch reaches someone who owns the
-- reputation problem rather than a support queue.
--
-- Kept as flat per-provider columns rather than a join table because the Lead
-- Matrix renders them as two columns side by side, and the rest of `leads` is
-- already denormalised this way (trustpilot_email / website_email / affiliate_email).
--
-- Provider note (measured 2026-09-10): Snov.io works on its free trial (50
-- credits, 1 per domain searched). Apollo's free plan returns 403
-- API_INACCESSIBLE for every people endpoint — mixed_people/search,
-- people/match, mixed_companies/search — so the apollo_* columns stay NULL
-- until the account is upgraded. The columns exist so the integration can be
-- switched on without a schema change.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS snov_email          text,
  ADD COLUMN IF NOT EXISTS snov_contact_name   text,
  ADD COLUMN IF NOT EXISTS snov_position       text,
  ADD COLUMN IF NOT EXISTS snov_checked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS apollo_email        text,
  ADD COLUMN IF NOT EXISTS apollo_contact_name text,
  ADD COLUMN IF NOT EXISTS apollo_position     text,
  ADD COLUMN IF NOT EXISTS apollo_checked_at   timestamptz;

COMMENT ON COLUMN leads.snov_email  IS 'Best title-matched contact email from Snov.io domain search.';
COMMENT ON COLUMN leads.apollo_email IS 'Same from Apollo. NULL on the free plan — people search is 403 there.';

-- `*_checked_at` distinguishes "searched, found nobody" from "never searched",
-- so a re-run does not spend a credit on a domain already known to be empty.
CREATE INDEX IF NOT EXISTS idx_leads_snov_checked_at
  ON leads (snov_checked_at)
  WHERE snov_checked_at IS NOT NULL;
