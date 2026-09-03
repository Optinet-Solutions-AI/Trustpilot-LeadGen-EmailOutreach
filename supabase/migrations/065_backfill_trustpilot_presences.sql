-- 065 — Backfill the Trustpilot rows in lead_platform_presences.
--
-- WHY
-- Trustpilot is the legacy path: its identity still lives in
-- `leads.trustpilot_url`, and migration 032 added the presence mirror later
-- without backfilling it. Every per-platform query is an INNER JOIN on
-- lead_platform_presences (see getLeads / getVerificationCounts in
-- server/src/db/leads.ts), so a Trustpilot lead with no presence row is
-- invisible to the campaign wizard's platform filter and to the per-platform
-- Trustpilot Leads page — while looking perfectly healthy in the Lead Matrix.
--
-- Measured 2026-09-03, before this migration:
--   13,309 leads carry trustpilot_url
--   10,357 have a trustpilot presence row
--    2,952 have none  <-- invisible to platform=trustpilot
--
-- Of the 648 leads that are outreach_status='new' + verified valid + have an
-- address (i.e. mailable today), 529 were in that invisible set. The wizard
-- showed 86 sendable where the real figure was 615.
--
-- Two contributing causes, both covered here:
--   1. Pre-032 history — 2,361 of the gaps were created in May 2026, before
--      the mirror existed.
--   2. A silent write failure that is still live — _upsert_presences() in
--      tools/db/upsert_leads.py catches a failed batch, prints
--      FAILED:upsert_presence and returns a short count, and the scrape still
--      reports success. All 16 September gaps came from one PL casino job on
--      2026-09-02. This migration repairs the data; the tool still needs the
--      shortfall to fail loudly, otherwise the gap re-opens.
--
-- SAFETY
-- `leads.trustpilot_url` is UNIQUE, and it was verified that none of the
-- 2,952 missing URLs is already claimed as a profile_url by a different lead
-- (0 re-pointed rows), so nothing here can steal an existing presence from
-- another lead. The NOT EXISTS guard plus ON CONFLICT DO NOTHING make this
-- idempotent — re-running it is a no-op.
--
-- Values mirror the legacy denormalized columns one-to-one, exactly as
-- _build_presence_rows() does for a live scrape, so the cleanup migration
-- that eventually drops those columns loses nothing.

INSERT INTO lead_platform_presences (
  lead_id,
  platform,
  profile_url,
  rating,
  screenshot_path,
  platform_email,
  scraped_at
)
SELECT
  l.id,
  'trustpilot',
  l.trustpilot_url,
  l.star_rating,
  l.screenshot_path,
  l.trustpilot_email,
  -- No scrape timestamp survives on the lead itself, so fall back to when the
  -- lead row was created. Closer to the truth than now(), which would make
  -- 13k historical leads look freshly scraped.
  COALESCE(l.created_at, now())
FROM leads l
WHERE l.trustpilot_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM lead_platform_presences p
    WHERE p.lead_id = l.id
      AND p.platform = 'trustpilot'
  )
ON CONFLICT (platform, profile_url) DO NOTHING;

-- Verification — expect `missing` to be 0 after this runs:
--
--   SELECT count(*) FILTER (WHERE p.id IS NULL) AS missing,
--          count(*)                             AS total_trustpilot_leads
--   FROM leads l
--   LEFT JOIN lead_platform_presences p
--     ON p.lead_id = l.id AND p.platform = 'trustpilot'
--   WHERE l.trustpilot_url IS NOT NULL;
