-- Migration 062 — Short-term-rental host portfolio size.
--
-- The Booking.com plugin sells property-management services, and how many
-- properties a host runs is the single most important thing about them: one
-- to five is an owner doing it all personally (the full-management pitch),
-- six or more is an agency with staff (the white-label cleaning pitch).
--
-- The COARSE tier already rides in leads.category as 'str-owner-host' /
-- 'str-pro-operator', because that column is what the campaign wizard filters
-- on and segmenting there needs no new plumbing. This column carries the
-- EXACT number, so the CRM can show "manages 12 properties" and a follow-up
-- can name it.
--
-- Nullable and unconstrained on purpose: every other platform leaves it null,
-- and upsert_leads.py strips nulls before writing, so nothing breaks if this
-- migration is applied late.

ALTER TABLE lead_platform_presences
  ADD COLUMN IF NOT EXISTS host_property_count int;

COMMENT ON COLUMN lead_platform_presences.host_property_count IS
  'Short-term-rental hosts only: number of listings collapsed into this lead. '
  'Set by the Booking.com plugin; null on every other platform.';
