-- 049_lead_location_confidence.sql
-- Per-lead honesty flag describing how well leads.country (the operator's
-- SEARCH location) matches where the lead actually is. Written only by the FB
-- scraper / audit tool. Allowed values:
--   'confirmed_city' | 'same_country' | 'unconfirmed'
--   ('wrong_country' may appear via audit back-fill of pre-gate historical data)
-- NULL = not yet classified. Additive, non-breaking.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_confidence text;
