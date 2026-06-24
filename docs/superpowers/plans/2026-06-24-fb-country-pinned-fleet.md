# Facebook Country-Pinned Account Fleet + Optional Comment Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin each Facebook account to one country and operate it on that country's residential IP; select the account by the scrape's target country; add an optional, AI-drafted, operator-reviewed comment path under a separate write cap.

**Architecture:** Extend the existing `social_accounts` table and the `_claim_account` selection in `tools/scraper/platforms/facebook.py` rather than rebuilding. A new SQL migration adds country/proxy/comment-cap columns. A pure helper resolves the scrape's target country, which threads into `_claim_account` (now country-filtered) and into the Enigma proxy location already swapped by `uc_driver.py`. The comment path reuses the existing Gemini wiring in `tools/scraper/shared/social_nlp.py` to draft per-post text, persists drafts in a new `lead_comment_drafts` table, exposes draft/approve/post endpoints on the server, and posts via the account's own country session.

**Tech Stack:** Python 3 (Playwright/undetected-chromedriver scraper, pytest), Supabase Postgres (SQL migrations), Node.js + TypeScript (Express server), React (CRM frontend), Google Gemini API.

## Global Constraints

- Every send/write resolves to a `social_accounts` row — no single-account env var. (CLAUDE.md)
- `social_accounts` lifecycle enum is exactly `active`/`checkpoint`/`banned`/`disabled` — do not change it.
- Migrations are idempotent: use `IF NOT EXISTS` guards everywhere; wrap in `BEGIN;`/`COMMIT;`.
- Never call a scraping platform from the frontend — always go through the API.
- Do NOT change the existing read-scraping yield logic, classifier, or in-group membership behavior.
- Comment writes are **never** auto-sent — operator approval is mandatory before every post.
- Smoke-test the scraper live before claiming a Selenium-interaction task complete (repo rule: fixtures miss real-world HTML drift).
- Python tests run from repo root with `./.venv/Scripts/python.exe -m pytest <path> -v`.
- API responses are exactly `{ success: true, data }` or `{ success: false, error }`.
- Do not commit `.env`, `credentials.json`, or `token.json`.
- Deployment is operator-run only — never push/deploy automatically; output the commands.

---

## File Structure

**Phase 1 — country pinning**
- Create: `supabase/migrations/045_social_account_country_and_comment_caps.sql` — adds `country`, `proxy_location`, `comment_daily_cap`, `comment_used_today` to `social_accounts`.
- Modify: `tools/scraper/platforms/facebook.py` — add `_target_country_from_filters()` pure helper; add `country=` param to `_claim_account()`; thread target country through `_claim_or_raise()` and its callers; resolve proxy location from the claimed account.
- Create: `tools/scraper/platforms/test_account_selection.py` — unit tests for the pure helper + the country filter (Supabase `table` monkeypatched).
- Modify: `server/src/routes/social-accounts.ts` — include `country`/`proxy_location`/comment caps in the GET select and accept them in POST/PATCH.

**Phase 2 — optional comment path**
- Modify: `supabase/migrations/045_...sql` — same migration also creates `lead_comment_drafts`.
- Modify: `tools/scraper/shared/social_nlp.py` — add `draft_comment_from_post()` (Gemini, per-post).
- Create: `tools/scraper/platforms/test_comment_draft.py` — unit tests for the draft prompt/shape (Gemini call monkeypatched).
- Modify: `tools/scraper/platforms/facebook.py` — add `post_comment(post_url, text, account)` sync interaction + a CLI entry to drive a single draft→post for james.
- Create: `server/src/db/comment-drafts.ts` — CRUD for `lead_comment_drafts`.
- Create: `server/src/routes/comment-drafts.ts` — `POST /draft`, `GET` list, `PATCH /:id` (edit/approve/discard), `POST /:id/post`.
- Modify: `server/src/server.ts` — mount the new router.
- Create/Modify: frontend lead detail — a "Draft FB comment" affordance + review/edit/approve panel (DUMB layer; calls the API only).

---

## PHASE 1 — Country-pin the fleet

### Task 1: Migration — country + comment-cap columns on `social_accounts`

**Files:**
- Create: `supabase/migrations/045_social_account_country_and_comment_caps.sql`

**Interfaces:**
- Produces: columns `social_accounts.country` (text, nullable), `social_accounts.proxy_location` (text, nullable), `social_accounts.comment_daily_cap` (int NOT NULL DEFAULT 3), `social_accounts.comment_used_today` (int NOT NULL DEFAULT 0).

