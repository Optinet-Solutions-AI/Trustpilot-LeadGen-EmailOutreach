-- 024_redirects_to.sql — track cross-domain redirects so we don't misattribute
-- emails from one operator's site to another.
--
-- When the scraper visits a lead's website_url and the response chain ends on
-- a different registrable domain, we record where it ended up. The lead is
-- then surfaced on the dedicated "Redirected Leads" workflow so users can
-- decide whether to send a different cold-outreach message ("noticed your
-- old domain points to X — are you the same operator?") or skip entirely.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS redirects_to text;

-- Partial index because the vast majority of leads will have NULL here, so
-- the index only needs to cover non-null values. Speeds up the redirect-only
-- list view without bloating the index size.
CREATE INDEX IF NOT EXISTS idx_leads_redirects_to
  ON leads (redirects_to)
  WHERE redirects_to IS NOT NULL;
