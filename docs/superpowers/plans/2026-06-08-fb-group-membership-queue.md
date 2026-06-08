# FB Group Membership Queue (Assisted Join) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a ranked queue of high-value FB groups the scraping account isn't a member of, so the operator joins them manually and future scrapes can search them — detected for free at discovery, with status auto-flipping to `joined` on the next scrape. No autonomous joining.

**Architecture:** Discovery already parses each group card; an unjoined group's card shows a `Join` button. Capture `is_member` from that, then upsert tier-2 unjoined groups into a new `fb_group_candidates` table (auto-flipping prior candidates to `joined` once they show as members). An Express route serves the ranked queue; a Next.js CRM page lets the operator open groups in FB and mark/ignore. Pure decision logic (`_card_is_member`, `_plan_candidate_writes`) is extracted for unit testing; the scrape integration does the I/O.

**Tech Stack:** Python 3.12 + pytest (scraper), Supabase/Postgres (migration), Express + TypeScript (API), Next.js app-router + React + axios + Tailwind (CRM).

**Spec:** `docs/superpowers/specs/2026-06-08-fb-group-membership-queue-design.md`

**Key facts (verified during planning):**
- Python writes to Supabase via `from tools.db.supabase_client import table` (already imported in `facebook.py`); pattern: `table('x').upsert(rows, on_conflict='platform,group_id').execute()`, `table('x').update({...}).eq(...).execute()`, `table('x').select('...').in_('group_id', gids).execute()`. `_now_iso()` and `_emit()` exist in `facebook.py`.
- Discovery card parsing is in `_sync_discover_groups` (~`facebook.py:2212-2224`): builds `lines`, `name`, `member_count_text`, `is_public`, appends a dict per group. `_sync_group_first_scrape` (~`facebook.py:2186+`) gates → `_order_and_cap_groups` → search loop; `_group_relevance_tier(name, location, niche)` and `_order_and_cap_groups(...)` already exist.
- Express: routes use `getSupabase()` from `../lib/supabase.js`, return `{ success, data }` or `{ success: false, error }`; mounted in `server/src/server.ts` via `app.use('/api/...', routes)`.
- Frontend: Next.js app-router. A page is `frontend/src/app/<route>/page.tsx` that renders a view from `frontend/src/views/`. Data via the axios client (`api.get/patch`) imported the same way `frontend/src/views/SocialAccounts.tsx` imports it. Nav entries live in the `NAV_ITEMS` array in `frontend/src/components/Sidebar.tsx`.
- Latest migration is `044`; this adds `045`.
- Run Python tests from repo root: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`. Type-check server: `cd server && npx tsc --noEmit`. Type-check frontend: `cd frontend && npx tsc --noEmit`.
- Do NOT push/deploy. Local commits only. The migration must be applied to Supabase (manual, Task 6) before the Python upsert works live.

---

## File Structure

- **Create** `supabase/migrations/045_fb_group_candidates.sql` — the queue table.
- **Modify** `tools/scraper/platforms/facebook.py` — `_card_is_member` + `_plan_candidate_writes` helpers; `is_member` capture in `_sync_discover_groups`; candidate recording in `_sync_group_first_scrape`.
- **Modify** `tools/scraper/platforms/test_group_relevance.py` — unit tests for the two helpers.
- **Create** `server/src/routes/social-groups.ts` — `GET /queue`, `PATCH /queue/:id`; **modify** `server/src/server.ts` to mount it.
- **Create** `frontend/src/hooks/useGroupQueue.ts`, `frontend/src/views/GroupQueue.tsx`, `frontend/src/app/group-queue/page.tsx`; **modify** `frontend/src/components/Sidebar.tsx` (nav entry).

---

## Task 1: Migration — `fb_group_candidates` table

**Files:**
- Create: `supabase/migrations/045_fb_group_candidates.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Sanity-check the SQL parses (local, optional)**

