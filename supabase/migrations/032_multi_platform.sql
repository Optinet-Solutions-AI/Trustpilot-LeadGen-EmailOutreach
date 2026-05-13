-- ============================================================
-- 032_multi_platform.sql
-- Generalizes the scraper from Trustpilot-only to a plugin
-- registry. Each scraped company can now have a presence on
-- multiple platforms (Trustpilot, TripAdvisor, ...), each with
-- its own profile URL, rating, and screenshot.
--
-- Schema-only. No application code is required to take effect
-- of this migration immediately — legacy paths keep working
-- because the existing leads columns and taxonomy tables are
-- preserved (renamed, not dropped). A follow-up code refactor
-- (Phase 2+) populates the new shapes.
--
-- Adds:
--   • scrape_jobs.platform           (defaults to 'trustpilot')
--   • scrape_jobs.filters jsonb      (generic filter envelope)
--   • lead_platform_presences        (per-(lead, platform) row)
--   • platform_categories            (renamed from trustpilot_categories)
--   • platform_countries             (renamed from trustpilot_countries)
--   • cleanup_runs                   (audit log for storage cleanup cron)
--
-- Drops:
--   • UNIQUE constraint on leads.trustpilot_url
--     (uniqueness now lives on lead_platform_presences(platform, profile_url))
--
-- Preserves (for backwards-compat reads):
--   • leads.trustpilot_url / trustpilot_email / star_rating / screenshot_path
--     — kept as denormalized mirrors of the Trustpilot presence
--   • scrape_jobs.country / category / min_rating / max_rating
--     — still populated by the API for trustpilot platform
-- ============================================================

-- ── 1. scrape_jobs: platform + generic filters ──────────────────
ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'trustpilot',
  ADD COLUMN IF NOT EXISTS filters  jsonb;

-- Backfill filters from legacy columns so existing rows are queryable
-- through the new shape too.
UPDATE scrape_jobs
   SET filters = jsonb_build_object(
         'country',    country,
         'category',   category,
         'min_rating', min_rating,
         'max_rating', max_rating,
         'enrich',     enrich,
         'verify',     verify
       )
 WHERE filters IS NULL;

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_platform
  ON scrape_jobs (platform);

-- ── 2. lead_platform_presences ─────────────────────────────────
-- One row per (lead, platform). Owns the per-platform fields that
-- used to live as trustpilot_* columns on leads.
CREATE TABLE IF NOT EXISTS lead_platform_presences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  platform        text NOT NULL,
  profile_url     text NOT NULL,
  rating          real,
  screenshot_path text,
  platform_email  text,
  scraped_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, profile_url),
  UNIQUE (lead_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_lpp_lead     ON lead_platform_presences (lead_id);
CREATE INDEX IF NOT EXISTS idx_lpp_platform ON lead_platform_presences (platform);

-- Idempotent trigger (re-run safe — Postgres doesn't have CREATE TRIGGER IF NOT EXISTS).
DROP TRIGGER IF EXISTS lead_platform_presences_updated_at ON lead_platform_presences;
CREATE TRIGGER lead_platform_presences_updated_at
  BEFORE UPDATE ON lead_platform_presences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Backfill from existing leads: every Trustpilot lead becomes a presence row.
INSERT INTO lead_platform_presences
  (lead_id, platform, profile_url, rating, screenshot_path, platform_email, scraped_at)
SELECT
  id,
  'trustpilot',
  trustpilot_url,
  star_rating,
  screenshot_path,
  trustpilot_email,
  scraped_at
FROM leads
WHERE trustpilot_url IS NOT NULL
ON CONFLICT (platform, profile_url) DO NOTHING;

-- ── 3. KEEP UNIQUE on leads.trustpilot_url (intentional) ────────
-- Original 032 dropped this constraint, but three production code
-- paths still upsert into `leads` with ON CONFLICT (trustpilot_url):
--   * tools/db/upsert_leads.py            (scraper ingest)
--   * server/src/db/leads.ts              (lead CRUD)
--   * server/src/db/discovered-contacts.ts (auto-reply promotion)
-- Dropping the constraint without first refactoring those upserts
-- to target lead_platform_presences(platform, profile_url) would
-- break every scrape. The presences table coexists with the legacy
-- column for now; the cutover to per-platform uniqueness is a
-- follow-up (Phase 2) that rewrites those three upsert paths.
-- LEAVING THE CONSTRAINT IN PLACE — DO NOT REMOVE WITHOUT THE INGEST REFACTOR.

-- ── 4. Rename trustpilot_categories → platform_categories ───────
-- Postgres can't change a PK via ALTER TABLE in one statement,
-- and the self-FK on parent_slug has to be rebuilt when the PK
-- changes from (slug) to (platform, slug). Order:
--   a) drop the self-FK
--   b) rename the table
--   c) add the platform column
--   d) drop old PK, add composite PK
--   e) recreate the self-FK against the new composite key
ALTER TABLE IF EXISTS trustpilot_categories
  DROP CONSTRAINT IF EXISTS trustpilot_categories_parent_slug_fkey;