- [ ] **Step 1: Write the migration**

```sql
-- Migration 045 — Country-pin social accounts + comment write caps.
-- Adds geo-pinning (country + optional proxy override) so a scrape's
-- target country selects the matching account, and a SEPARATE write
-- budget for the optional operator-reviewed comment path.
-- Idempotent: IF NOT EXISTS guards everywhere. Re-applying is safe.

BEGIN;

ALTER TABLE social_accounts
    ADD COLUMN IF NOT EXISTS country            text,
    ADD COLUMN IF NOT EXISTS proxy_location      text,
    ADD COLUMN IF NOT EXISTS comment_daily_cap   int  NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS comment_used_today  int  NOT NULL DEFAULT 0;

-- Country-scoped account selection reads (platform, status, country).
CREATE INDEX IF NOT EXISTS social_accounts_country_idx
    ON social_accounts (platform, status, country)
    WHERE status = 'active';

COMMIT;
```

- [ ] **Step 2: Apply in Supabase SQL editor** (operator action — output the SQL above for the operator to run). Verify with:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='social_accounts'
  AND column_name IN ('country','proxy_location','comment_daily_cap','comment_used_today');
```
Expected: 4 rows.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/045_social_account_country_and_comment_caps.sql
git commit -m "feat(db): add country pinning + comment write caps to social_accounts"
```

---

### Task 2: Pure helper — resolve a scrape's target country to an ISO code

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add helper near `_extract_country_from_excerpt`, ~line 598)
- Test: `tools/scraper/platforms/test_account_selection.py`

**Interfaces:**
- Consumes: existing `_extract_country_from_excerpt(text) -> Optional[str]`.
- Produces: `_target_country_from_filters(filters: dict) -> Optional[str]` — returns an uppercased ISO-2 country code, or `None` when undeterminable. Resolution order: explicit `filters['country']` (already ISO for businesses-mode) → `_extract_country_from_excerpt(filters['location'])` (consumers-mode city) → `None`.

- [ ] **Step 1: Write the failing test**

```python
# tools/scraper/platforms/test_account_selection.py
"""Unit tests for FB account country resolution + country-filtered claim.

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -v
"""
from tools.scraper.platforms.facebook import _target_country_from_filters


def test_explicit_country_iso_wins():
    assert _target_country_from_filters({'country': 'us'}) == 'US'
    assert _target_country_from_filters({'country': 'DE', 'location': 'Paris'}) == 'DE'


def test_location_city_maps_to_country():
    # Frankfurt is in CITY_TO_COUNTRY → DE
    assert _target_country_from_filters({'location': 'Frankfurt'}) == 'DE'


def test_unresolvable_returns_none():
    assert _target_country_from_filters({}) is None
    assert _target_country_from_filters({'location': 'Atlantis'}) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py::test_explicit_country_iso_wins -v`
Expected: FAIL — `ImportError: cannot import name '_target_country_from_filters'`.

- [ ] **Step 3: Write minimal implementation** (add to `facebook.py`)

```python
def _target_country_from_filters(filters: dict) -> Optional[str]:
    """Resolve the scrape's target country to an uppercased ISO-2 code.

    Businesses-mode passes an ISO `country`; consumers-mode passes a
    `location` city we map via _extract_country_from_excerpt. Returns
    None when neither resolves — caller treats that as "no country
    constraint" / "no account for country" depending on context.
    """
    explicit = (filters.get('country') or '').strip()
    if explicit:
        return explicit.upper()
    loc = (filters.get('location') or '').strip()
    if loc:
        cc = _extract_country_from_excerpt(loc)
        if cc:
            return cc.upper()
    return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/platforms/facebook.py tools/scraper/platforms/test_account_selection.py
git commit -m "feat(scraper): resolve FB scrape target country to ISO code"
```

---

### Task 3: Country-filter `_claim_account`

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:169` (`_claim_account`)
- Test: `tools/scraper/platforms/test_account_selection.py`

**Interfaces:**
- Consumes: Supabase `table('social_accounts')` query builder (imported as `table` from `tools.db.supabase_client`).
- Produces: `_claim_account(platform: str = 'facebook', country: Optional[str] = None) -> Optional[dict]` — when `country` is provided, only accounts with that `country` are eligible; signature stays back-compatible (existing callers pass no country).

- [ ] **Step 1: Write the failing test** (append to `test_account_selection.py`)

```python
import types
import tools.scraper.platforms.facebook as fb