If a local psql is available: `psql "$DATABASE_URL" -f supabase/migrations/045_fb_group_candidates.sql` against a scratch DB. Otherwise visual review only — it's applied for real in Task 6 via the Supabase SQL editor.
Expected: no syntax errors; re-running is a no-op (guards).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/045_fb_group_candidates.sql
git commit -m "feat(db): add fb_group_candidates table for assisted-join queue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure helpers — `_card_is_member` + `_plan_candidate_writes`

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add two functions immediately AFTER `_order_and_cap_groups`)
- Test: `tools/scraper/platforms/test_group_relevance.py`

- [ ] **Step 1: Write the failing tests** (append to `tools/scraper/platforms/test_group_relevance.py`)

```python
from tools.scraper.platforms.facebook import _card_is_member, _plan_candidate_writes


def test_card_is_member_join_button_means_not_member():
    card = "(Elektriker Handwerker Gesucht)\nPrivate · 26K members · 6 posts a day\nJoin"
    assert _card_is_member(card) is False


def test_card_is_member_no_join_button_means_member():
    card = "Kleinanzeigen Frankfurt\nPublic · 50K members\nVisit"
    assert _card_is_member(card) is True


def test_card_is_member_name_containing_join_is_not_a_false_negative():
    # 'Join' only counts as a standalone button line, not inside the name.
    card = "Join My Local Group\nPublic · 1K members"
    assert _card_is_member(card) is True


def _grp(gid, tier, is_member, name="G", is_public=False):
    return {"group_id": gid, "name": name, "tier": tier, "is_member": is_member,
            "is_public": is_public, "member_count_text": "10K"}


def test_plan_candidate_writes_queues_tier2_unjoined():
    groups = [_grp("1", 2, False), _grp("2", 1, False), _grp("3", 0, False)]
    plan = _plan_candidate_writes(groups, {}, "Elektriker", "Frankfurt", "2026-06-08T00:00:00Z")
    assert [r["group_id"] for r in plan["upsert"]] == ["1"]      # only tier-2 unjoined
    assert plan["mark_joined"] == []
    row = plan["upsert"][0]
    assert row["status"] == "candidate" and row["relevance_tier"] == 2
    assert row["is_private"] is True and row["niche"] == "Elektriker" and row["location"] == "Frankfurt"
    assert row["last_seen_at"] == "2026-06-08T00:00:00Z"
    assert "first_seen_at" not in row   # let the DB default own first_seen_at


def test_plan_candidate_writes_flips_member_candidate_to_joined():
    groups = [_grp("1", 2, True)]
    plan = _plan_candidate_writes(groups, {"1": "candidate"}, "Elektriker", "Frankfurt", "T")
    assert plan["upsert"] == []
    assert plan["mark_joined"] == ["1"]


def test_plan_candidate_writes_respects_ignored_and_joined():
    groups = [_grp("1", 2, False), _grp("2", 2, False), _grp("3", 2, True)]
    existing = {"1": "ignored", "2": "joined", "3": "joined"}
    plan = _plan_candidate_writes(groups, existing, "n", "l", "T")
    # ignored/joined unjoined rows are NOT re-queued; an already-joined member isn't re-flipped
    assert plan["upsert"] == []
    assert plan["mark_joined"] == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v -k "card_is_member or plan_candidate_writes"`
Expected: `ImportError: cannot import name '_card_is_member'`.

- [ ] **Step 3: Implement** — add both functions immediately AFTER `_order_and_cap_groups` in `tools/scraper/platforms/facebook.py`:

