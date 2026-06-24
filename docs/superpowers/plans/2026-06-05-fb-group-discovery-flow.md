# FB Group-First Consumer Scraping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the already-implemented group-first scrape flow so consumer-mode FB scrapes hit `/groups/<id>/search/?q=` instead of the open feed `/search/posts/?q=`.

**Architecture:** Minimal-change reroute. The full pipeline (`_sync_discover_groups` → group filter → `_sync_group_first_scrape` → `_extract_posts_from_group_search`) is already implemented and unused at `tools/scraper/platforms/facebook.py:1760-1928`. We rewire the public `search_posts(query, filters)` method to delegate to `_sync_group_first_scrape(niche, location)` when `groups_only` is truthy (default), keeping the existing open-feed path as an escape hatch for `groups_only=false`. No new files; no new run.py actions; no scrape-runner.ts changes.

**Tech Stack:** Python 3 (Selenium + undetected-chromedriver), existing PostStub TypedDict, existing consumer-filter chain (substring + Gemini classifier).

---

## Why this plan is so small

The May-27 spec specified the full group-first design. Most of the implementation landed in `facebook.py` over the past two weeks (verified by reading the file). The only thing missing is the rewire — `search_posts` calls the wrong internal helper. The earlier `groups_only: true` injection (commit `7965070`) was already laying the groundwork; it puts the flag in the right place but the dispatcher ignores it and goes to the open feed anyway.

Spec coverage:
- §Workflow.1 group discovery → already done by `_sync_discover_groups` (called from `_sync_group_first_scrape`)
- §Workflow.2 per-group search → already done by `_sync_group_first_scrape`'s loop body (uses `_extract_posts_from_group_search`)
- §Workflow.3 completed event → already emitted by `_sync_group_first_scrape` via `_emit(on_progress, 'search_done', total=...)`
- §Code-level changes 1-6 in spec — all already present in facebook.py
- §Streaming events `groups_found`, `group_progress`, `group_posts_kept`, `business_filtered` — already emitted

What's NOT yet in place:
- `search_posts` routing — Task 1 below
- The open-feed `_sync_search_posts` still appends `&filters=groups` which is the failed band-aid from commit `7965070` — Task 2 strips it so the escape hatch is vanilla open-feed
- Verification on the Windows EC2 worker — Task 3

---

## File structure (existing files only)

```
tools/scraper/platforms/facebook.py
├── _sync_discover_groups        (line ~1760) ✓ implemented
├── _sync_group_first_scrape     (line 1833)  ✓ implemented, UNUSED
├── _sync_search_inside_group    (line 1896)  ✓ implemented (helper, unused)
├── _extract_posts_from_group_search (line 1579) ✓ implemented
├── search_posts                 (line 2094)  ← MODIFY (Task 1): route to _sync_group_first_scrape when groups_only
└── _sync_search_posts           (line 2254)  ← MODIFY (Task 2): strip the &filters=groups URL hint
```

No frontend changes. No scrape-runner.ts changes. No run.py changes. Single file, two surgical edits.

---