class _FakeQuery:
    """Minimal chainable stand-in for the postgrest query builder.
    Records .eq() calls so we can assert the country filter was applied."""
    def __init__(self, rows, eq_log):
        self._rows = rows
        self._eq_log = eq_log
    def select(self, *_a, **_k): return self
    def eq(self, col, val):
        self._eq_log.append((col, val))
        if col == 'country':
            self._rows = [r for r in self._rows if r.get('country') == val]
        elif col == 'status':
            self._rows = [r for r in self._rows if r.get('status') == val]
        elif col == 'platform':
            self._rows = [r for r in self._rows if r.get('platform') == val]
        return self
    def order(self, *_a, **_k): return self
    def limit(self, *_a, **_k): return self
    def update(self, *_a, **_k): return self
    def execute(self):
        return types.SimpleNamespace(data=list(self._rows))


def _install_fake_table(monkeypatch, rows):
    eq_log: list = []
    monkeypatch.setattr(fb, 'table', lambda _name: _FakeQuery(rows, eq_log))
    return eq_log


def _acct(**kw):
    base = dict(id='x', platform='facebook', handle='h', daily_cap=50, hourly_cap=10,
                used_today=0, used_this_hour=0, encrypted_cookies='c', last_used_at=None,
                status='active', country='US')
    base.update(kw)
    return base


def test_claim_filters_by_country(monkeypatch):
    rows = [_acct(id='us', country='US'), _acct(id='de', country='DE')]
    eq_log = _install_fake_table(monkeypatch, rows)
    got = fb._claim_account('facebook', country='DE')
    assert got is not None and got['id'] == 'de'
    assert ('country', 'DE') in eq_log


def test_claim_no_account_for_country_returns_none(monkeypatch):
    rows = [_acct(id='us', country='US')]
    _install_fake_table(monkeypatch, rows)
    assert fb._claim_account('facebook', country='JP') is None


def test_claim_without_country_is_unfiltered(monkeypatch):
    rows = [_acct(id='us', country='US')]
    eq_log = _install_fake_table(monkeypatch, rows)
    got = fb._claim_account('facebook')
    assert got is not None and got['id'] == 'us'
    assert all(c != 'country' for c, _ in eq_log)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -k claim -v`
Expected: FAIL — `_claim_account()` takes no `country` keyword / no country filtering.

- [ ] **Step 3: Write minimal implementation** — edit `_claim_account` signature and add the conditional `.eq` plus `country` to the select list.

Change the signature line:
```python
def _claim_account(platform: str = 'facebook', country: Optional[str] = None) -> Optional[dict]:
```
Add `country` to the `.select(...)` column list (so the returned row carries it for proxy resolution):
```python
        .select('id,platform,handle,daily_cap,hourly_cap,used_today,used_this_hour,encrypted_cookies,last_used_at,country,proxy_location')
```
Insert the country filter immediately after `.eq('status', 'active')`:
```python
    q = (
        table('social_accounts')
        .select('id,platform,handle,daily_cap,hourly_cap,used_today,used_this_hour,encrypted_cookies,last_used_at,country,proxy_location')
        .eq('platform', platform)
        .eq('status', 'active')
    )
    if country:
        q = q.eq('country', country)
    rows = q.order('used_today', desc=False).limit(5).execute().data
```
(Replace the existing `rows = ( table(...) ... ).data` block with the above; keep the rollover/cap loop unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/platforms/facebook.py tools/scraper/platforms/test_account_selection.py
git commit -m "feat(scraper): filter FB account selection by pinned country"
```

---