```python
def _card_is_member(card_text: str) -> bool:
    """Best-effort: a discovered FB group card shows a standalone 'Join'
    button line when the account is NOT a member. Returns False (not a
    member) when such a line is present; True otherwise. Ambiguous cards
    default to True (member) so we don't queue false candidates.
    """
    lines = [ln.strip().lower() for ln in (card_text or '').split('\n') if ln.strip()]
    return not any(ln in ('join', 'join group') for ln in lines)


def _plan_candidate_writes(
    groups: list,
    existing_status_by_gid: dict,
    niche: str | None,
    location: str | None,
    now_iso: str,
) -> dict:
    """Decide fb_group_candidates writes for one discovery pass. Pure (no I/O).

    Each group dict carries group_id, name, tier, is_member, is_public,
    member_count_text. `existing_status_by_gid` maps group_id -> current
    DB status. Returns {'upsert': [rows], 'mark_joined': [group_ids]}:
      - tier-2 + NOT member + not already joined/ignored -> upsert candidate
      - tier-2 + member + currently 'candidate'          -> mark_joined
    """
    upsert: list = []
    mark_joined: list = []
    for g in groups:
        if g.get('tier') != 2:
            continue
        gid = g.get('group_id')
        if not gid:
            continue
        status = existing_status_by_gid.get(gid)
        if g.get('is_member'):
            if status == 'candidate':
                mark_joined.append(gid)
            continue
        if status in ('ignored', 'joined'):
            continue
        upsert.append({
            'platform': 'facebook',
            'group_id': gid,
            'name': g.get('name'),
            'member_count_text': g.get('member_count_text'),
            'is_private': g.get('is_public') is False,
            'relevance_tier': 2,
            'niche': niche,
            'location': location,
            'status': 'candidate',
            'last_seen_at': now_iso,
        })
    return {'upsert': upsert, 'mark_joined': mark_joined}
```

- [ ] **Step 4: Run to verify pass**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: ALL pass (prior + 6 new).

- [ ] **Step 5: Commit**

```bash
git add "tools/scraper/platforms/facebook.py" "tools/scraper/platforms/test_group_relevance.py"
git commit -m "feat(scraper): add FB group membership + candidate-write planning helpers

_card_is_member reads the discovery card's Join button; _plan_candidate_writes
decides queue upserts + candidate->joined flips (respecting ignored/joined).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire detection + queue recording into the scrape

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (`_sync_discover_groups` card append; `_sync_group_first_scrape` queue recording)

Integration edits to a browser-driven method — locate by content; verify via import + the pytest suite (the live proof is Task 6).

- [ ] **Step 1: Capture `is_member` in `_sync_discover_groups`**

Find the group-dict append in `_sync_discover_groups`:
```python
                    is_public = 'public' in text.lower()[:80]
                    groups.append({
                        'group_id': gid,
                        'name': name,
                        'member_count_text': members,
                        'is_public': is_public,
                        'url': gurl,
                        'snippet': text[:200],
                    })
```
Replace with (add `is_member`):
```python
                    is_public = 'public' in text.lower()[:80]
                    groups.append({
                        'group_id': gid,
                        'name': name,
                        'member_count_text': members,
                        'is_public': is_public,
                        'is_member': _card_is_member(text),
                        'url': gurl,
                        'snippet': text[:200],
                    })
```

- [ ] **Step 2: Record the queue in `_sync_group_first_scrape`**

In `_sync_group_first_scrape`, find the `groups_prioritized` emit block added by the prior feature:
```python
        groups, prio = _order_and_cap_groups(gated, niche, location, generic_group_cap)
        _emit(on_progress, 'groups_prioritized',
              relevant=prio['relevant'],
              generic_searched=prio['generic_searched'],
              generic_skipped=prio['generic_skipped'])
        if not groups:
            _emit(on_progress, 'groups_found', count=0)
            return []
