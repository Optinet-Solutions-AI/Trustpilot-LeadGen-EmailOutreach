-- ============================================================
-- 036_tripadvisor_cities.sql
-- Seeds the universe of TripAdvisor cities the scraper can fan out
-- across when a user picks a country. One row per (country, city);
-- populated by tools/scraper/seed_tripadvisor_cities.py.
-- ============================================================

CREATE TABLE IF NOT EXISTS tripadvisor_cities (
  geo_id       text        PRIMARY KEY,           -- TripAdvisor geo identifier, e.g. "60745"
  country_code text        NOT NULL,              -- ISO-2, matches leads.country, e.g. "US"
  name         text        NOT NULL,              -- "Boston"
  slug         text        NOT NULL,              -- "Boston_Massachusetts"
  rank         int         NOT NULL DEFAULT 0,    -- ordering hint within a country
  active       boolean     NOT NULL DEFAULT true, -- soft-disable bad rows without delete
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tripadvisor_cities_country_active_rank_idx
  ON tripadvisor_cities (country_code, active, rank);

COMMENT ON TABLE tripadvisor_cities IS
  'Seed of TripAdvisor city geo IDs per country. Populated by tools/scraper/seed_tripadvisor_cities.py. Read by scrape-runner when a user scrapes by country.';
