# Facebook Group-First Consumer Scraping — Design

**Date:** 2026-05-27
**Status:** Approved — proceeding to implementation in this round.

## Context

The current Facebook consumer-mode scraper hits the open-feed search at
`/search/posts/?q=<query>`. Live testing showed that the open feed is
dominated by noise — clinic ads phrased as questions ("Looking for a
dentist? We've got you covered!"), thank-you posts ("Salamat doc..."),
recommendations, hiring ads — even after a strict asking-only post
filter. Real consumer asks tend to live inside **community groups**
("Cebu Buy & Sell", "Mandaue Recommendations") where the social
context already pre-filters most ads.

This spec replaces the open-feed flow with a two-step group-first
flow: discover groups matching niche + location, then run an in-group
search inside each.

## Goals

- Higher signal-to-noise: leads should be people genuinely asking
- Targetable by **niche** + **location** (the operator's two-axis filter)
- All discovered groups scraped (no arbitrary cap — operator chose this)
- Live-streamed progress with mid-flight cancel
- Real post permalinks where FB exposes them
- Anonymous posts captured but flagged unreachable

## Workflow

```
Operator inputs niche + location  →  one click "Start scrape"
                       │
                       ▼
1. Group discovery:
   GET /search/groups/?q=<niche>+<location>
   → list[Group{id, name, member_count, posts_per_day, is_public}]
                       │
                       ▼
2. Per-group post search (sequential, cancellable):
   for group in groups:
     GET /groups/<id>/search/?q=<niche>
     → list[PostCard]
     → strict asking-only filter
     → enrich authors (in-group user URL → /profile.php?id=)
     → upsert leads + presences + posts
   emits PROGRESS:group_progress:<n>/<N>:<name>
                       │
                       ▼
3. Completed event with final lead count
```

## Code-level changes

### `tools/scraper/platforms/facebook.py`

1. **New helpers** `_search_groups_for_query(driver, query)` and
   `_search_inside_group(driver, group_id, query)`.
2. **New URL patterns** for group post permalinks:
   - `/stories/<story_id>/UzpfSVNDOj...` (text post inside group)
   - `/photo/?fbid=A&set=gm.B&idorvanity=<group_id>` (photo post inside group)
3. **Author URL transformation**: in-group author links are
   `/groups/<gid>/user/<uid>/`. Transform to `https://www.facebook.com/profile.php?id=<uid>`
   so Messenger deep links work.
4. **Anonymous posts**: when author element matches "Anonymous
   participant" or no author link found, synthesize `author_handle =
   anonymous-<sha1(excerpt)[:12]>`, `profile_url = null`, tag
   `no_dm_possible`, set `outreach_status='lost'` on the leads row.
5. **New BUSINESS_PATTERNS**: `looking for patient`, `looking for a
   patient`, `looking for a model`, `looking for models`, `looking for
   volunteers` — these are clinics recruiting subjects.
6. **scrape_listing consumer mode** swaps to the two-step flow. The
   legacy open-feed path remains available when `groups_only=false`
   is passed explicitly (escape hatch).

### `frontend/src/components/ScrapeForm.tsx`

- Replace the single Keyword input with two fields:
  - **Niche**: free-text, e.g. `dentist`, `plumber`
  - **Location**: free-text, e.g. `Cebu`, `Cebu City`, `Mandaue`
- Concatenate server-side: groups query = `<niche> <location>`,
  in-group post query = `looking for a <niche>`.
- Remove the broken `groups_only` checkbox (the new flow IS group-first).

### Streaming events

```
PROGRESS:groups_found:<N>
PROGRESS:group_progress:<n>/<N>:<group_name>
PROGRESS:group_posts_kept:<count>:<group_name>
PROGRESS:business_filtered:<n>:<reason>
PROGRESS:completed
```

## Constraints + trade-offs we accepted

- **Rate budget**: each in-group search bumps the account's
  `used_today` counter by 1. Default cap is 50 → ~2-3 full runs/day
  per account. Caller already bumped local cap to 500.
- **Wall time**: 20-50 groups × ~30s per in-group search = 10–25
  minutes per scrape. Stream + cancellable mitigates the UX hit.
- **Group quality**: scraping all discovered groups means some will
  be wrong-niche (professional society, business directory). The
  asking-only post filter inside each group keeps the lead haul clean
  even when the group is wrong.
- **Permalinks**: group posts have stable URLs (`/stories/` or
  `/groups/<g>/posts/`). Open-feed text posts didn't — this is a real
  upgrade over the previous version.

## What's out of scope (next pass)

- Pinned-group whitelist per niche/location (the "third option" from
  brainstorming). Operator can add this later if all-groups-mode hits
  rate limits or noise problems.
- Iterating ALL pages of group discovery results (current code reads
  what's visible after initial scroll; FB groups search rarely has
  20+ groups for a given niche+location combo).
- Group-detail enrichment (description, rules, location tags). Group
  name + member count is enough for now.
