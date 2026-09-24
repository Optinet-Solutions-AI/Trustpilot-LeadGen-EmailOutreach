-- What a scrape cost, kept on the job itself.
--
-- TripAdvisor and Yelp are the two platforms that cannot be scraped for free:
-- every run spends ScrapingBee credits, Apify items or OpenAI calls. None of
-- that surfaced anywhere in the app, so the only way to learn what a run cost
-- was to open the vendor's console afterwards. That is how a Spanish
-- TripAdvisor run burned 101,595 ScrapingBee credits against a 1,000
-- allowance on 2026-09-24 and still reported "completed, 0 found".
--
-- cost_usd is the total where we can price it. cost_detail keeps the
-- per-vendor breakdown INCLUDING native units, because ScrapingBee credits
-- are real spend even when the dollar rate is unknown, and a run that reports
-- "$0.00" while consuming 150 credits would be worse than reporting nothing.
--
--   cost_detail = {
--     "byVendor": [
--       {"vendor":"openai","usd":0.34,"units":4,"unitLabel":"leads"},
--       {"vendor":"scrapingbee","usd":0,"units":150,"unitLabel":"credits"}
--     ],
--     "usdPerLead": 0.085
--   }

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS cost_usd numeric(12, 6),
  ADD COLUMN IF NOT EXISTS cost_detail jsonb;

COMMENT ON COLUMN scrape_jobs.cost_usd IS
  'Total vendor spend for this job in USD. NULL means the job predates cost '
  'tracking; 0 means it genuinely cost nothing (a free browser path).';

COMMENT ON COLUMN scrape_jobs.cost_detail IS
  'Per-vendor breakdown with native units. ScrapingBee credits are recorded '
  'even when no USD rate is configured.';