### Task 4: Thread target country into claim + proxy resolution

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` — `_claim_or_raise` (~2390), its callers (`_sync_search_posts` ~2445, `_sync_enrich_authors`, `enrich_authors` ~2391), and the proxy-location resolution so the claimed account's `country`/`proxy_location` overrides `_CURRENT_LOCATION`.

**Interfaces:**
- Consumes: `_target_country_from_filters` (Task 2), `_claim_account(..., country=)` (Task 3), module global `_CURRENT_LOCATION` (set in `scrape_listing` ~2084).
- Produces: `_claim_or_raise(self, country: Optional[str] = None) -> dict` — raises a `no_account_for_country`-flavored error message naming the country when none is pinned; sets `_CURRENT_LOCATION` to the claimed account's `proxy_location or country` before the session opens.

- [ ] **Step 1: Write the failing test** (append to `test_account_selection.py`)

```python
def test_claim_or_raise_message_names_country(monkeypatch):
    _install_fake_table(monkeypatch, [_acct(id='us', country='US')])
    scraper = fb.FacebookScraper()
    try:
        scraper._claim_or_raise(country='JP')
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert 'JP' in str(e)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py::test_claim_or_raise_message_names_country -v`
Expected: FAIL — `_claim_or_raise()` takes no `country` keyword.

- [ ] **Step 3: Write minimal implementation**

Replace `_claim_or_raise`:
```python
    def _claim_or_raise(self, country: Optional[str] = None) -> dict:
        account = _claim_account('facebook', country=country)
        if not account:
            if country:
                raise RuntimeError(
                    f"No active Facebook account pinned to country {country}. "
                    f"Connect one in Social Accounts and pin it to {country}."
                )
            raise RuntimeError(
                "No active Facebook account available. Connect one in Social Accounts "
                "and check daily/hourly caps."
            )
        # Geo-consistency: operate this account on its own country's IP.
        global _CURRENT_LOCATION
        pin = account.get('proxy_location') or account.get('country')
        if pin:
            _CURRENT_LOCATION = pin
        return account
```
Then update the callers to pass the target country. In `_sync_search_posts` (and `_sync_enrich_authors`), accept and forward a `country` argument derived once in `scrape_listing`/`enrich_profiles` via `_target_country_from_filters(filters)`. Minimal threading: store it on the instance in `scrape_listing` right after `_CURRENT_LOCATION` is set —
```python
        self._target_country = _target_country_from_filters(filters)
```
and have `_claim_or_raise` default to it:
```python
    def _claim_or_raise(self, country: Optional[str] = None) -> dict:
        country = country or getattr(self, '_target_country', None)
        ...
```
(Set `self._target_country = None` in `__init__` or guard with `getattr` as shown.)

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/platforms/facebook.py tools/scraper/platforms/test_account_selection.py
git commit -m "feat(scraper): pin claimed FB account to its country's proxy IP"
```

---

### Task 5: Expose country + caps in the social-accounts API

**Files:**
- Modify: `server/src/routes/social-accounts.ts` (GET select ~line 37; POST body ~line 55; PATCH if present)

**Interfaces:**
- Consumes: Supabase client `getSupabase()`.
- Produces: GET returns `country`, `proxy_location`, `comment_daily_cap`, `comment_used_today`; POST/PATCH accept `country`, `proxy_location`, `comment_daily_cap`.

- [ ] **Step 1: Extend the GET select** — add the four columns to the `.select(...)` string:

```ts
      .select('id,platform,handle,display_name,status,country,proxy_location,daily_cap,hourly_cap,comment_daily_cap,comment_used_today,used_today,used_this_hour,last_login_at,last_used_at,last_checkpoint_at,checkpoint_reason,notes,created_at,updated_at,encrypted_cookies')
```

- [ ] **Step 2: Accept country/caps in POST** — destructure and insert them:

```ts
    const { platform, handle, display_name, country, proxy_location, daily_cap, hourly_cap, comment_daily_cap } = req.body as {
      platform?: Platform; handle?: string; display_name?: string;
      country?: string; proxy_location?: string;
      daily_cap?: number; hourly_cap?: number; comment_daily_cap?: number;
    };
```
Include `country`, `proxy_location`, `comment_daily_cap` in the insert payload (only when defined).

- [ ] **Step 3: Add a PATCH handler if none exists** for pinning an existing account's country:

```ts
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const allowed = ['country','proxy_location','daily_cap','hourly_cap','comment_daily_cap','status','display_name','notes'];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await supabase.from('social_accounts').update(patch).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 4: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/social-accounts.ts
git commit -m "feat(backend): expose social-account country + comment cap in API"
```

---

### Task 6 (Phase 1 GATE): Live james acceptance test

**Files:** none (verification task — repo rule: smoke-test live before claiming done).

- [ ] **Step 1: Pin james** — `PATCH /api/social-accounts/<james_id>` with `{ "country": "<james real operating country>" }`. Verify via `GET /api/social-accounts` that james shows that country.

- [ ] **Step 2: Run a scrape targeting james's country** (owner-local, per repo policy):

