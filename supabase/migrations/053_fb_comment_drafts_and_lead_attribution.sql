-- Migration 053 — FB optional comment path: drafts table + per-lead account attribution.
--
-- Phase 2 of the country-pinned fleet (spec: docs/superpowers/specs/2026-06-24-fb-country-pinned-fleet-design.md).
--   1. lead_comment_drafts — one row per AI-drafted, operator-reviewed comment
--      for a lead's post. Never auto-sent; status gates the lifecycle.
--   2. social_account_id on lead_platform_presences + lead_platform_posts —
--      per-lead attribution so opening/commenting on a lead uses ONLY that
--      lead's own account (operator directive 2026-06-24), not just any
--      account pinned to the country. Nullable: backfilled going forward.
--
-- Idempotent: IF NOT EXISTS guards everywhere. Re-applying is safe.

BEGIN;

-- ── 1. lead_comment_drafts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_comment_drafts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    post_url    text NOT NULL,
    account_id  uuid REFERENCES social_accounts(id) ON DELETE SET NULL,
    draft_text  text NOT NULL,
    status      text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','approved','posted','discarded','failed')),
    error       text,
    posted_at   timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_comment_drafts_lead_idx   ON lead_comment_drafts (lead_id);
CREATE INDEX IF NOT EXISTS lead_comment_drafts_status_idx ON lead_comment_drafts (status);

-- ── 2. Per-lead account attribution ────────────────────────────────────
-- Which FB/IG account captured this presence/post — so per-lead actions
-- (open profile, comment) run on the SAME account, not just a country match.
ALTER TABLE lead_platform_presences
    ADD COLUMN IF NOT EXISTS social_account_id uuid
    REFERENCES social_accounts(id) ON DELETE SET NULL;

ALTER TABLE lead_platform_posts
    ADD COLUMN IF NOT EXISTS social_account_id uuid
    REFERENCES social_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lead_platform_presences_account_idx
    ON lead_platform_presences (social_account_id)
    WHERE social_account_id IS NOT NULL;

COMMIT;
