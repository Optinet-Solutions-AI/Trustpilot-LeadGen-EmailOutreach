-- Migration 045 — fb_group_candidates: assisted-join queue for FB groups the
-- scraping account is NOT a member of. Read-only intelligence; the operator
-- joins groups manually and status auto-flips to 'joined' on the next scrape.
-- Design: docs/superpowers/specs/2026-06-08-fb-group-membership-queue-design.md
-- Idempotent: IF NOT EXISTS guards. Safe to re-apply.

BEGIN;

CREATE TABLE IF NOT EXISTS fb_group_candidates (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform           text NOT NULL DEFAULT 'facebook',
    group_id           text NOT NULL,
    name               text,
    member_count_text  text,
    is_private         boolean,
    relevance_tier     int,
    niche              text,
    location           text,
    status             text NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'joined', 'ignored')),
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    joined_detected_at timestamptz,
    UNIQUE (platform, group_id)
);

CREATE INDEX IF NOT EXISTS fb_group_candidates_queue_idx
    ON fb_group_candidates (platform, status, relevance_tier DESC, last_seen_at DESC);

COMMIT;
