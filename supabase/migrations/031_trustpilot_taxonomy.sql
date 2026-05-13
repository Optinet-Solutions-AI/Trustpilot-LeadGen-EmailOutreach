-- ============================================================
-- 031_trustpilot_taxonomy.sql
-- Persists the Trustpilot taxonomy discovered by the
-- tools/scraper/discover_taxonomy.py tool so the Scrape page
-- can offer every category + country Trustpilot actually
-- exposes, not the hardcoded subset shipped today.
--
-- Purely additive — no touch on scrape_jobs, leads, campaigns.
-- ============================================================

CREATE TABLE IF NOT EXISTS trustpilot_categories (
  slug          text PRIMARY KEY,
  parent_slug   text REFERENCES trustpilot_categories(slug) ON DELETE SET NULL,
  display_name  text NOT NULL,
  sort_order    int  NOT NULL DEFAULT 0,
  business_count int,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trustpilot_categories_parent
  ON trustpilot_categories(parent_slug);

CREATE TABLE IF NOT EXISTS trustpilot_countries (
  code          text PRIMARY KEY,           -- ISO 2-letter, uppercase
  name          text NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
