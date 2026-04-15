-- 014_affiliates.sql
-- Affiliate Monitor: stores Trustpilot affiliate pages tracked for reputation management

CREATE TABLE IF NOT EXISTS affiliates (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  description text,
  tp_url      text,
  website     text,
  warning     boolean     NOT NULL DEFAULT false,
  reviews     integer,
  rating      numeric(3,1),
  geo         text[]      NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliates_geo_idx ON affiliates USING GIN (geo);