```
Insert this block immediately AFTER that `groups_prioritized` emit and BEFORE the `if not groups:` check (so the queue is recorded even when every group is generic/capped):
```python
        # Assisted-join queue: record tier-2 groups the account isn't a member
        # of so the operator can join them manually; auto-flip prior candidates
        # to 'joined' once they show as members. Best-effort, never blocks.
        try:
            cand_groups = [
                {**g, 'tier': _group_relevance_tier(g.get('name', ''), location, niche)}
                for g in gated
            ]
            tier2_gids = [g['group_id'] for g in cand_groups if g.get('tier') == 2]
            existing_status: dict = {}
            if tier2_gids:
                resp = (table('fb_group_candidates')
                        .select('group_id,status')
                        .eq('platform', 'facebook')
                        .in_('group_id', tier2_gids)
                        .execute())
                existing_status = {r['group_id']: r['status'] for r in (resp.data or [])}
            plan = _plan_candidate_writes(cand_groups, existing_status, niche, location, _now_iso())
            if plan['upsert']:
                table('fb_group_candidates').upsert(
                    plan['upsert'], on_conflict='platform,group_id').execute()
            for gid in plan['mark_joined']:
                (table('fb_group_candidates')
                 .update({'status': 'joined', 'joined_detected_at': _now_iso()})
                 .eq('platform', 'facebook').eq('group_id', gid).eq('status', 'candidate')
                 .execute())
            _emit(on_progress, 'group_queue_updated',
                  queued=len(plan['upsert']), joined=len(plan['mark_joined']))
        except Exception as exc:  # noqa: BLE001
            print(f'[group-queue] non-fatal: {str(exc)[:300]}', file=sys.stderr)
```

- [ ] **Step 3: Verify import + tests**

Run: `./.venv/Scripts/python.exe -c "from tools.scraper.platforms import facebook; print('import OK')"` → `import OK`.
Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v` → all pass.

- [ ] **Step 4: Commit**

```bash
git add "tools/scraper/platforms/facebook.py"
git commit -m "feat(scraper): record FB group-join queue during group-first scrape

Capture is_member at discovery; upsert tier-2 unjoined groups to
fb_group_candidates and auto-flip candidates to joined once joined. Emits
group_queue_updated. Best-effort: queue errors never abort a scrape.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: API — `/api/social-groups` queue endpoints

**Files:**
- Create: `server/src/routes/social-groups.ts`
- Modify: `server/src/server.ts` (mount the route)

- [ ] **Step 1: Write the route**

Create `server/src/routes/social-groups.ts`:
```typescript
/**
 * Social Groups route — read + status-update for the fb_group_candidates
 * assisted-join queue. The scraper populates the table; this serves the
 * ranked queue to the CRM and lets the operator mark joined/ignored.
 */
import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

const router = Router();

const STATUSES = ['candidate', 'joined', 'ignored'] as const;
type GroupStatus = (typeof STATUSES)[number];

