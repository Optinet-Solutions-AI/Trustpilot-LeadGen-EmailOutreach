-- Migration 037 — Social platforms (Facebook / Instagram / Groups) — SKELETON.
--
-- DO NOT APPLY YET. This migration is committed as a designed-but-deferred
-- artifact so reviewers can pressure-test the schema before the first social
-- platform implementation lands. Apply only when ready to build the Facebook
-- or Instagram plugin. The matching design spec is at
-- docs/superpowers/specs/2026-05-18-social-platforms-design.md.
--
-- What this migration introduces:
--   1. social_accounts — one row per logged-in FB/IG account, holding
--      encrypted cookies, status, and per-account rate limits. Mirrors
--      the pattern email_accounts established for per-mailbox sender
--      management.
--   2. lead_platform_posts — links a post URL we observed an author in
--      back to their lead row. Powers "this is the post we saw them in"
--      personalization in cold-outreach templates.
--
-- Idempotent: uses IF NOT EXISTS guards everywhere. Re-applying is safe.

BEGIN;

-- ── social_accounts ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS social_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform        text NOT NULL CHECK (platform IN ('facebook', 'instagram')),
    handle          text NOT NULL,
    display_name    text,
    -- Cookies are pgp_sym_encrypt'd at the application layer with a key
    -- in CRM_ACCOUNT_ENCRYPTION_KEY env var. Never stored in plaintext.
    encrypted_cookies   text,
    -- Account state lifecycle: active → checkpoint (captcha hit) → active
    -- after manual recovery, or → banned (permanent). disabled = operator
    -- soft-disabled, ignored by the scraper.
    status          text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'checkpoint', 'banned', 'disabled')),
    daily_cap       int NOT NULL DEFAULT 50,
    hourly_cap      int NOT NULL DEFAULT 10,
    used_today      int NOT NULL DEFAULT 0,
    used_this_hour  int NOT NULL DEFAULT 0,
    last_login_at   timestamptz,
    last_used_at    timestamptz,
    last_checkpoint_at  timestamptz,
    checkpoint_reason   text,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, handle)
);

CREATE INDEX IF NOT EXISTS social_accounts_status_idx
    ON social_accounts (platform, status, used_today)
    WHERE status = 'active';

-- ── lead_platform_posts ────────────────────────────────────────────────
-- One row per (lead, post observed). When the scraper sees an author
-- across multiple posts in a monitored group, each post lands here.
-- Template engine surfaces the most-recent post via {{post_excerpt}} /
-- {{post_url}} tokens (added in a follow-up campaign migration).
CREATE TABLE IF NOT EXISTS lead_platform_posts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    platform        text NOT NULL CHECK (platform IN ('facebook', 'instagram')),
    post_url        text NOT NULL,
    group_id        text,
    group_name      text,
    content_excerpt text,
    posted_at       timestamptz,
    media_urls      jsonb,
    scraped_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, post_url)
);

CREATE INDEX IF NOT EXISTS lead_platform_posts_lead_idx
    ON lead_platform_posts (lead_id, platform);
CREATE INDEX IF NOT EXISTS lead_platform_posts_group_idx
    ON lead_platform_posts (platform, group_id)
    WHERE group_id IS NOT NULL;

-- ── Extend lead_platform_presences with social-specific fields ────────
-- These are nullable adds so existing rows remain valid. Captures social
-- profile metadata that's redundant with leads but more granular per
-- platform (e.g. follower_count differs across IG vs FB even for same
-- business).
ALTER TABLE lead_platform_presences
    ADD COLUMN IF NOT EXISTS author_handle      text,
    ADD COLUMN IF NOT EXISTS follower_count     int,
    ADD COLUMN IF NOT EXISTS is_business_profile boolean;

COMMIT;
