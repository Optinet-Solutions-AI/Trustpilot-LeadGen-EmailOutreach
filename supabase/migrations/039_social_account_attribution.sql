-- Migration 039 — Social platforms schema (Facebook / Instagram) — APPLIED.
--
-- Supersedes the never-applied 037_social_platforms_skeleton.sql by folding
-- its content into a single migration alongside two gap-fix columns that
-- surfaced during M1 planning (docs/superpowers/plans/... master plan).
-- 037 is intentionally left untouched on disk for historical traceability;
-- this file is the authoritative DDL for the social-platforms surface.
-- Matching design spec: docs/superpowers/specs/2026-05-18-social-platforms-design.md
--
-- What this migration introduces:
--   1. social_accounts — one row per logged-in FB/IG account, holding
--      encrypted cookies, status, and per-account rate limits. Mirrors
--      the email_accounts pattern for per-mailbox sender management.
--   2. lead_platform_posts — links a post URL we observed an author in
--      back to their lead row. Powers {{post_excerpt}} / {{post_url}}
--      personalization in cold-outreach templates.
--   3. lead_platform_presences additive columns — author_handle,
--      follower_count, is_business_profile (nullable, non-breaking).
--   4. scrape_jobs.social_account_id — attribution FK so a job that hits
--      a captcha can be traced back to the exact account that ran it.
--   5. campaign_leads.channel — distinguishes email sends from future
--      DM sends. Backfills existing rows to 'email'.
--
-- Idempotent: uses IF NOT EXISTS guards everywhere. Re-applying is safe.

BEGIN;

-- ── 1. social_accounts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS social_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform        text NOT NULL CHECK (platform IN ('facebook', 'instagram')),
    handle          text NOT NULL,
    display_name    text,
    -- Cookies are encrypted at the application layer with a key in the
    -- CRM_ACCOUNT_ENCRYPTION_KEY env var (AES-256-GCM via server/src/lib/encryption.ts
    -- once M2 lands). Never stored in plaintext.
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

-- ── 2. lead_platform_posts ─────────────────────────────────────────────
-- One row per (lead, post observed). When the scraper sees an author
-- across multiple posts in a monitored group, each post lands here.
-- Template engine surfaces the most-recent post via {{post_excerpt}} /
-- {{post_url}} tokens (wired in M8).
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

-- ── 3. Extend lead_platform_presences with social-specific fields ─────
-- These are nullable adds so existing rows remain valid. Captures social
-- profile metadata that's per-platform (e.g. follower_count differs across
-- IG vs FB even for the same business).
ALTER TABLE lead_platform_presences
    ADD COLUMN IF NOT EXISTS author_handle      text,
    ADD COLUMN IF NOT EXISTS follower_count     int,
    ADD COLUMN IF NOT EXISTS is_business_profile boolean;

-- ── 4. scrape_jobs.social_account_id ──────────────────────────────────
-- Attribution FK: when a scrape run hits a captcha or burns its account's
-- daily cap, we need to know which social_accounts row owned the session.
-- Nullable because legacy review-platform jobs (Trustpilot/Yelp/TripAdvisor)
-- have no social account.
ALTER TABLE scrape_jobs
    ADD COLUMN IF NOT EXISTS social_account_id uuid
    REFERENCES social_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scrape_jobs_social_account_idx
    ON scrape_jobs (social_account_id)
    WHERE social_account_id IS NOT NULL;

-- ── 5. campaign_leads.channel ─────────────────────────────────────────
-- Distinguishes email sends (today's only path) from DM sends (M11 stub,
-- v2 full). NOT NULL with DEFAULT so existing rows backfill to 'email'.
-- The CHECK keeps the value space tight; new channels require a migration.
ALTER TABLE campaign_leads
    ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_channel_check;
ALTER TABLE campaign_leads
    ADD CONSTRAINT campaign_leads_channel_check
    CHECK (channel IN ('email', 'dm_facebook', 'dm_instagram'));

COMMENT ON COLUMN campaign_leads.channel IS
    'Delivery channel for this campaign lead. ''email'' is the legacy default;
     ''dm_facebook'' / ''dm_instagram'' route through the social DM lane
     (scaffolded in M11 of the social-platforms master plan, full impl v2).';

COMMIT;