ALTER TABLE IF EXISTS trustpilot_categories
  RENAME TO platform_categories;

ALTER TABLE IF EXISTS platform_categories
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'trustpilot';

ALTER TABLE IF EXISTS platform_categories
  DROP CONSTRAINT IF EXISTS trustpilot_categories_pkey;

-- Idempotent: drop our own PK / FK if a prior partial run already added them.
ALTER TABLE IF EXISTS platform_categories
  DROP CONSTRAINT IF EXISTS platform_categories_pkey;
ALTER TABLE IF EXISTS platform_categories
  DROP CONSTRAINT IF EXISTS platform_categories_parent_fkey;

ALTER TABLE IF EXISTS platform_categories
  ADD CONSTRAINT platform_categories_pkey PRIMARY KEY (platform, slug);

-- The old self-FK referenced trustpilot_categories(slug). The new
-- composite key requires (platform, parent_slug) → (platform, slug),
-- which preserves the "parent must be on the same platform" invariant.
ALTER TABLE IF EXISTS platform_categories
  ADD CONSTRAINT platform_categories_parent_fkey
    FOREIGN KEY (platform, parent_slug)
    REFERENCES platform_categories (platform, slug)
    ON DELETE SET NULL;

-- The parent_slug index from 031 keeps working under the new name.
ALTER INDEX IF EXISTS idx_trustpilot_categories_parent
  RENAME TO idx_platform_categories_parent;

CREATE INDEX IF NOT EXISTS idx_platform_categories_platform
  ON platform_categories (platform);

-- ── 5. Rename trustpilot_countries → platform_countries ─────────
ALTER TABLE IF EXISTS trustpilot_countries
  RENAME TO platform_countries;

ALTER TABLE IF EXISTS platform_countries
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'trustpilot';

ALTER TABLE IF EXISTS platform_countries
  DROP CONSTRAINT IF EXISTS trustpilot_countries_pkey;

-- Idempotent: drop our own PK if a prior partial run already added it.
ALTER TABLE IF EXISTS platform_countries
  DROP CONSTRAINT IF EXISTS platform_countries_pkey;

ALTER TABLE IF EXISTS platform_countries
  ADD CONSTRAINT platform_countries_pkey PRIMARY KEY (platform, code);

CREATE INDEX IF NOT EXISTS idx_platform_countries_platform
  ON platform_countries (platform);

-- ── 6. cleanup_runs (audit for screenshot cleanup cron) ─────────
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at            timestamptz NOT NULL DEFAULT now(),
  orphans_deleted   int NOT NULL DEFAULT 0,
  aged_deleted      int NOT NULL DEFAULT 0,
  errors            jsonb,
  duration_ms       int
);

CREATE INDEX IF NOT EXISTS idx_cleanup_runs_run_at
  ON cleanup_runs (run_at DESC);

-- ============================================================
-- Verification queries (run manually after applying):
--
--   -- Trustpilot leads should all have a presence row
--   SELECT
--     (SELECT count(*) FROM leads WHERE trustpilot_url IS NOT NULL) AS legacy,
--     (SELECT count(*) FROM lead_platform_presences WHERE platform='trustpilot') AS presences;
--   -- (both numbers should match)
--
--   -- Existing taxonomy rows all platform-tagged
--   SELECT platform, count(*) FROM platform_categories GROUP BY 1;
--   SELECT platform, count(*) FROM platform_countries  GROUP BY 1;
--
--   -- Scrape jobs have filters backfilled
--   SELECT count(*) FROM scrape_jobs WHERE filters IS NULL;  -- expect 0
-- ============================================================
