-- Migration 058 — fb_group_candidates.audience: customers vs trades label
-- for the Discovered Groups feature (docs/superpowers/specs/2026-06-08-
-- fb-group-membership-queue-design.md's table gets a second job here).
--
-- Facebook groups only ever arrived as a side effect of a post-search scrape
-- (a post's `associated_group` lands on lead_platform_posts). Nobody could
-- see the resulting list of groups, and a naive list is only half-useful:
-- some groups are customers asking to hire ("Find a Tradesman Bristol and
-- surrounding"), others are tradespeople talking to each other ("London
-- Builders And Other Tradesman Free Advertising") — worthless as leads.
--
-- NULL = not yet labelled. tools/scraper/label_fb_groups.py labels ONLY
-- rows where audience IS NULL, so every group gets exactly one Gemini
-- verdict ever — re-running the labeller is a cheap no-op once everything
-- has a value, and a freshly-captured group is picked up the next run
-- without re-labelling anything that already has one.
--
-- location + niche are NOT duplicated by a new column: the labeller reuses
-- the existing `location` column (already free text) to store the group's
-- own "<City>, <ISO2>" (or bare ISO2 when only the country is inferable),
-- overwriting whatever an earlier browser-crawl search context had put
-- there — that value was the OPERATOR'S search location, not the group's
-- own, so it was never reliable for this purpose anyway.
BEGIN;

ALTER TABLE fb_group_candidates
    ADD COLUMN IF NOT EXISTS audience text
        CHECK (audience IN ('customers', 'trades', 'unclear'));

COMMENT ON COLUMN fb_group_candidates.audience IS
    'Who posts in this group, judged from its name alone by Gemini '
    '(tools/scraper/label_fb_groups.py): customers = people asking to hire '
    '(valuable lead source); trades = practitioners talking to each other '
    '(worthless as customer leads); unclear = name alone is not enough to '
    'tell. NULL = not yet labelled.';

COMMIT;