## Task 1: Route `search_posts` to group-first flow when `groups_only` is set

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:2094-2180` (the public `search_posts` async method)

The current method calls `_sync_search_posts` (open feed) unconditionally. Add a branch at the top: if `filters.get('groups_only', True)` is truthy, call `_sync_group_first_scrape` instead. The consumer-filter chain (substring + Gemini, lines 2121-2179) runs on the returned stubs regardless of source.

- [ ] **Step 1.1: Re-read the current `search_posts` to confirm the integration point**

Run: `grep -n "async def search_posts\|_sync_search_posts\|_sync_group_first_scrape" tools/scraper/platforms/facebook.py`

Expected output (line numbers may shift but structure is the same):
```
1833:    def _sync_group_first_scrape(
2094:    async def search_posts(
2105:        stubs = await asyncio.to_thread(
2106:            self._sync_search_posts, query, groups_only, max_results or 50, on_progress,
2254:    def _sync_search_posts(
```

Confirm `_sync_group_first_scrape` takes `(niche, location, on_progress)` — niche and location come from `filters['niche']` and `filters['location']`.

- [ ] **Step 1.2: Add the group-first branch at the top of `search_posts`**

Open `tools/scraper/platforms/facebook.py`. Find the line `groups_only = bool(filters.get('groups_only'))` (currently line ~2104) and the very next line `stubs = await asyncio.to_thread(...)`. Replace those two lines with this block:

```python
        # Route: when groups_only is set (the operator's default — set
        # server-side in scrape-runner.ts for consumer-mode jobs), use the
        # group-discovery → per-group search pipeline implemented at
        # _sync_group_first_scrape. This is the May-27 design and is the
        # ONLY path that yields real consumer asks; the open-feed search
        # is dominated by ads phrased as "Looking for X?".
        #
        # Escape hatch: pass groups_only=False to filters to revert to the
        # open-feed scrape (kept for parity testing + rollback).
        groups_only = bool(filters.get('groups_only', True))
        niche = (filters.get('niche') or '').strip()
        location = (filters.get('location') or filters.get('country') or '').strip()
        if groups_only:
            if not niche or not location:
                raise ValueError(
                    "Group-first search requires both 'niche' and 'location' in filters. "
                    "Pass groups_only=False to fall back to the open-feed search."
                )
            stubs = await asyncio.to_thread(
                self._sync_group_first_scrape, niche, location, on_progress,
            )
        else:
            stubs = await asyncio.to_thread(
                self._sync_search_posts, query, False, max_results or 50, on_progress,
            )
```

Notes:
- `groups_only` default flipped from `False` (the existing `bool(filters.get('groups_only'))`) to `True` (`bool(filters.get('groups_only', True))`). This makes group-first the default everywhere — including any direct CLI invocation that forgets to pass the flag. The scrape-runner injection from commit `7965070` is now belt-and-suspenders (safe to leave; can be cleaned up later).
- The fallback `_sync_search_posts` call now passes `False` for its `groups_only` parameter explicitly, since the URL-hint behavior (`&filters=groups`) is being removed in Task 2.
- The `niche` and `location` extraction was previously done LATER in the method (around line 2113-2114, for stamping country/category onto stubs). After this edit, those later lines reference the same variables — re-read and verify they still work; if there's a `niche = (filters.get('niche')...).strip()` line further down, leave it alone (Python doesn't care about reassignment) OR delete the redundancy.

- [ ] **Step 1.3: Verify the later country/category-stamping code still works**

After your edit, scroll down to the block starting `# Stamp country/category from the operator's filters` (was around line 2108). The block reads:

```python
niche = (filters.get('niche') or filters.get('category') or '').strip() or None
location = (filters.get('location') or filters.get('country') or '').strip() or None
```

These are LOCAL reassignments inside the same method — Python overwrites the earlier `niche`/`location` values. The new values fall back to `category` (vs. only `niche`) and resolve to `None` when empty. That's fine because they're only used to STAMP onto already-collected stubs at this point.

**Action:** Leave this block untouched. It does no harm.

- [ ] **Step 1.4: Verify the consumer-filter chain at the bottom of `search_posts` runs on group-first stubs**

The consumer-filter chain (lines 2136-2178) operates on the `stubs` variable. After Task 1.2 it receives stubs from either source. Reading the chain:

```python
is_consumer_mode = (filters.get('lead_type') or 'consumers').lower() == 'consumers'
if is_consumer_mode and stubs:
    exclude_businesses = filters.get('exclude_businesses', True)
    asking_only = filters.get('asking_only', True)
    use_llm_classifier = filters.get('use_llm_classifier', True)
    # ... substring filter chain
    # ... LLM classifier
```

Group-first scrapes from the May-27 spec have `lead_type='consumers'` set by the operator, so this chain runs and applies the same exclusion + Gemini logic as before. PostStubs from `_extract_posts_from_group_search` include `content_excerpt` and `author_handle`, the two fields the chain reads. No code change needed — just verify by reading.

- [ ] **Step 1.5: Type-check (Python doesn't have a strict type-checker in this repo)**

Run: `.venv/Scripts/python.exe -c "import tools.scraper.platforms.facebook"`

Expected: no output (clean import). If you see an `ImportError` for a missing helper, the wiring is incomplete. If you see a `SyntaxError`, fix the edit.

(The repo's `.venv` Python may be broken — earlier in this session it errored on `email.parser` from a 3.14 stdlib mismatch. If so, skip this step and rely on Task 3's live verification scrape to catch errors.)

- [ ] **Step 1.6: Commit**

```bash
git add tools/scraper/platforms/facebook.py
git commit -m "feat(scraper): route FB consumer search_posts to group-first pipeline"
```

---

## Task 2: Strip the dead `&filters=groups` URL hint from `_sync_search_posts`

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:2267-2270` (the URL-construction block)

The earlier commit `7965070` appended `&filters=groups` to the open-feed search URL when `groups_only=True`. We verified at 11:43 UTC that this URL hint yields 0 posts in practice — FB's built-in groups filter is not what the spec intended. Strip it so the escape hatch (`groups_only=False`) is vanilla open-feed.

- [ ] **Step 2.1: Read the URL-construction block in `_sync_search_posts`**

Run: `grep -n "search_url\|filters=groups" tools/scraper/platforms/facebook.py`

Expected output around line 2267:
```python
search_url = f'{FB_BASE}/search/posts/?q={quote_plus(query)}'
if groups_only:
    # The "in groups" filter has a stable URL hint.
    search_url += '&filters=groups'
driver.get(search_url)
```

- [ ] **Step 2.2: Remove the URL-hint conditional**

Replace the block above with:

```python
        search_url = f'{FB_BASE}/search/posts/?q={quote_plus(query)}'
        # Note: the previous `&filters=groups` URL hint was empirically a
        # no-op (0 posts returned). Group-first scraping is now the
        # default path via _sync_group_first_scrape; this fallback path
        # runs only when the operator explicitly opts out of groups_only.
        driver.get(search_url)
```

The `groups_only` parameter is still accepted by `_sync_search_posts` for signature stability, but the value is no longer used inside the function. Linting may warn about the unused parameter — that's fine; leaving the signature intact avoids touching every call site.

- [ ] **Step 2.3: Verify no other code reads the `&filters=groups` URL pattern**

Run: `grep -rn "filters=groups" tools/scraper/`

Expected output: empty (no references). If anything else still mentions it, leave alone — it's likely a comment in this plan or unrelated string.

- [ ] **Step 2.4: Commit**

```bash
git add tools/scraper/platforms/facebook.py
git commit -m "fix(scraper): strip dead &filters=groups URL hint from open-feed fallback"
```

---

## Task 3: Push, deploy to Windows EC2, verify end-to-end

The Windows EC2 worker auto-deploys via the Task Scheduler entry that we just verified is buggy (LastRunTime blank). Until that's fixed in a separate session, deploys still need a manual nudge via SSM.

- [ ] **Step 3.1: Push to main**

```bash
git push origin main
```

Expected: `5a05185..<new-SHA> main -> main` (two new commits).

- [ ] **Step 3.2: Manual deploy on Windows EC2 (paste this in SSM)**

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
cd C:\scraper
git pull --ff-only origin main
git log -1 --oneline
cd C:\scraper\server
npm run build
nssm restart scraper-worker
Start-Sleep -Seconds 5
Get-Service scraper-worker | Format-List Name,Status
Remove-Item C:\scraper-deploy\last_attempted_commit -Force -ErrorAction SilentlyContinue
```

Expected:
- `git log -1 --oneline` → the new commit SHA (Task 2's commit, since it's the most recent)
- `npm run build` → clean `tsc` (no errors)
- `nssm restart` → STOP + START both successful
- `Get-Service` → Status: Running

We skip `npm ci` here because the test scrape only touches the scrape-runner.ts compiled output; Python changes don't need npm at all. If the npm build complains about missing deps, run `npm ci` first.

(Reminder: Python files don't compile — the worker invokes `python.exe tools/scraper/run.py` directly on the source. So step 3.2 is sufficient for the Python edits in Task 1+2.)

- [ ] **Step 3.3: Trigger a verification scrape**

From the local box, run:

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2- | tr -d '"')
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"')
PAYLOAD='{"country":"_facebook_","category":"all","min_rating":1,"max_rating":3.5,"enrich":false,"verify":false,"status":"pending","platform":"facebook","source":"manual","priority":100,"max_attempts":5,"filters":{"niche":"handyman","query":"looking for handyman London","enrich":false,"verify":false,"location":"London","lead_type":"consumers","max_results":10}}'
curl -sS "$SUPABASE_URL/rest/v1/scrape_jobs" -X POST -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "$PAYLOAD" | head -c 300
```

Capture the job ID from the response.

- [ ] **Step 3.4: Watch the scrape in real time**

The flow will take longer than open-feed (10-25 min per the spec). Poll until terminal:

```bash
JOB_ID="<paste here>"
SUPABASE_URL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2- | tr -d '"')
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"')
until curl -sS "$SUPABASE_URL/rest/v1/scrape_jobs?id=eq.$JOB_ID&select=status" -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" | grep -qE '"status":"completed"|"status":"failed"'; do
  CURR=$(curl -sS "$SUPABASE_URL/rest/v1/scrape_jobs?id=eq.$JOB_ID&select=status,worker_id,total_found,total_scraped,attempts" -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY")
  echo "[$(date -u +%H:%M:%S)] $CURR"
  sleep 30
done
echo "=== FINAL recent_events ==="
curl -sS "$SUPABASE_URL/rest/v1/scrape_jobs?id=eq.$JOB_ID&select=total_found,total_scraped,recent_events" -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY"
```

- [ ] **Step 3.5: Confirm the SSE events match the May-27 spec**

The `recent_events` array should now contain:
- `groups_found:count=<N>` — number of groups discovered
- `groups_filtered:dropped=<X>:kept=<Y>:reason=...` — professional/job groups filtered out
- `group_progress:n=<i>:total=<N>:group_name=...` — per-group iteration
- `group_posts_kept:count=<C>:group_name=...` — posts found in that group
- `search_done:total=<aggregate>` — total post stubs across all groups
- `consumer_filtered` and/or `llm_filtered` — the existing filter chain on those stubs
- `completed`

If `groups_found:count=0` — the group-discovery scrape is finding nothing. Possible causes: FB checkpoint, search query mismatch, account daily-cap hit (`used_today >= daily_cap`). Diagnose via the debug screenshot at `C:\scraper\.tmp\fb_search_debug.png` on the Windows EC2.

If `groups_found:count>0` but `total_found=0` — groups were discovered but no posts were extracted from any of them. Two possibilities:
- Each `group_posts_kept` event has `count=0` → in-group search returned no matches → may need broader keyword (`niche` only vs `looking for a {niche}`)
- Posts WERE extracted but the consumer-filter chain rejected all of them → check `consumer_filtered:dropped=...` and `llm_filtered:dropped=...`

Either way, the data tells us where to tune next — we're now in the right pipeline.

---

## Self-review

**Spec coverage** ✓
- Spec §Workflow.1 (group discovery) → Task 1 wires it up
- Spec §Workflow.2 (per-group post search) → Task 1 wires it up
- Spec §Workflow.3 (completed event) → already emitted, verified in Task 3.5
- Spec §Code-level changes (1-6) → all already in code; Task 1 rewires the entry point
- Spec §Streaming events → already emitted by `_sync_group_first_scrape`
- Spec §Escape hatch (groups_only=false → open feed) → Task 1.2 preserves it; Task 2 cleans the dead URL-hint

**Placeholder scan** ✓
No TBDs, no "implement later". Every step has explicit code or commands.

**Type consistency** ✓
- `_sync_group_first_scrape` returns `list[PostStub]` (per docstring) — same type the consumer-filter chain expects.
- `niche`/`location` extraction is consistent across Task 1.2 and the existing stamping block.
- `groups_only` parameter is preserved on `_sync_search_posts`'s signature for backwards compat (Task 2.2).

**Scope check** ✓
Two surgical edits to one Python file. Single PR. ~30-60 min of actual work + 10-25 min of verification scrape wall time.

**Risk assessment** ✓
- Existing open-feed path remains available via `groups_only=false` filter — instant rollback if group-first regresses.
- Edits don't touch the consumer-filter chain → existing dedup / substring / Gemini behavior preserved.
- No DB schema changes, no migration.
- Operator-facing UI unchanged (already shows "Searches public FB group posts..." copy from earlier).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-05-fb-group-discovery-flow.md`. Two execution options:

**1. Subagent-Driven** — fresh subagent per task, review between tasks
**2. Inline Execution** — execute tasks in this session using executing-plans

Given only 2 small Python edits + 1 deploy/verify task, **inline execution** is the right call. Both code edits live in one file and don't depend on each other for compilation, so there's no benefit to a fresh-context dispatch.

**Which approach?**