```bash
./.venv/Scripts/python.exe tools/scraper/run.py --platform facebook --action list \
  --filters '{"lead_type":"consumers","niche":"<niche>","location":"<city in james country>","groups_only":false}'
```
Expected: james is the claimed account; the launched session's Enigma proxy country matches james's `country`. Confirm in stderr proxy log line.

- [ ] **Step 3: Run a scrape targeting an UNpinned country** — same command with a `location`/`country` no account is pinned to.
Expected: clean error message containing the country code; **no** scrape runs on james.

- [ ] **Step 4: Record findings** in `workflows/` (FB scrape notes) — actual proxy log wording, any quirks. Commit doc update.

```bash
git add workflows/
git commit -m "docs(scraper): record FB country-pin acceptance results"
```

---

## PHASE 2 — Optional, context-aware comment path

### Task 7: Migration — `lead_comment_drafts` table

**Files:**
- Modify: `supabase/migrations/045_social_account_country_and_comment_caps.sql` (append before `COMMIT;`)

**Interfaces:**
- Produces: table `lead_comment_drafts(id, lead_id, post_url, account_id, draft_text, status, posted_at, created_at, updated_at)` with `status` in `draft`/`approved`/`posted`/`discarded`/`failed`.

- [ ] **Step 1: Append the table DDL** (before `COMMIT;`)

```sql
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
CREATE INDEX IF NOT EXISTS lead_comment_drafts_lead_idx ON lead_comment_drafts (lead_id);
CREATE INDEX IF NOT EXISTS lead_comment_drafts_status_idx ON lead_comment_drafts (status);
```

- [ ] **Step 2: Operator applies the updated migration**; verify the table exists:

```sql
SELECT to_regclass('public.lead_comment_drafts');
```
Expected: `lead_comment_drafts` (not null).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/045_social_account_country_and_comment_caps.sql
git commit -m "feat(db): add lead_comment_drafts for operator-reviewed FB comments"
```

---

### Task 8: Gemini per-post comment drafter

**Files:**
- Modify: `tools/scraper/shared/social_nlp.py` — add `draft_comment_from_post()`
- Test: `tools/scraper/platforms/test_comment_draft.py`

**Interfaces:**
- Consumes: existing Gemini client/key resolution already used by `classify_consumer_posts_with_gemini`.
- Produces: `draft_comment_from_post(post_excerpt: str, niche: str, *, brand: str = 'OptiRate', tone: str = 'helpful, human, non-salesy') -> Optional[str]` — returns a single short comment tailored to the post, or `None` when the API key is missing / call fails (caller surfaces "draft unavailable").

- [ ] **Step 1: Write the failing test**

```python
# tools/scraper/platforms/test_comment_draft.py
"""Unit tests for the per-post comment drafter (Gemini call monkeypatched).

Run: ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_comment_draft.py -v
"""
import tools.scraper.shared.social_nlp as nlp


def test_draft_returns_none_without_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('NEXT_PUBLIC_GEMINI_API_KEY', raising=False)
    assert nlp.draft_comment_from_post("Looking for a plumber in Austin", "plumbers") is None


