# Design — FB Group Membership Queue (Assisted Join)

**Date:** 2026-06-08
**Status:** Approved (brainstorming → ready for implementation plan)
**Area:** full-stack — `tools/scraper/platforms/facebook.py`, Supabase migration, Express API, React CRM page
**Builds on:** `2026-06-08-fb-group-relevance-prioritization-design.md` + `2026-06-08-fb-non-english-ingroup-query-design.md` (group selection + query localization shipped; this addresses the membership ceiling those surfaced). See memory `project_fb_ingroup_membership`.

---

## Problem

The 2026-06-08 smokes proved the FB pipeline selects and queries the right groups, but
non-English yield is gated by **group membership**: FB in-group search returns 0 results for
a group the scraping account hasn't joined. The ideal Frankfurt group "(Elektriker Handwerker
Gesucht)" (26K members, `Private`) returned 0 posts because the account isn't a member. There
is currently no way to know which high-value groups need joining, or to track them.

## Goal

Surface a **ranked queue of high-value groups the account is NOT a member of**, so the
operator joins them manually (in their own logged-in FB session), and future scrapes can
search them. The system detects membership and auto-updates status; it never joins anything
itself.

**Success criteria:**
- After a Frankfurt scrape, the unjoined tier-2 groups (incl. "Elektriker Handwerker
  Gesucht") appear in the queue with `status='candidate'`, ranked by relevance.
- After the operator joins one manually, the next scrape flips its status to `joined`
  automatically (no manual marking required).
- The operator can view/sort the queue and dismiss irrelevant entries in the CRM.

## Non-Goals (explicit — keeps ban surface at zero)

- **No autonomous joining**, no clicking "Join" via a bot, no membership-question answering.
  Joining is 100% manual by the operator. This feature is read-only *intelligence*.
- No multi-account membership modeling (operator runs one FB account; YAGNI).
- No change to the scrape/prioritization/classifier logic beyond capturing membership.

---

## Architecture (4 layers)

### 1. Detection — Python, free at discovery time

`_sync_discover_groups` already parses each group card's text. An **unjoined** group's card
ends with the `Join` button label (live sample:
`"(Elektriker Handwerker Gesucht)\nPrivate · 26K members · 6 posts a day\nJoin"`). Add an
`is_member` field to each discovered group dict: `is_member = 'join' not in [the button
line(s), lowercased]`. (Detection is best-effort from the card; a group name literally
containing "join" is a rare false-negative we accept — worst case it's omitted from the
queue.) No extra navigation, no new requests → **zero added ban surface.**

### 2. Persistence — new Supabase table + upsert

New migration `045_fb_group_candidates.sql`:

```sql
CREATE TABLE IF NOT EXISTS fb_group_candidates (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform      text NOT NULL DEFAULT 'facebook',
    group_id      text NOT NULL,
    name          text,
    member_count_text text,
    is_private    boolean,
    relevance_tier int,                 -- 2 = niche/classifieds (only tier we queue)
    niche         text,                 -- the niche that surfaced it (translated term)
    location      text,
    status        text NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'joined', 'ignored')),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    joined_detected_at timestamptz,
    UNIQUE (platform, group_id)
);
CREATE INDEX IF NOT EXISTS fb_group_candidates_queue_idx
    ON fb_group_candidates (platform, status, relevance_tier DESC, last_seen_at DESC);
```

Keyed on `(platform, group_id)` — single-account simplicity.

In `_sync_group_first_scrape`, after tiering, for each discovered group:
- **tier-2 AND not a member** → upsert with `status='candidate'`, refresh `last_seen_at`,
  set `niche`/`location`/`member_count_text`/`is_private`. Don't overwrite a `joined`/`ignored`
  status back to `candidate`.
- **previously a candidate, now a member** (card no longer shows `Join`) → set
  `status='joined'`, `joined_detected_at=now()` (the auto-status flip). Only flips
  `candidate → joined`, never touches `ignored`.

The Python writes via the existing Supabase client (`table('fb_group_candidates')`, same
pattern `_claim_account` uses for `social_accounts`). Failures are logged and non-fatal — the
queue is an enrichment side-effect, never blocks a scrape.

### 3. API — Express, dedicated route `server/src/routes/social-groups.ts` → `/api/social-groups`

- `GET /api/social-groups/queue?status=candidate` → ranked list ordered by `relevance_tier`
  desc, then `last_seen_at` desc (member count is `text` like "26K members" → display-only,
  not a sort key). Default `status=candidate`. Returns `{success, data: [...]}` per the
  project's response contract.
- `PATCH /api/social-groups/queue/:id` body `{status}` → operator sets `joined`/`ignored`/
  back to `candidate`. Validates the enum.

DB access via a new `server/src/db/social-groups.ts` helper (list + updateStatus), mirroring
existing `server/src/db/*` modules. Mounted in `server.ts` next to `socialAccountsRoutes`.

### 4. Frontend — new CRM page `frontend/src/views/GroupQueue.tsx` + `hooks/useGroupQueue.ts`

A ranked table: group name (links to `https://facebook.com/groups/{group_id}` — opens in the
operator's logged-in session), member count, Private/Public badge, niche, location,
first-seen, status. Row actions: **Open in FB** (the join happens there, manually),
**Mark joined**, **Ignore**. A status filter (candidate / joined / ignored). Follows the
existing view + hook pattern (loading/error/data states per coding standards); added to the
dashboard nav near the Social Accounts entry.

---

## Data Flow

```
scrape (discovery) → card text → is_member per group
   → tier-2 + unjoined  → upsert fb_group_candidates (status=candidate)
   → was candidate, now member → status=joined (auto)
        ↓
GET /api/social-groups/queue → ranked JSON
        ↓
GroupQueue.tsx → operator opens group in FB session → joins manually
        ↓
next scrape discovery → card no longer shows "Join" → status flips to joined
        ↓
existing prioritizer searches the now-joined tier-2 group → real posts → classifier → leads
```

The yield payoff is automatic: once a group flips to `joined`, the already-shipped tier
prioritizer searches it on the next scrape with no further work.

## Error Handling

- Python upsert wrapped in try/except; logged via `_emit`/stderr, never aborts the scrape.
- `is_member` detection is best-effort; ambiguous cards default to treating the group as a
  member (omit from queue) to avoid spamming the queue with false candidates.
- API validates `status` against the enum; unknown → 400.

## Testing

### Unit
- **Python (pytest):** a pure `_card_is_member(card_text)` / parsing helper — assert the live
  Frankfurt gold-group card (`…\nJoin`) → not a member; a joined-group card (no `Join` line) →
  member; a group named with "join" handled per the documented default.
- **API:** `GET /queue` ranking order; `PATCH` enum validation + status update (against a test
  row or mocked DB per existing route-test conventions, if any — else a thin integration check).

### Live (mandatory before declaring done)
- Re-run electrician+Frankfurt → confirm `fb_group_candidates` has the unjoined tier-2 groups
  as `candidate` (incl. "Elektriker Handwerker Gesucht").
- Manually join one group in the FB session → re-run → confirm that row flips to `joined`.
- Load the CRM Group Queue page → confirm ranked list + actions work.

---

## Files Touched

- `supabase/migrations/045_fb_group_candidates.sql` (new)
- `tools/scraper/platforms/facebook.py` — `is_member` capture in `_sync_discover_groups`;
  candidate upsert + auto-flip in `_sync_group_first_scrape`; a small pure card-parse helper
- `tools/scraper/platforms/test_group_relevance.py` (or sibling) — card-parse unit tests
- `server/src/db/social-groups.ts` (new) — list + updateStatus
- `server/src/routes/social-groups.ts` (new) — GET queue, PATCH status; mount in `server.ts`
- `frontend/src/hooks/useGroupQueue.ts` (new)
- `frontend/src/views/GroupQueue.tsx` (new) + nav entry

## Impact / Blast Radius (confirm at plan time)

- `_sync_discover_groups` / `_sync_group_first_scrape` — additive (new field + side-effect
  upsert); existing return shape preserved.
- New table + new route + new page — purely additive; no existing API shape changes.
- Migration must be applied to Supabase before the Python upsert will succeed (sequence in plan).
