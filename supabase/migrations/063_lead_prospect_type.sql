-- Migration 063: classify what a scraped lead actually IS.
--
-- WHY
-- Operations' biggest source of wasted effort isn't bad emails, it's bad
-- prospects. A gambling scrape returns the real operator alongside affiliate
-- review sites, parked domains, redirects to a rebranded property, and
-- outright fakes. All of them look identical in the Lead Matrix, so a
-- campaign sized at "100 leads with emails" converts like ~5 (their numbers,
-- 2026-09-02) — and nobody could see which 5 before sending.
--
-- This adds the field that makes the distinction visible and filterable.
--
-- DELIBERATELY NOT AN ENUM: the value set will grow as new junk patterns turn
-- up (comparison portals, news sites, licence registries), and a text column
-- with a CHECK is cheaper to widen than a Postgres enum.
--
-- 'unclassified' is the honest default. Nothing is guessed into 'operator' —
-- see tools/db/classify_prospects.py, which only writes a type when a signal
-- actually supports it. An operator can always override by hand.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS prospect_type text
    CHECK (prospect_type IN (
      'operator',      -- the real business we want to sell to
      'affiliate',     -- review / comparison / bonus site that ranks operators
      'redirect',      -- site redirects off-domain (rebrand, sold, or parked)
      'dead',          -- listing or website is gone / never resolved
      'flagged',       -- platform put a consumer alert on it — not sellable
      'unclassified'   -- no signal either way yet (default)
    )),
  ADD COLUMN IF NOT EXISTS prospect_type_reason text,
  ADD COLUMN IF NOT EXISTS prospect_type_set_at timestamptz,
  -- 'auto' = derived from stored signals, 'manual' = a human decided.
  -- Manual always wins: the classifier must never overwrite a human call.
  ADD COLUMN IF NOT EXISTS prospect_type_source text
    CHECK (prospect_type_source IN ('auto', 'manual'));

COMMENT ON COLUMN leads.prospect_type IS
  'What this lead is: operator (sellable), affiliate/redirect/dead/flagged (not), or unclassified. Written by tools/db/classify_prospects.py from stored signals, or by hand from the Lead Detail page.';

-- Filtering the Lead Matrix by type is the whole point, and it always pairs
-- with the verification rank the list is already ordered by.
CREATE INDEX IF NOT EXISTS leads_prospect_type_idx
  ON leads (prospect_type, verification_rank);

-- ── Backfill the signals we already hold ──────────────────────────────────
-- Only the unambiguous ones. Order matters: flagged beats redirect beats
-- dead, because that is the order in which they disqualify a lead.
UPDATE leads
   SET prospect_type        = 'flagged',
       prospect_type_reason = COALESCE('platform consumer alert: ' || blocked_reason, 'platform consumer alert'),
       prospect_type_source = 'auto',
       prospect_type_set_at = now()
 WHERE prospect_type IS NULL
   AND blocked IS TRUE;

UPDATE leads
   SET prospect_type        = 'redirect',
       prospect_type_reason = 'website redirects to ' || redirects_to,
       prospect_type_source = 'auto',
       prospect_type_set_at = now()
 WHERE prospect_type IS NULL
   AND redirects_to IS NOT NULL;

UPDATE leads
   SET prospect_type        = 'dead',
       prospect_type_reason = 'link check: ' || link_status,
       prospect_type_source = 'auto',
       prospect_type_set_at = now()
 WHERE prospect_type IS NULL
   AND link_status IN ('FLAGGED_DEAD', 'FLAGGED_REMOVED');

-- Known affiliate properties are already tracked in the affiliates table
-- (migration 014) — match on registered domain rather than name, since
-- affiliate brands rename constantly but keep the domain.
UPDATE leads l
   SET prospect_type        = 'affiliate',
       prospect_type_reason = 'domain matches tracked affiliate: ' || a.name,
       prospect_type_source = 'auto',
       prospect_type_set_at = now()
  FROM affiliates a
 WHERE l.prospect_type IS NULL
   AND a.website IS NOT NULL
   AND l.website_url IS NOT NULL
   AND regexp_replace(lower(l.website_url), '^https?://(www\.)?([^/]+).*$', '\2')
     = regexp_replace(lower(a.website),      '^https?://(www\.)?([^/]+).*$', '\2');

-- Everything else stays unclassified rather than being assumed sellable.
UPDATE leads
   SET prospect_type = 'unclassified'
 WHERE prospect_type IS NULL;

ALTER TABLE leads ALTER COLUMN prospect_type SET DEFAULT 'unclassified';