def test_draft_passes_post_text_to_model(monkeypatch):
    captured = {}
    def fake_call(prompt: str) -> str:
        captured['prompt'] = prompt
        return "Happy to help — sent you a quick note!"
    monkeypatch.setenv('GEMINI_API_KEY', 'test')
    monkeypatch.setattr(nlp, '_gemini_text_call', fake_call, raising=False)
    out = nlp.draft_comment_from_post("Need a dentist near Cebu, any recos?", "dentists")
    assert out == "Happy to help — sent you a quick note!"
    assert "Cebu" in captured['prompt']  # post content is in the prompt
    assert "dentists" in captured['prompt']
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_comment_draft.py -v`
Expected: FAIL — `draft_comment_from_post` / `_gemini_text_call` not defined.

- [ ] **Step 3: Implement** in `social_nlp.py` — factor the existing Gemini HTTP call into a small `_gemini_text_call(prompt) -> str` (reuse the key resolution and endpoint already present for the classifier), then:

```python
def draft_comment_from_post(post_excerpt: str, niche: str, *,
                            brand: str = 'OptiRate',
                            tone: str = 'helpful, human, non-salesy') -> Optional[str]:
    """Draft ONE short FB comment tailored to a specific post.

    Per-post, never templated: the comment must reference what the post
    actually says. Returns None when GEMINI_API_KEY is unset or the call
    fails — the operator then writes their own.
    """
    if not (os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')):
        return None
    prompt = (
        f"You are a {tone} small-business owner replying on Facebook as {brand}.\n"
        f"Service area/niche: {niche}.\n"
        f"Write ONE short (max 2 sentences) comment replying to THIS post. "
        f"Reference what they actually asked. No links, no hard sell, no emojis spam.\n\n"
        f"POST:\n{post_excerpt}\n\nCOMMENT:"
    )
    try:
        text = _gemini_text_call(prompt)
        return (text or '').strip() or None
    except Exception:
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_comment_draft.py -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/shared/social_nlp.py tools/scraper/platforms/test_comment_draft.py
git commit -m "feat(scraper): add per-post Gemini comment drafter"
```

---

### Task 9: Comment-drafts DB module + routes (server)

**Files:**
- Create: `server/src/db/comment-drafts.ts`
- Create: `server/src/routes/comment-drafts.ts`
- Modify: `server/src/server.ts` (mount router)

**Interfaces:**
- Consumes: `getSupabase()`, the Gemini drafter via spawning Python (mirror `social-accounts.ts` spawn pattern) OR a direct Gemini call in Node — **decision: spawn Python** to reuse `draft_comment_from_post` and keep one Gemini implementation.
- Produces routes (all under `/api/comment-drafts`):
  - `POST /draft` `{lead_id, post_url, post_excerpt, niche}` → creates a `draft` row, returns it.
  - `GET /?lead_id=` → list drafts for a lead.
  - `PATCH /:id` `{draft_text?, status?}` → edit text / set `approved`/`discarded`.
  - `POST /:id/post` → enforces the account's `comment_daily_cap`, spawns the Python post action, sets `posted`/`failed`, bumps `comment_used_today`.

- [ ] **Step 1: Write `comment-drafts.ts` DB helpers** — `createDraft`, `listDraftsForLead`, `updateDraft`, `markPosted`, `markFailed` (thin Supabase wrappers returning `{data}`/throwing on error, mirroring `server/src/db/social-connect-requests.ts`).

- [ ] **Step 2: Write `routes/comment-drafts.ts`** implementing the four endpoints. `POST /draft` spawns `tools/scraper/run.py --platform facebook --action draft-comment --filters '{...}'` (add this action in Task 10) or a dedicated CLI; persist the returned text. `POST /:id/post`:
  - load draft + its `account_id`'s `comment_used_today`/`comment_daily_cap`;
  - if `comment_used_today >= comment_daily_cap` → `409 { success:false, error:'comment cap reached' }`;
  - require `status === 'approved'` (else `400`);
  - spawn the Python post action (Task 10); on success `markPosted` + increment `comment_used_today`; on failure `markFailed` with the error.

- [ ] **Step 3: Mount in `server.ts`**

```ts
import commentDraftsRouter from './routes/comment-drafts.js';
app.use('/api/comment-drafts', commentDraftsRouter);
```

- [ ] **Step 4: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/comment-drafts.ts server/src/routes/comment-drafts.ts server/src/server.ts
git commit -m "feat(backend): comment-draft CRUD + capped post endpoint"
```

---

### Task 10: Python comment-post interaction + CLI actions (LIVE-DISCOVERY)

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` — add `post_comment(self, post_url, text, account)` and `draft_comment(self, post_excerpt, niche)`; wire `--action draft-comment` and `--action post-comment` into `tools/scraper/run.py`.

> **NOTE — live-discovery task.** FB's comment-box DOM cannot be written blind; selectors drift and differ by surface (group post vs. page post). This task is **smoke-test-driven**: discover the real selectors against a live post on james, then lock them in. Do NOT ship fake selectors.

**Interfaces:**
- Consumes: `_claim_or_raise(country=...)` and `_open_session(account)` (existing), `draft_comment_from_post` (Task 8), `_bump_counters`/`_flag_checkpoint` (existing).
- Produces: `post_comment(self, post_url: str, text: str, account: dict) -> dict` → `{posted: bool, error: Optional[str]}`; CLI `--action draft-comment` (prints JSON `{text}`) and `--action post-comment` (prints JSON `{posted, error}`).

- [ ] **Step 1: Add the draft CLI action** (pure-ish — no browser). In the `run.py` action dispatch, for `draft-comment` read `post_excerpt`+`niche` from filters and call `draft_comment_from_post`, print `{"text": ...}`. Commit.

- [ ] **Step 2: Discover live selectors on james** — open one real FB post james can comment on (headed, james's country proxy), inspect the comment composer: the contenteditable box, how text is entered (it's a Lexical/Draft editor — needs per-char send_keys or JS input events), and the submit affordance (Enter vs. button). Record exact selectors.

- [ ] **Step 3: Implement `post_comment`** using the discovered selectors: open session for the account, navigate to `post_url`, dismiss popups (`browser_utils`), focus the composer, type `text` human-paced, submit, verify the comment appears (poll for the text node), then `_bump_counters(account['id'], ...)` against the **comment** budget. On a trust/captcha gate → `_flag_checkpoint` and return `{posted: False, error: 'checkpoint'}`.

- [ ] **Step 4: Live smoke test** — draft → edit → post one comment on a real post via the CLI; confirm it appears on FB and `comment_used_today` incremented.

```bash
./.venv/Scripts/python.exe tools/scraper/run.py --platform facebook --action post-comment \
  --filters '{"post_url":"<real post>","text":"<approved text>","account_id":"<james id>"}'
```

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/platforms/facebook.py tools/scraper/run.py
git commit -m "feat(scraper): post operator-approved FB comment via account session"
```

---

### Task 11: Frontend — draft/review/approve panel (DUMB layer)

**Files:**
- Modify: lead-detail view + a hook (follow existing `frontend/src/hooks/*` + view patterns; the exact lead-detail component is whatever renders a single lead — locate via the existing leads view).

**Interfaces:**
- Consumes: `/api/comment-drafts` endpoints (Task 9). No business logic in the frontend.
- Produces: a "Draft FB comment" button (calls `POST /draft`), an editable textarea bound to the draft, Approve (`PATCH status=approved`), Discard (`PATCH status=discarded`), and Post (`POST /:id/post`) with the cap-reached/checkpoint errors surfaced.

- [ ] **Step 1: Add a `useCommentDrafts` hook** with `draft`, `loading`, `error` states and the four calls (mirror `useCampaigns.ts`).

- [ ] **Step 2: Add the panel** to the lead detail: shows only for leads with a captured FB post (`lead_platform_posts`); textarea is editable; buttons wired; disabled states while loading; error toast for `409 comment cap reached` / `checkpoint`.

- [ ] **Step 3: Type-check + manual check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors. Then click through draft→edit→approve→post against a local server and confirm the draft text round-trips.

- [ ] **Step 4: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): FB comment draft review + approve/post panel"
```

---

## Phase 0 — Deferred ops runbook (NOT in this plan)

Tracked separately; needs the operator's 9-country list. Steps: audit Enigma country coverage; per country, create the FB account born on that country's Enigma IP, phone-verify, warm 2–4 weeks; register as a `social_accounts` row with `country` set and connect cookies. Each new account is validated by repeating Task 6 for its country.

---

## Self-Review

**Spec coverage:**
- Country pinning schema → Task 1. ✓
- Country-filtered selection → Tasks 2–4. ✓
- Proxy/account geo-consistency → Task 4 (sets `_CURRENT_LOCATION` from account). ✓
- Clean "no account for country" error → Task 4. ✓
- API surface for country/caps → Task 5. ✓
- James Phase-1 acceptance → Task 6. ✓
- `lead_comment_drafts` → Task 7. ✓
- Gemini per-post draft (non-templated) → Task 8. ✓
- Draft/review/approve/post + separate write cap → Tasks 9–11. ✓
- James Phase-2 acceptance → Task 10 Step 4. ✓
- Phase 0 deferred, no code → documented. ✓

**Placeholder scan:** Task 10 is intentionally live-discovery (selectors unknowable without a live page) — it carries the investigation procedure and acceptance test, not fake selectors. The frontend component path in Task 11 is "locate via existing leads view" because the exact filename must follow the repo's current structure; the hook/panel code shape is specified. No other TBDs.

**Type consistency:** `_claim_account(platform, country=None)`, `_claim_or_raise(self, country=None)`, `_target_country_from_filters(filters)`, `draft_comment_from_post(post_excerpt, niche, ...)`, draft `status` enum (`draft`/`approved`/`posted`/`discarded`/`failed`) are used consistently across tasks and match the spec.
