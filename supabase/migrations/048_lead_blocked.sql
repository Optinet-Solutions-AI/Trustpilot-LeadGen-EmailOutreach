-- Migration 048: Blocked Trustpilot profiles
--
-- Trustpilot flags some businesses with a consumer-alert / warning banner
-- ("we found evidence of fake/incentivised reviews", "this profile has been
-- flagged/suspended", etc.). Those companies are not worth pursuing as
-- clients — the operator wants them MARKED (so the scraped count is visible)
-- and EXCLUDED from campaign recipients, but still kept in the table.
--
-- The Trustpilot profile scraper sets these columns when it detects the
-- consumer-alert banner (see tools/scraper/scrape_profile.py). All other
-- platforms leave them at the default (not blocked).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS blocked        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_reason text;

COMMENT ON COLUMN leads.blocked IS
  'true = Trustpilot has flagged this business with a consumer-alert/warning banner. Marked but kept; excluded from campaign recipients. Default false.';
COMMENT ON COLUMN leads.blocked_reason IS
  'Short snippet of the consumer-alert banner text that triggered blocked=true (audit / display).';

-- Partial index — the only query that hits this column scans for blocked=true
-- (the "how many blocked did we scrape" count + the campaign-recipient
-- exclusion), so a partial index on the true rows is the cheap choice.
CREATE INDEX IF NOT EXISTS idx_leads_blocked ON leads(blocked) WHERE blocked = true;

-- Verification (run manually after applying):
--   SELECT count(*) FILTER (WHERE blocked) AS blocked, count(*) AS total FROM leads;