// ── GET /api/social-groups/queue?status=candidate ────────────────────
router.get('/queue', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'candidate';
    if (!STATUSES.includes(status as GroupStatus)) {
      res.status(400).json({ success: false, error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('fb_group_candidates')
      .select('id,platform,group_id,name,member_count_text,is_private,relevance_tier,niche,location,status,first_seen_at,last_seen_at,joined_detected_at')
      .eq('platform', 'facebook')
      .eq('status', status)
      .order('relevance_tier', { ascending: false })
      .order('last_seen_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ success: true, data: data ?? [] });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── PATCH /api/social-groups/queue/:id  body { status } ──────────────
router.patch('/queue/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };
    if (!status || !STATUSES.includes(status as GroupStatus)) {
      res.status(400).json({ success: false, error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const supabase = getSupabase();
    const patch: Record<string, unknown> = { status };
    if (status === 'joined') patch.joined_detected_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('fb_group_candidates')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
```

- [ ] **Step 2: Mount it in `server/src/server.ts`**

Find the social-accounts mount line:
```typescript
app.use('/api/social-accounts', socialAccountsRoutes);
```
Add immediately after it:
```typescript
app.use('/api/social-groups', socialGroupsRoutes);
```
And add the import next to the other route imports near the top of `server.ts` (match the existing import style — they use `.js` extensions for local imports):
```typescript
import socialGroupsRoutes from './routes/social-groups.js';
```

- [ ] **Step 3: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/social-groups.ts server/src/server.ts
git commit -m "feat(backend): add /api/social-groups queue endpoints

GET /queue (ranked by tier, recency) + PATCH /queue/:id status for the
FB assisted-join queue.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — Group Queue page

**Files:**
- Create: `frontend/src/hooks/useGroupQueue.ts`
- Create: `frontend/src/views/GroupQueue.tsx`
- Create: `frontend/src/app/group-queue/page.tsx`
- Modify: `frontend/src/components/Sidebar.tsx` (nav entry)

- [ ] **Step 1: Hook** — create `frontend/src/hooks/useGroupQueue.ts`. Import the axios client EXACTLY as `frontend/src/views/SocialAccounts.tsx` imports `api` (copy that import line verbatim — same module/default-vs-named).

```typescript
import { useCallback, useEffect, useState } from 'react';
// NOTE: copy the `api` import line from views/SocialAccounts.tsx (same axios client).
import api from '../lib/api';

export interface GroupCandidate {
  id: string;
  group_id: string;
  name: string | null;
  member_count_text: string | null;
  is_private: boolean | null;
  relevance_tier: number | null;
  niche: string | null;
  location: string | null;
  status: 'candidate' | 'joined' | 'ignored';
  first_seen_at: string;
  last_seen_at: string;
  joined_detected_at: string | null;
}

export function useGroupQueue(status: 'candidate' | 'joined' | 'ignored' = 'candidate') {
  const [rows, setRows] = useState<GroupCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/social-groups/queue?status=${status}`);
      setRows(res.data.data ?? []);
      setError(null);
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const setStatus = useCallback(async (id: string, next: GroupCandidate['status']) => {
    await api.patch(`/social-groups/queue/${id}`, { status: next });
    await load();
  }, [load]);

  return { rows, loading, error, reload: load, setStatus };
}
```

- [ ] **Step 2: View** — create `frontend/src/views/GroupQueue.tsx`. (If `SocialAccounts.tsx` wraps content in a shared layout/header component, mirror that wrapper; otherwise this standalone markup is fine.)

```tsx
'use client';

import { useState } from 'react';
import { useGroupQueue, GroupCandidate } from '../hooks/useGroupQueue';

const TABS: GroupCandidate['status'][] = ['candidate', 'joined', 'ignored'];

export default function GroupQueue() {
  const [tab, setTab] = useState<GroupCandidate['status']>('candidate');
  const { rows, loading, error, setStatus } = useGroupQueue(tab);

  return (
    <div className="p-6 max-w-6xl mx-auto" style={{ fontFamily: 'Manrope, sans-serif' }}>
      <h1 className="text-2xl font-black tracking-tight text-[#b0004a] mb-1">Group Queue</h1>
      <p className="text-sm text-slate-500 mb-5">
        High-value Facebook groups the scraping account hasn&apos;t joined. Open one, join it in
        your logged-in session, and the next scrape will search it automatically.
      </p>

      <div className="flex gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-sm font-bold capitalize transition-colors ${
              tab === t ? 'bg-[#b0004a] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading && <p className="text-slate-500 text-sm">Loading…</p>}
      {error && <p className="text-error text-sm">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="text-slate-400 text-sm">No groups in “{tab}”.</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-2 font-semibold">Group</th>
                <th className="px-4 py-2 font-semibold">Members</th>
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Niche / Location</th>
                <th className="px-4 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    <a
                      href={`https://www.facebook.com/groups/${r.group_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#b0004a] font-semibold hover:underline"
                    >
                      {r.name || r.group_id}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{r.member_count_text || '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{r.is_private ? 'Private' : 'Public'}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {[r.niche, r.location].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <a
                        href={`https://www.facebook.com/groups/${r.group_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1 rounded-md bg-[#006630] text-white text-xs font-bold"
                      >
                        Open in FB
                      </a>
                      {tab !== 'joined' && (
                        <button
                          onClick={() => void setStatus(r.id, 'joined')}
                          className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                        >
                          Mark joined
                        </button>
                      )}
                      {tab !== 'ignored' && (
                        <button
                          onClick={() => void setStatus(r.id, 'ignored')}
                          className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                        >
                          Ignore
                        </button>
                      )}
                      {tab !== 'candidate' && (
                        <button
                          onClick={() => void setStatus(r.id, 'candidate')}
                          className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                        >
                          Restore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Page** — create `frontend/src/app/group-queue/page.tsx`:

```tsx
import GroupQueue from '../../views/GroupQueue';

export default function GroupQueuePage() {
  return <GroupQueue />;
}
```

- [ ] **Step 4: Nav entry** — in `frontend/src/components/Sidebar.tsx`, add to the `NAV_ITEMS` array immediately after the `'/social-accounts'` entry:

```typescript
  { href: '/group-queue',                           icon: 'playlist_add_check', label: 'Group Queue' },
```

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors. (If the `api` import path differs from the placeholder `'../lib/api'`, fix it to match `SocialAccounts.tsx` — that's the one line to verify.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useGroupQueue.ts frontend/src/views/GroupQueue.tsx frontend/src/app/group-queue/page.tsx frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): add Group Queue page for FB assisted-join

Ranked table of unjoined high-value groups with FB links + mark-joined/ignore;
new sidebar entry.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Apply migration + live verification (needs operator)

**Files:** none. Requires Supabase access + a live FB scrape (account quota + logged-in session).

- [ ] **Step 1: Apply the migration**

Paste `supabase/migrations/045_fb_group_candidates.sql` into the Supabase SQL editor and run it. Confirm `fb_group_candidates` exists (empty).

- [ ] **Step 2: Frankfurt scrape populates the queue**

```bash
./.venv/Scripts/python.exe tools/scraper/run.py --platform facebook --action search-posts \
  --filters '{"lead_type":"consumers","niche":"electrician","location":"Frankfurt","groups_only":true,"query":"electrician Frankfurt"}' \
  --output .tmp/fb_queue_smoke.json
```
Expected: a `group_queue_updated queued=<N> joined=0` progress line; `SELECT name,status,member_count_text FROM fb_group_candidates ORDER BY relevance_tier DESC;` shows the unjoined tier-2 groups as `candidate` — including "(Elektriker Handwerker Gesucht)".

- [ ] **Step 3: Manual join + auto-flip**

In the logged-in FB session (noVNC), join one queued group (e.g. "Elektriker Handwerker Gesucht"). Re-run the Step 2 command. Expected: `group_queue_updated` shows `joined>=1`; that row's `status` is now `joined` in the table — and if the join took effect, its in-group search returns posts (`group_posts_kept`).

- [ ] **Step 4: CRM page**

Start the frontend (`cd frontend && npm run dev`), open `/group-queue`. Confirm the ranked candidate list renders with FB links; click "Ignore" on a row → it leaves the candidate tab; check the "ignored" tab shows it; "Restore" returns it.

- [ ] **Step 5: Record results + commit**

Append a short "Smoke results" note (queued count, the joined-flip confirmation) to the spec and commit.

---

## Self-Review (completed during planning)

- **Spec coverage:** §Architecture-1 (detection) → Task 2 (`_card_is_member`) + Task 3 Step 1; §Architecture-2 (table + upsert/flip) → Task 1 + Task 2 (`_plan_candidate_writes`) + Task 3 Step 2; §Architecture-3 (API) → Task 4; §Architecture-4 (frontend) → Task 5; auto-status → `_plan_candidate_writes` mark_joined + Task 3; testing (unit + live) → Tasks 2 + 6. ✅
- **Placeholder scan:** all code complete. The two "match the existing pattern" notes (the `api` import line; an optional shared layout wrapper) are precise lookups against a named sibling file, not logic gaps; the type-check step catches a wrong import path. ✅
- **Type consistency:** `_card_is_member(card_text)->bool`, `_plan_candidate_writes(groups, existing_status_by_gid, niche, location, now_iso)->{'upsert','mark_joined'}`, the row keys (`platform/group_id/name/member_count_text/is_private/relevance_tier/niche/location/status/last_seen_at`) match the migration columns and the API `select`, and the frontend `GroupCandidate` interface matches the API payload. ✅
- **Ordering:** migration (Task 1) must be applied (Task 6 Step 1) before the Python upsert runs live — sequenced. Unit tests (Tasks 2-5) don't need the DB. ✅
