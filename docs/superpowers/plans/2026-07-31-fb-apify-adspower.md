# Facebook: Apify Discovery + AdsPower Engagement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Facebook lead discovery off the logged-in browser onto Apify's cookieless actors, and put the remaining account-bound actions behind AdsPower's per-profile fingerprint isolation.

**Architecture:** Discovery becomes a plain HTTP call to an Apify actor that returns public post data, mapped onto the existing `PostStub` contract so the entire downstream chain (country stamping, consumer filters, Gemini classifier, upsert) is untouched. A `FB_DISCOVERY` env var routes between the new Apify path and today's browser path, and `FB_ENRICH` decides whether author enrichment opens a browser at all. Separately, `open_uc_driver()` gains a single branch at the top that attaches Selenium to an AdsPower profile when the claimed account carries a profile id.

**Tech Stack:** Python 3.12 (`requests`, `pytest`), TypeScript/Node (Express, `vitest`), Supabase Postgres, Selenium + undetected-chromedriver, Apify REST API v2, AdsPower Local API v1.

## Global Constraints

- **Never delete the browser discovery path.** `FB_DISCOVERY=browser` must restore today's behaviour byte-for-byte. Same for `FB_ENRICH=browser`.
- **`PostStub` and `AuthorLead` contracts in `tools/scraper/platforms/_social_base.py` do not change.** Every new discovery source maps onto them.
- **`BasePlatformScraper` / `SocialPlatformScraper` contracts do not change.**
- **Progress event names are load-bearing.** The SSE stream and scrape-job UI parse them. Keep `search_started`, `search_done`, `niche_translated`, `consumer_filtered`, `llm_filtered`, `llm_skipped`, `enrich_start`. New events may be added; existing ones may not be renamed.
- **An empty result set must never be produced by a configuration error.** Missing token, 402 credit exhaustion and actor failure all raise — they never return `[]`.
- **Actor IDs are env vars, never literals in code.**
- **No live scraper change ships without a live smoke run** (project standing rule — fixture tests miss SSE-name mismatches and real-world drift).
- **Python tests:** `.venv/Scripts/python.exe -m pytest <path> -v` from the repo root.
- **Server tests:** `cd server && npx vitest run <path>`.
- **Type-check before any deploy:** `cd server && npx tsc --noEmit`.
- **Never run `git push` or `gcloud run deploy`.** Output the commands for the operator.
- Migration number for this work is **057**. Latest applied is 056.

## Prerequisites (operator, before Task 2)

1. Apify account on a paid plan. The free tier caps `scrapeforge/facebook-search-posts` at 20 results/run and 1 run/24h.
2. `APIFY_API_TOKEN=<token>` in `.env` (Apify Console → Settings → Integrations).

Tasks 1 and 8–10 do not need the token. Tasks 2–7 do.

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `tools/scraper/shared/apify.py` | Run an Apify actor, return dataset items. Knows nothing about Facebook. | Create |
| `tools/scraper/platforms/facebook_apify.py` | Facebook-specific actor input building and `PostStub` mapping. Pure functions, no I/O. | Create |
| `tools/scraper/platforms/facebook.py` | Gains the discovery router and the stub-enrich path. | Modify |
| `tools/scraper/shared/adspower.py` | AdsPower Local API client: start/stop/status a profile. | Create |
| `tools/scraper/shared/uc_driver.py` | Gains one AdsPower branch at the top of `open_uc_driver`. | Modify |
| `server/src/services/social-routing.ts` | `shouldRefuseSocialOnLinux` becomes browser-aware. | Modify |
| `supabase/migrations/057_social_account_adspower_profile.sql` | `social_accounts.adspower_profile_id` | Create |
| `tests/scraper/test_apify.py` | Apify client tests | Create |
| `tests/scraper/test_facebook_apify.py` | Input-building + mapping tests | Create |
| `tests/scraper/test_fb_discovery_router.py` | Router + stub-enrich tests | Create |
| `tests/scraper/test_adspower.py` | AdsPower client + opener-branch tests | Create |
| `server/src/services/social-routing.test.ts` | Extended for browserless jobs | Modify |

`facebook.py` is already ~3000 lines. New pure logic goes in `facebook_apify.py` rather than growing it further; `facebook.py` only gains the thin router and a delegating call.

**Deviation from the spec, §4.4:** the spec routed `ADSPOWER_PROFILE_ID` through `socialProfileEnv()` in TypeScript. That is unnecessary — `_claim_or_raise()` already returns the full `social_accounts` row in Python, so the profile id is in hand at the call site. Task 10 passes it as a function argument, with an env-var fallback for callers that have no account row (interactive login, browse worker). This removes a task rather than adding one.

---

## STAGE A — Apify discovery

### Task 1: Apify client module

**Files:**
- Create: `tools/scraper/shared/apify.py`
- Test: `tests/scraper/test_apify.py`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces:
  - `run_actor(actor_id: str, run_input: dict, *, timeout: int = 300) -> list[dict]`
  - `class ApifyError(RuntimeError)`
  - `class ApifyCreditError(ApifyError)`
  - `get_actor_input_schema(actor_id: str) -> dict`

- [ ] **Step 1: Write the failing tests**

Create `tests/scraper/test_apify.py`:

```python
"""Tests for the Apify actor runner. No network — requests.post is patched."""
import pytest

from tools.scraper.shared import apify


class _Resp:
    def __init__(self, status_code, payload=None, text=''):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError('no json')
        return self._payload


def test_missing_token_raises_not_empty_list(monkeypatch):
    monkeypatch.delenv('APIFY_API_TOKEN', raising=False)
    with pytest.raises(apify.ApifyError) as exc:
        apify.run_actor('some/actor', {})
    assert 'APIFY_API_TOKEN' in str(exc.value)


def test_successful_run_returns_dataset_items(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return _Resp(200, [{'a': 1}, {'a': 2}])

    monkeypatch.setattr(apify.requests, 'post', fake_post)
    out = apify.run_actor('scrapeforge/facebook-search-posts', {'q': 'x'})
    assert out == [{'a': 1}, {'a': 2}]
    # actor id must be slash-escaped into the path, token passed as a param
    assert 'scrapeforge~facebook-search-posts' in calls[0][0]
    assert calls[0][1]['params']['token'] == 'tok'


def test_402_raises_credit_error_with_actor_id(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: _Resp(402, None, 'monthly usage exceeded'),
    )
    with pytest.raises(apify.ApifyCreditError) as exc:
        apify.run_actor('some/actor', {})
    assert 'some/actor' in str(exc.value)
    assert 'monthly usage exceeded' in str(exc.value)


def test_retries_5xx_then_succeeds(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    seq = [_Resp(503, None, 'bad gateway'), _Resp(200, [{'ok': True}])]
    monkeypatch.setattr(apify.requests, 'post', lambda url, **kw: seq.pop(0))
    slept = []
    monkeypatch.setattr(apify.time, 'sleep', slept.append)
    assert apify.run_actor('some/actor', {}) == [{'ok': True}]
    assert slept, 'should have backed off before retrying'


def test_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(apify.requests, 'post', lambda url, **kw: _Resp(500, None, 'boom'))
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)
    with pytest.raises(apify.ApifyError):
        apify.run_actor('some/actor', {})


def test_non_list_payload_raises(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: _Resp(200, {'error': 'actor not found'}),
    )
    with pytest.raises(apify.ApifyError):
        apify.run_actor('some/actor', {})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_apify.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.scraper.shared.apify'`

- [ ] **Step 3: Write the implementation**

Create `tools/scraper/shared/apify.py`:

```python
"""Apify actor runner — cookieless public-data discovery.

WHY THIS EXISTS

  Facebook post discovery used to require driving a logged-in account through
  undetected-chromedriver. That capped throughput at ~1 scrape/day (the
  social_accounts daily_cap of 10, set after a real FB "automated behaviour"
  warning), pinned the work to a Windows host with a residential IP, and put
  the account at ban risk for reading data that is public anyway.

  Apify runs the extraction on their infrastructure and hands back JSON. No
  account, no cookies, no fingerprint, no cap — and because it is a plain HTTP
  call it runs on Cloud Run and Linux workers, which the browser path never
  could.

FAILURE POLICY

  Every failure raises. A misconfigured token, an exhausted plan and a broken
  actor must never be reported as "no leads found" — that is indistinguishable
  from a genuinely empty search and silently hides billing and config faults.
"""
from __future__ import annotations

import os
import time
from typing import Any

import requests

APIFY_BASE = 'https://api.apify.com/v2'
DEFAULT_TIMEOUT = 300
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (2, 5)


class ApifyError(RuntimeError):
    """An actor run could not be completed."""


class ApifyCreditError(ApifyError):
    """HTTP 402 — plan limit reached or account out of credit."""


def _token() -> str:
    token = (os.environ.get('APIFY_API_TOKEN') or '').strip()
    if not token:
        raise ApifyError(
            'APIFY_API_TOKEN is not set — Apify discovery cannot run. Set it in '
            '.env. Raising rather than returning an empty list, because an empty '
            'result set is indistinguishable from a misconfigured token.'
        )
    return token


def _actor_path(actor_id: str) -> str:
    """Apify encodes the owner/name separator as a tilde inside URL paths."""
    return actor_id.replace('/', '~')


def run_actor(
    actor_id: str,
    run_input: dict,
    *,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Run an actor to completion and return its dataset items.

    Uses run-sync-get-dataset-items, which blocks until the run finishes and
    returns the dataset in one response — no polling loop to maintain.
    """
    url = f'{APIFY_BASE}/acts/{_actor_path(actor_id)}/run-sync-get-dataset-items'
    last_error = ''
    for attempt in range(1, MAX_ATTEMPTS + 1):
        started = time.time()
        resp = requests.post(
            url,
            params={'token': _token()},
            json=run_input,
            timeout=timeout,
        )
        elapsed = round(time.time() - started, 1)

        if resp.status_code == 402:
            raise ApifyCreditError(
                f'Apify returned 402 (out of credit / plan limit) for actor '
                f'{actor_id}: {resp.text[:300]}'
            )
        if resp.status_code >= 500:
            last_error = f'HTTP {resp.status_code}: {resp.text[:200]}'
            if attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
                continue
            raise ApifyError(f'Apify actor {actor_id} failed after {MAX_ATTEMPTS} attempts: {last_error}')
        if resp.status_code >= 400:
            raise ApifyError(f'Apify actor {actor_id} rejected the request — HTTP {resp.status_code}: {resp.text[:300]}')

        try:
            payload: Any = resp.json()
        except ValueError as exc:
            raise ApifyError(f'Apify actor {actor_id} returned non-JSON: {resp.text[:200]}') from exc
        if not isinstance(payload, list):
            raise ApifyError(f'Apify actor {actor_id} returned {type(payload).__name__}, expected a dataset list: {str(payload)[:300]}')

        print(f'INFO: apify actor={actor_id} items={len(payload)} elapsed={elapsed}s', flush=True)
        return payload

    raise ApifyError(f'Apify actor {actor_id} failed: {last_error}')


def get_actor_input_schema(actor_id: str) -> dict:
    """Fetch an actor's metadata so callers can read its real input key names.

    Community actors document inputs in prose that does not always match the
    JSON keys. Read the schema rather than guessing.
    """
    resp = requests.get(
        f'{APIFY_BASE}/acts/{_actor_path(actor_id)}',
        params={'token': _token()},
        timeout=30,
    )
    if resp.status_code >= 400:
        raise ApifyError(f'Could not read actor {actor_id} metadata — HTTP {resp.status_code}: {resp.text[:200]}')
    return resp.json()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_apify.py -v`
Expected: 6 passed

- [ ] **Step 5: Add the dependency note and commit**

No new package is needed — `requests>=2.31.0` is already in `requirements.txt`.

```bash
git add tools/scraper/shared/apify.py tests/scraper/test_apify.py
git commit -m "feat(scraper): add Apify actor runner for cookieless discovery"
```

---

### Task 2: Probe the live actor and build the Facebook mapping

**Files:**
- Create: `tools/scraper/platforms/facebook_apify.py`
- Test: `tests/scraper/test_facebook_apify.py`

**Interfaces:**
- Consumes: `apify.get_actor_input_schema` from Task 1
- Produces:
  - `build_search_input(query: str, *, max_results: int, search_type: str = 'posts', start_date: str | None = None, recent: bool = True) -> dict`
  - `build_group_posts_input(group_id: str, *, max_results: int) -> dict`
  - `post_to_stub(item: dict, *, group_id: str | None = None, group_name: str | None = None) -> PostStub | None`
  - `search_actor() -> str` / `group_posts_actor() -> str` — resolved from env on every call, so a swapped actor takes effect without a restart

- [ ] **Step 1: Probe the live actor's real input keys**

**ALREADY DONE — the schema was probed live on 2026-07-31 and the results are baked into this
task. Do not re-probe; use the verified key names below.**

`exampleRunInput` is a useless placeholder on both actors (`{"helloWorld": 123}`). The real schema
lives on the build: `GET /v2/acts/{id}` → `taggedBuilds.latest.buildId`, then
`GET /v2/actor-builds/{buildId}` → `inputSchema`.

`scrapeforge/facebook-search-posts` build **1.0.19**, public, not deprecated:

| key | type | default | notes |
|---|---|---|---|
| `query` | string | — | **required. The keyword key is `query`, NOT `search_query`.** |
| `search_type` | string | `posts` | `groups` for the group-first path in Task 4 |
| `max_results` | integer | 5 | |
| `start_date` / `end_date` | string | null | `YYYY-MM-DD` |
| `recent_posts` | boolean | false | we pass true — consumer asks are time-sensitive |
| `location_uid` | string | null | deliberately unused, see below |

`data-slayer/facebook-group-posts` build **1.0.5**: `groupId` (string, required) + `maxPages`
(integer, default 1). Matches what Task 2's `build_group_posts_input` already assumes.

**Plan-wide caveat for Task 7:** the Apify account is on the FREE plan ($5/mo usage). The search
actor restricts free accounts to **20 results per run and 1 run per 24 hours.** That is enough for
one live smoke run, so do not burn actor runs casually — schema reads are metadata calls and are
free, but every `run-sync-get-dataset-items` call consumes the daily allowance.

- [ ] **Step 2: Write the failing tests**

Create `tests/scraper/test_facebook_apify.py`. Adjust the expected key names to whatever Step 1 found:

```python
"""Pure-function tests for Apify->PostStub mapping. No network."""
from tools.scraper.platforms import facebook_apify as fa


def test_actor_ids_come_from_env_not_literals(monkeypatch):
    monkeypatch.delenv('APIFY_FB_SEARCH_ACTOR', raising=False)
    assert fa.search_actor() == 'scrapeforge/facebook-search-posts'
    monkeypatch.setenv('APIFY_FB_SEARCH_ACTOR', 'scraper_one/facebook-posts-search')
    assert fa.search_actor() == 'scraper_one/facebook-posts-search'
    monkeypatch.setenv('APIFY_FB_GROUP_POSTS_ACTOR', 'someone/other-group-actor')
    assert fa.group_posts_actor() == 'someone/other-group-actor'


def test_build_search_input_sets_keyword_and_caps():
    got = fa.build_search_input('plumber Manchester', max_results=25)
    assert got['query'] == 'plumber Manchester'
    assert got['search_type'] == 'posts'
    assert got['max_results'] == 25
    assert got['recent_posts'] is True


def test_build_search_input_supports_group_discovery():
    got = fa.build_search_input('plumber Manchester', max_results=10, search_type='groups')
    assert got['search_type'] == 'groups'


def test_build_search_input_omits_absent_date():
    assert 'start_date' not in fa.build_search_input('x', max_results=5)
    got = fa.build_search_input('x', max_results=5, start_date='2026-07-01')
    assert got['start_date'] == '2026-07-01'


def test_post_to_stub_maps_every_field():
    item = {
        'url': 'https://www.facebook.com/groups/123/posts/456/',
        'message': 'Anyone know a good plumber in Manchester?',
        'timestamp': '2026-07-30T09:12:00Z',
        'user': {
            'name': 'Jane Doe',
            'profile_url': 'https://www.facebook.com/jane.doe.5',
            'id': 'jane.doe.5',
        },
        'attachments': [{'url': 'https://scontent.example/1.jpg'}],
    }
    stub = fa.post_to_stub(item)
    assert stub['platform'] == 'facebook'
    assert stub['post_url'] == 'https://www.facebook.com/groups/123/posts/456/'
    assert stub['content_excerpt'] == 'Anyone know a good plumber in Manchester?'
    assert stub['author_profile_url'] == 'https://www.facebook.com/jane.doe.5'
    assert stub['author_handle'] == 'jane.doe.5'
    assert stub['display_name'] == 'Jane Doe'
    assert stub['posted_at'] == '2026-07-30T09:12:00Z'
    assert stub['media_urls'] == ['https://scontent.example/1.jpg']


def test_post_to_stub_tolerates_missing_optional_fields():
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/1',
        'message': 'need a roofer',
        'user': {'profile_url': 'https://www.facebook.com/bob'},
    })
    assert stub['post_url'] == 'https://www.facebook.com/p/1'
    assert stub['media_urls'] == []
    assert stub.get('posted_at') is None
    assert stub['author_handle'] == 'bob'


def test_post_to_stub_drops_items_with_no_author_url():
    assert fa.post_to_stub({'url': 'https://x', 'message': 'hi', 'user': {}}) is None


def test_post_to_stub_drops_items_with_no_post_url():
    assert fa.post_to_stub({'message': 'hi', 'user': {'profile_url': 'https://fb/u'}}) is None


def test_group_posts_stub_carries_group_context():
    stub = fa.post_to_stub(
        {'url': 'https://fb/p/9', 'message': 'x', 'user': {'profile_url': 'https://fb/u'}},
        group_id='123',
        group_name='Manchester Tradespeople',
    )
    assert stub['group_id'] == '123'
    assert stub['group_name'] == 'Manchester Tradespeople'
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_facebook_apify.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.scraper.platforms.facebook_apify'`

- [ ] **Step 4: Write the implementation**

Create `tools/scraper/platforms/facebook_apify.py`:

```python
"""Facebook <-> Apify translation: actor input building and PostStub mapping.

Pure functions only, no I/O — facebook.py is already ~3000 lines and this
logic is independently testable, so it lives here rather than growing that
file further.

ACTOR INPUT KEYS
  Verified against the live input schema on <DATE OF PROBE>. If the actor is
  swapped via APIFY_FB_SEARCH_ACTOR, re-probe with
  apify.get_actor_input_schema() and update build_search_input.
"""
from __future__ import annotations

import os
from typing import Optional
from urllib.parse import urlparse

from tools.scraper.platforms._social_base import PostStub


def search_actor() -> str:
    """Keyword post/group search actor. Read from env on every call so
    swapping a broken community actor needs no code change or restart."""
    return os.environ.get('APIFY_FB_SEARCH_ACTOR') or 'scrapeforge/facebook-search-posts'


def group_posts_actor() -> str:
    """Public-group post actor. Same env-on-every-call rule as above."""
    return os.environ.get('APIFY_FB_GROUP_POSTS_ACTOR') or 'data-slayer/facebook-group-posts'


def build_search_input(
    query: str,
    *,
    max_results: int,
    search_type: str = 'posts',
    start_date: Optional[str] = None,
    recent: bool = True,
) -> dict:
    """Build the keyword-search actor's run input.

    location_uid is deliberately unused: location already travels inside the
    query string ("plumber Manchester"), and adopting Facebook's internal geo
    IDs would require seeding a location table for marginal gain.
    """
    run_input: dict = {
        'query': query,
        'search_type': search_type,
        'max_results': max_results,
        'recent_posts': recent,
    }
    if start_date:
        run_input['start_date'] = start_date
    return run_input


def build_group_posts_input(group_id: str, *, max_results: int) -> dict:
    """Build the public-group actor's run input."""
    return {'groupId': group_id, 'maxPages': max(1, max_results // 10)}


def _handle_from_profile_url(profile_url: str) -> str:
    """Derive a stable handle from a profile URL.

    facebook.com/jane.doe.5           -> jane.doe.5
    facebook.com/profile.php?id=123   -> 123
    """
    parsed = urlparse(profile_url)
    if 'profile.php' in parsed.path:
        for part in (parsed.query or '').split('&'):
            if part.startswith('id='):
                return part[3:]
    return parsed.path.strip('/').split('/')[-1]


def post_to_stub(
    item: dict,
    *,
    group_id: Optional[str] = None,
    group_name: Optional[str] = None,
) -> Optional[PostStub]:
    """Map one Apify dataset item onto the PostStub contract.

    Returns None for items missing a post URL or an author profile URL — both
    are required downstream (post_url identifies the lead's post,
    author_profile_url keys lead_platform_presences), so an item without them
    cannot become a lead.
    """
    post_url = (item.get('url') or item.get('post_url') or '').strip()
    user = item.get('user') or item.get('author') or {}
    profile_url = (user.get('profile_url') or user.get('url') or '').strip()
    if not post_url or not profile_url:
        return None

    media = []
    for att in (item.get('attachments') or []):
        url = (att or {}).get('url') if isinstance(att, dict) else att
        if url:
            media.append(url)

    stub: PostStub = {
        'platform': 'facebook',
        'post_url': post_url,
        'author_profile_url': profile_url,
        'author_handle': (user.get('id') or '').strip() or _handle_from_profile_url(profile_url),
        'content_excerpt': (item.get('message') or item.get('text') or '').strip(),
        'posted_at': item.get('timestamp') or item.get('published_at'),
        'media_urls': media,
    }
    # display_name is not part of the PostStub contract but the stub-enrich
    # path in facebook.py reads it to build AuthorLead without a browser visit.
    name = (user.get('name') or '').strip()
    if name:
        stub['display_name'] = name
    if group_id:
        stub['group_id'] = group_id
    if group_name:
        stub['group_name'] = group_name
    return stub
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_facebook_apify.py -v`
Expected: 9 passed

- [ ] **Step 6: Replace the probe-date placeholder and commit**

Replace `<DATE OF PROBE>` in the module docstring with the actual date, and correct any key name Step 1 disproved.

```bash
git add tools/scraper/platforms/facebook_apify.py tests/scraper/test_facebook_apify.py
git commit -m "feat(scraper): map Apify Facebook results onto the PostStub contract"
```

---

### Task 3: Discovery router in `search_posts`

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:2388-2401`
- Test: `tests/scraper/test_fb_discovery_router.py`

**Interfaces:**
- Consumes: `apify.run_actor`, `facebook_apify.build_search_input`, `facebook_apify.post_to_stub`
- Produces: `_discovery_source() -> str`, `_search_posts_via_apify(query, filters, max_results, on_progress) -> list[PostStub]`

- [ ] **Step 1: Write the failing tests**

Create `tests/scraper/test_fb_discovery_router.py`:

```python
"""Router tests: FB_DISCOVERY picks the discovery source, and the Apify
branch feeds the SAME downstream filter chain the browser branch does."""
import asyncio

import pytest

from tools.scraper.platforms import facebook as fb


def test_discovery_source_defaults_to_apify(monkeypatch):
    monkeypatch.delenv('FB_DISCOVERY', raising=False)
    assert fb._discovery_source() == 'apify'


def test_discovery_source_honours_browser_override(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'browser')
    assert fb._discovery_source() == 'browser'


def test_discovery_source_is_case_insensitive(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'APIFY')
    assert fb._discovery_source() == 'apify'


def test_apify_branch_returns_mapped_stubs(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {
            'url': 'https://www.facebook.com/p/1',
            'message': 'looking for a plumber in Manchester',
            'user': {'name': 'Jane', 'profile_url': 'https://www.facebook.com/jane'},
        },
    ])
    stubs = fb._search_posts_via_apify('plumber Manchester', {}, 10, None)
    assert len(stubs) == 1
    assert stubs[0]['author_profile_url'] == 'https://www.facebook.com/jane'


def test_apify_branch_skips_unmappable_items(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'x', 'user': {}},          # no profile url
        {'url': 'https://fb/p/2', 'message': 'y', 'user': {'profile_url': 'https://fb/u'}},
    ])
    stubs = fb._search_posts_via_apify('q', {}, 10, None)
    assert len(stubs) == 1


def test_search_posts_uses_apify_and_still_runs_the_consumer_filters(monkeypatch):
    """The Apify branch must sit ABOVE the stamping + filter chain so Apify
    stubs get country/category stamping and the Gemini classifier."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'anyone know a plumber in Manchester?',
         'user': {'name': 'Jane', 'profile_url': 'https://fb/jane'}},
    ])
    # Neutralize the LLM + translation so the test is deterministic.
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    scraper = fb.FacebookScraper()
    stubs = asyncio.run(scraper.search_posts(
        'plumber Manchester',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': False},
        max_results=10,
    ))
    assert len(stubs) == 1
    assert stubs[0]['category'] == 'plumber', 'category stamping must still run'
    assert stubs[0].get('location_confidence'), 'confidence classifier must still run'


def test_browser_mode_never_calls_apify(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'browser')

    def boom(*a, **k):
        raise AssertionError('Apify must not be called in browser mode')

    monkeypatch.setattr(fb.apify, 'run_actor', boom)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_search_posts',
        lambda self, query, groups_only, max_results, on_progress: [],
    )
    scraper = fb.FacebookScraper()
    out = asyncio.run(scraper.search_posts('q', {'groups_only': False}, max_results=5))
    assert out == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fb_discovery_router.py -v`
Expected: FAIL — `AttributeError: module 'tools.scraper.platforms.facebook' has no attribute '_discovery_source'`

- [ ] **Step 3: Add the imports and the source resolver**

Near the other module-level helpers in `facebook.py` (alongside `_CURRENT_LOCATION` around line 1275), add:

```python
from tools.scraper.shared import apify
from tools.scraper.platforms import facebook_apify


def _discovery_source() -> str:
    """Which discovery backend search_posts uses.

    'apify'   — cookieless Apify actor. No account, no daily cap, runs on any
                host including Cloud Run. The default since 2026-07-31.
    'browser' — the original logged-in undetected-chromedriver crawl. Kept for
                private-group search (Apify can only see public groups) and as
                the rollback path. Behaviour is unchanged from before Apify.
    """
    return (os.environ.get('FB_DISCOVERY') or 'apify').strip().lower()


def _search_posts_via_apify(
    query: str,
    filters: dict,
    max_results: int,
    on_progress: ProgressCallback,
) -> list[PostStub]:
    """Keyword post discovery through Apify. Opens no browser, claims no account."""
    actor = facebook_apify.search_actor()
    _emit(on_progress, 'search_started', query=query, source='apify', actor=actor)
    run_input = facebook_apify.build_search_input(
        query,
        max_results=max_results,
        start_date=filters.get('start_date') or None,
    )
    items = apify.run_actor(actor, run_input)
    stubs: list[PostStub] = []
    for item in items:
        stub = facebook_apify.post_to_stub(item)
        if stub:
            stubs.append(stub)
    _emit(on_progress, 'apify_run', actor=actor, requested=max_results,
          returned=len(items), mapped=len(stubs))
    return stubs
```

- [ ] **Step 4: Wire the router into `search_posts`**

In `facebook.py`, replace the branch currently at lines 2388-2401:

```python
        if groups_only:
            if not niche or not location:
                raise ValueError(
                    "Group-first search requires both 'niche' and 'location' in filters. "
                    "Pass groups_only=False to fall back to the open-feed search."
                )
            stubs = await asyncio.to_thread(
                self._sync_group_first_scrape, niche, location, on_progress,
                _resolve_generic_cap(filters),
            )
        else:
            stubs = await asyncio.to_thread(
                self._sync_search_posts, query, False, max_results or 50, on_progress,
            )
```

with:

```python
        # Discovery source. The Apify branch sits HERE — after niche
        # translation (so it searches the local-language term) and before the
        # country/category stamping and consumer filter chain below (so Apify
        # stubs get exactly the same treatment browser stubs do). Moving it
        # below the stamping would silently drop category/country on every
        # Apify lead.
        if _discovery_source() == 'apify':
            stubs = await asyncio.to_thread(
                _search_posts_via_apify,
                f'{niche} {location}'.strip() if niche and location else query,
                filters, max_results or 50, on_progress,
            )
        elif groups_only:
            if not niche or not location:
                raise ValueError(
                    "Group-first search requires both 'niche' and 'location' in filters. "
                    "Pass groups_only=False to fall back to the open-feed search."
                )
            stubs = await asyncio.to_thread(
                self._sync_group_first_scrape, niche, location, on_progress,
                _resolve_generic_cap(filters),
            )
        else:
            stubs = await asyncio.to_thread(
                self._sync_search_posts, query, False, max_results or 50, on_progress,
            )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fb_discovery_router.py -v`
Expected: 7 passed

- [ ] **Step 6: Run the whole scraper suite for regressions**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper tools/scraper -v`
Expected: all pass. If `test_facebook_helpers.py` or `test_account_selection.py` break, the router was placed wrongly — it must not change any browser-mode behaviour.

- [ ] **Step 7: Commit**

```bash
git add tools/scraper/platforms/facebook.py tests/scraper/test_fb_discovery_router.py
git commit -m "feat(scraper): route FB post discovery through Apify by default"
```

---

### Task 4: Public-group discovery through Apify

**Files:**
- Modify: `tools/scraper/platforms/facebook.py`
- Test: `tests/scraper/test_fb_discovery_router.py` (append)

**Interfaces:**
- Consumes: `facebook_apify.build_group_posts_input`, `facebook_apify.build_search_input(search_type='groups')`
- Produces: `_group_posts_via_apify(group_ids: list[str], max_results: int, on_progress) -> list[PostStub]`, `_discover_group_ids_via_apify(query: str, limit: int) -> list[tuple[str, str]]`

Rationale: open-feed keyword search is dominated by ads phrased as "Looking for X?" — the group-first path is the one that historically yielded real consumer asks. This reproduces it without an account, for public groups.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scraper/test_fb_discovery_router.py`:

```python
def test_discover_group_ids_returns_id_name_pairs(monkeypatch):
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'id': '111', 'name': 'Manchester Tradespeople'},
        {'group_id': '222', 'title': 'Manchester Home Help'},
        {'name': 'no id here'},
    ])
    pairs = fb._discover_group_ids_via_apify('plumber Manchester', 10)
    assert pairs == [('111', 'Manchester Tradespeople'), ('222', 'Manchester Home Help')]


def test_group_posts_via_apify_stamps_group_context(monkeypatch):
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'need a plumber',
         'user': {'profile_url': 'https://fb/jane'}},
    ])
    stubs = fb._group_posts_via_apify([('111', 'Manchester Tradespeople')], 10, None)
    assert stubs[0]['group_id'] == '111'
    assert stubs[0]['group_name'] == 'Manchester Tradespeople'


def test_group_posts_survives_one_failing_group(monkeypatch):
    """One broken group must not lose the other groups' results."""
    calls = {'n': 0}

    def flaky(actor, run_input, **kw):
        calls['n'] += 1
        if calls['n'] == 1:
            raise fb.apify.ApifyError('group 111 is private')
        return [{'url': 'https://fb/p/2', 'message': 'roofer?',
                 'user': {'profile_url': 'https://fb/bob'}}]

    monkeypatch.setattr(fb.apify, 'run_actor', flaky)
    stubs = fb._group_posts_via_apify([('111', 'A'), ('222', 'B')], 10, None)
    assert len(stubs) == 1
    assert stubs[0]['group_id'] == '222'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fb_discovery_router.py -k group -v`
Expected: FAIL — `AttributeError: ... has no attribute '_discover_group_ids_via_apify'`

- [ ] **Step 3: Write the implementation**

Add to `facebook.py` next to `_search_posts_via_apify`:

```python
def _discover_group_ids_via_apify(query: str, limit: int) -> list[tuple[str, str]]:
    """Find public groups matching a keyword. Returns (group_id, group_name)."""
    actor = facebook_apify.search_actor()
    items = apify.run_actor(
        actor,
        facebook_apify.build_search_input(query, max_results=limit, search_type='groups'),
    )
    pairs: list[tuple[str, str]] = []
    for item in items:
        gid = str(item.get('id') or item.get('group_id') or '').strip()
        if not gid:
            continue
        pairs.append((gid, (item.get('name') or item.get('title') or '').strip()))
    return pairs


def _group_posts_via_apify(
    groups: list[tuple[str, str]],
    max_results: int,
    on_progress: ProgressCallback,
) -> list[PostStub]:
    """Pull posts from each public group. A group that fails is skipped, not fatal.

    Private groups are invisible to this actor by design (it is cookieless).
    Those remain the browser path's job, with an account that has joined them.
    """
    actor = facebook_apify.group_posts_actor()
    per_group = max(1, max_results // max(1, len(groups)))
    stubs: list[PostStub] = []
    for gid, gname in groups:
        try:
            items = apify.run_actor(
                actor, facebook_apify.build_group_posts_input(gid, max_results=per_group),
            )
        except apify.ApifyError as exc:
            _emit(on_progress, 'group_skipped', group_id=gid, reason=str(exc)[:120])
            continue
        for item in items:
            stub = facebook_apify.post_to_stub(item, group_id=gid, group_name=gname)
            if stub:
                stubs.append(stub)
    _emit(on_progress, 'apify_groups_done', groups=len(groups), posts=len(stubs))
    return stubs
```

- [ ] **Step 4: Use the group path when `groups_only` is set**

In `search_posts`, refine the Apify branch added in Task 3 so `groups_only` still means group-first:

```python
        if _discovery_source() == 'apify':
            search_term = f'{niche} {location}'.strip() if niche and location else query
            if groups_only:
                if not niche or not location:
                    raise ValueError(
                        "Group-first search requires both 'niche' and 'location' in filters. "
                        "Pass groups_only=False to fall back to the open-feed search."
                    )
                groups = await asyncio.to_thread(
                    _discover_group_ids_via_apify, search_term, 10,
                )
                stubs = await asyncio.to_thread(
                    _group_posts_via_apify, groups, max_results or 50, on_progress,
                )
            else:
                stubs = await asyncio.to_thread(
                    _search_posts_via_apify, search_term, filters,
                    max_results or 50, on_progress,
                )
        elif groups_only:
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fb_discovery_router.py -v`
Expected: 10 passed

- [ ] **Step 6: Commit**

```bash
git add tools/scraper/platforms/facebook.py tests/scraper/test_fb_discovery_router.py
git commit -m "feat(scraper): discover public FB groups and their posts via Apify"
```

---

### Task 5: Browserless author enrichment

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:2495-2504`
- Test: `tests/scraper/test_fb_discovery_router.py` (append)

**Interfaces:**
- Consumes: `PostStub` (with the optional `display_name` set by `post_to_stub`)
- Produces: `_enrich_mode() -> str`, `_stub_enrich_authors(post_stubs) -> list[AuthorLead]`

Rationale: profile visits are the single largest consumer of account quota, and Apify already returns the two fields that key a lead row. `website_url` / `email` / `bio_excerpt` are rare on personal profiles, and FB leads are contacted by comment or DM, not email.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scraper/test_fb_discovery_router.py`:

```python
def test_enrich_mode_defaults_to_stub(monkeypatch):
    monkeypatch.delenv('FB_ENRICH', raising=False)
    assert fb._enrich_mode() == 'stub'


def test_stub_enrich_builds_leads_without_a_browser(monkeypatch):
    def boom(*a, **k):
        raise AssertionError('stub enrichment must not open a browser')

    monkeypatch.setattr(fb, '_open_driver', boom)
    leads = fb._stub_enrich_authors([
        {'platform': 'facebook', 'author_profile_url': 'https://fb/jane',
         'author_handle': 'jane', 'display_name': 'Jane Doe',
         'content_excerpt': 'need a plumber', 'country': 'GB', 'category': 'plumber'},
    ])
    assert len(leads) == 1
    assert leads[0]['profile_url'] == 'https://fb/jane'
    assert leads[0]['display_name'] == 'Jane Doe'
    assert leads[0]['platform'] == 'facebook'
    assert leads[0]['is_business_profile'] is False


def test_stub_enrich_dedupes_by_profile_url():
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'display_name': 'Jane', 'author_handle': 'jane'},
        {'author_profile_url': 'https://fb/jane', 'display_name': 'Jane', 'author_handle': 'jane'},
        {'author_profile_url': 'https://fb/bob', 'display_name': 'Bob', 'author_handle': 'bob'},
    ])
    assert len(leads) == 2


def test_stub_enrich_falls_back_to_handle_when_no_display_name():
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane.doe'},
    ])
    assert leads[0]['display_name'] == 'jane.doe'


def test_stub_enrich_never_emits_the_facebook_title_bug():
    """The browser path once wrote company_name='(2) Facebook' from a tab
    title. The stub path reads no titles, so this must hold by construction."""
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane',
         'display_name': '(2) Facebook'},
    ])
    assert leads[0]['display_name'] == 'jane'


def test_stub_enrich_skips_stubs_without_profile_url():
    assert fb._stub_enrich_authors([{'author_handle': 'nobody'}]) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fb_discovery_router.py -k enrich -v`
Expected: FAIL — `AttributeError: ... has no attribute '_enrich_mode'`

- [ ] **Step 3: Write the implementation**

Add to `facebook.py` near `_discovery_source`:

```python
def _enrich_mode() -> str:
    """Whether author enrichment opens a browser.

    'stub'    — build AuthorLead from the PostStub the discovery step already
                returned. Zero account usage. The default since 2026-07-31.
    'browser' — visit each author's profile with a logged-in account to pull
                bio/website/email. Rare payoff, high account cost; opt in only
                when a campaign genuinely needs those fields.
    """
    return (os.environ.get('FB_ENRICH') or 'stub').strip().lower()


# Tab titles Brave/Chrome produce on a profile page that are NOT a person's
# name. The browser path historically wrote these into leads.company_name.
_NON_NAME_TITLES = {'facebook', '', 'log in to facebook', 'log into facebook', 'meta'}


def _is_non_name(value: str) -> bool:
    s = (value or '').strip().lower()
    if s in _NON_NAME_TITLES:
        return True
    return re.sub(r'^\(\d+\)\s*', '', s).strip() == 'facebook'


def _stub_enrich_authors(post_stubs: list[PostStub]) -> list[AuthorLead]:
    """Build AuthorLeads straight from PostStubs — no browser, no account.

    Apify already returns the two fields that key a lead row (display name and
    profile URL). The fields a profile visit would add (website_url, email,
    bio_excerpt) are rare on personal FB profiles and cost one account-quota
    visit each, which is what previously locked the account out for 24h.

    TWO KEYS ARE LOAD-BEARING AND EASY TO MISS — an earlier draft of this plan
    omitted both, and the omission survived six passing tests because they
    checked this function's spec rather than the downstream upsert contract:

      • ``company_name`` — upsert_leads.py reads
        ``lead.get('company_name') or lead.get('name', 'Unknown')`` and NEVER
        reads display_name. Omit it and every lead lands as "Unknown".
      • ``posts`` — upsert_leads.py writes these into lead_platform_posts
        (post_url, content_excerpt, group_name). That excerpt is what powers
        "we saw your post about X" personalization. Omit it and every FB lead
        gets zero post rows.

    Both mirror the browser path, which sets them explicitly.
    """
    # Group by author FIRST, keeping every stub — a repeat author must yield
    # ONE lead carrying ALL their posts, not just the first.
    unique_authors: dict[str, list[PostStub]] = {}
    for stub in post_stubs:
        profile_url = (stub.get('author_profile_url') or '').strip()
        if not profile_url:
            continue
        unique_authors.setdefault(profile_url, []).append(stub)

    leads: list[AuthorLead] = []
    for profile_url, posts in unique_authors.items():
        first = posts[0]
        handle = (first.get('author_handle') or '').strip()
        name = (first.get('display_name') or '').strip()
        if not name or _is_non_name(name):
            name = handle
        lead: AuthorLead = {
            'platform': 'facebook',
            'profile_url': profile_url,
            'author_handle': handle,
            'display_name': name,
            'company_name': name,  # mapped to leads.company_name by upsert
            'website_url': None,
            'email': None,
            # location means a bio-derived place string, not a country code —
            # the browser path leaves it None and lets country travel below.
            'location': None,
            'is_business_profile': False,
            'follower_count': None,
            'bio_excerpt': None,
            # upsert_leads.py writes these into lead_platform_posts.
            'posts': posts,
        }
        # From the FIRST stub, matching the browser path's posts[0] precedent.
        for passthrough in ('country', 'category', 'location_confidence'):
            if first.get(passthrough):
                lead[passthrough] = first[passthrough]
        leads.append(lead)
    return leads
```

- [ ] **Step 4: Route `enrich_authors` through it**

Replace the body of `enrich_authors` (facebook.py:2495-2504):

```python
    async def enrich_authors(
        self,
        post_stubs: list[PostStub],
        *,
        screenshots_dir: str = '',
        on_progress: ProgressCallback = None,
    ) -> list[AuthorLead]:
        if not post_stubs:
            return []
        if _enrich_mode() == 'stub':
            leads = _stub_enrich_authors(post_stubs)
            # Detail key is `total=` on BOTH events, matching the browser
            # path (facebook.py:2731 and :2872). Anything parsing these
            # events reads `total`; emitting `enriched=` would break it.
            _emit(on_progress, 'enrich_start', total=len(leads), source='stub')
            _emit(on_progress, 'enrich_done', total=len(leads), source='stub')
            return leads
        return await asyncio.to_thread(self._sync_enrich_authors, post_stubs, on_progress)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fb_discovery_router.py -v`
Expected: 16 passed

- [ ] **Step 6: Commit**

```bash
git add tools/scraper/platforms/facebook.py tests/scraper/test_fb_discovery_router.py
git commit -m "feat(scraper): build FB author leads without a browser visit"
```

---

### Task 6: Allow browserless Facebook jobs on Linux

**Files:**
- Modify: `server/src/services/social-routing.ts`
- Modify: `server/src/services/scrape-runner.ts:657-662`
- Test: `server/src/services/social-routing.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `shouldRefuseSocialOnLinux(platform: string, osPlatform: NodeJS.Platform | string, opts?: { usesBrowser?: boolean }): boolean`

Rationale: the Linux refusal exists because FB rejects Linux browser fingerprints. With `FB_DISCOVERY=apify` and `FB_ENRICH=stub` the job opens no browser at all, so the reason does not apply and the job should run on Cloud Run and the Linux worker.

- [ ] **Step 1: Write the failing tests**

Replace the `shouldRefuseSocialOnLinux` describe block in `server/src/services/social-routing.test.ts`:

```typescript
describe('shouldRefuseSocialOnLinux', () => {
  it('refuses browser-driven facebook and instagram on linux', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux', { usesBrowser: true })).toBe(true);
    expect(shouldRefuseSocialOnLinux('instagram', 'linux', { usesBrowser: true })).toBe(true);
  });
  it('defaults to refusing when the caller says nothing about the browser', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux')).toBe(true);
  });
  it('allows a browserless facebook job on linux', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux', { usesBrowser: false })).toBe(false);
  });
  it('allows review platforms on linux and any platform on win32', () => {
    expect(shouldRefuseSocialOnLinux('yelp', 'linux', { usesBrowser: true })).toBe(false);
    expect(shouldRefuseSocialOnLinux('instagram', 'win32', { usesBrowser: true })).toBe(false);
  });
});

describe('facebookJobUsesBrowser', () => {
  it('is false only when discovery is apify AND enrichment is stub', () => {
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: 'apify', FB_ENRICH: 'stub' })).toBe(false);
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: 'browser', FB_ENRICH: 'stub' })).toBe(true);
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: 'apify', FB_ENRICH: 'browser' })).toBe(true);
  });
  it('treats the defaults (both unset) as browserless', () => {
    expect(facebookJobUsesBrowser({})).toBe(false);
  });
});
```

Add `facebookJobUsesBrowser` to the import at the top of that test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/services/social-routing.test.ts`
Expected: FAIL — `facebookJobUsesBrowser is not exported`

- [ ] **Step 3: Write the implementation**

In `server/src/services/social-routing.ts`:

```typescript
/** Does a Facebook job actually open a browser? Discovery via Apify plus
 *  stub enrichment is pure HTTP, so it carries none of the Linux
 *  fingerprint risk that motivated the refusal below. Both default to the
 *  browserless mode, matching the Python defaults in facebook.py. */
export function facebookJobUsesBrowser(env: Record<string, string | undefined>): boolean {
  const discovery = (env.FB_DISCOVERY ?? 'apify').toLowerCase();
  const enrich = (env.FB_ENRICH ?? 'stub').toLowerCase();
  return discovery !== 'apify' || enrich !== 'stub';
}

export function shouldRefuseSocialOnLinux(
  platform: string,
  osPlatform: NodeJS.Platform | string,
  opts: { usesBrowser?: boolean } = {},
): boolean {
  if (!SOCIAL_PLATFORMS.has(platform) || osPlatform !== 'linux') return false;
  // Defaults to true: a caller that does not know whether a browser is
  // involved gets the old, safe behaviour.
  return opts.usesBrowser ?? true;
}
```

- [ ] **Step 4: Update the one call site**

In `server/src/services/scrape-runner.ts`, change the guard at line 657. Import `facebookJobUsesBrowser` alongside the existing imports on line 23, then:

```typescript
  const usesBrowser = platform === 'facebook' ? facebookJobUsesBrowser(process.env) : true;
  if (shouldRefuseSocialOnLinux(platform, process.platform, { usesBrowser })) {
    throw new Error(
      `${platform} scraping is not supported on Linux workers — set ` +
      `PLATFORM_EXCLUDE=${platform} on this worker. Job will be re-queued for a Windows worker.`,
    );
  }
```

- [ ] **Step 5: Run the tests and the type-check**

Run: `cd server && npx vitest run src/services/social-routing.test.ts`
Expected: 6 passed

Run: `cd server && npx tsc --noEmit`
Expected: no output (the pre-existing red test `src/db/scrape-jobs.test.ts` is unrelated and stays red — do not fix it here)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/social-routing.ts server/src/services/social-routing.test.ts server/src/services/scrape-runner.ts
git commit -m "feat(backend): allow browserless Apify-mode Facebook jobs on Linux"
```

---

### Task 7: Configuration, documentation and the live smoke run

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md` (Environment Variables table, Known Constraints → Facebook)
- Modify: `workflows/` — create `workflows/scrape_facebook.md` if absent

**Interfaces:**
- Consumes: everything from Tasks 1-6
- Produces: no code

- [ ] **Step 1: Add the new variables to `.env.example`**

```bash
# ── Facebook discovery (Apify) ────────────────────────────────────────
# Apify runs cookieless public-data actors, so FB discovery needs no
# account, has no daily cap, and runs on Cloud Run. Free tier caps the
# search actor at 20 results/run + 1 run/24h — a paid plan is required.
APIFY_API_TOKEN=
APIFY_FB_SEARCH_ACTOR=scrapeforge/facebook-search-posts
APIFY_FB_GROUP_POSTS_ACTOR=data-slayer/facebook-group-posts
# apify (default) = cookieless Apify actor. browser = legacy logged-in crawl,
# required for PRIVATE groups the account has joined.
FB_DISCOVERY=apify
# stub (default) = build leads from search results, no browser.
# browser = visit each author profile for bio/website/email (burns account quota).
FB_ENRICH=stub

# ── AdsPower (engagement browser) ─────────────────────────────────────
ADSPOWER_API_BASE=http://local.adspower.net:50325
ADSPOWER_API_KEY=
```

- [ ] **Step 2: Update the `CLAUDE.md` environment table**

Add rows for `APIFY_API_TOKEN`, `APIFY_FB_SEARCH_ACTOR`, `APIFY_FB_GROUP_POSTS_ACTOR`, `FB_DISCOVERY`, `FB_ENRICH`, `ADSPOWER_API_BASE`, `ADSPOWER_API_KEY` matching the format of the existing rows.

In **Known Constraints → Social platforms**, replace the Facebook bullets with:

```markdown
- **Discovery is cookieless via Apify** (`FB_DISCOVERY=apify`, the default) — no account,
  no daily cap, and it runs on Cloud Run and Linux workers because it opens no browser.
  Public groups and open keyword search only; PRIVATE groups still need
  `FB_DISCOVERY=browser` with an account that has joined them.
- **Author enrichment defaults to `FB_ENRICH=stub`** — leads are built from the search
  result, no profile visits. Set `FB_ENRICH=browser` only when a campaign needs
  bio/website/email, and expect it to consume account quota.
- **Open-feed keyword search is ad-heavy.** The Gemini consumer classifier is the gate;
  measure qualified yield before scaling Apify spend.
- Engagement (opening a lead's post, commenting, DMs) still requires a logged-in
  account and stays on the browser path.
```

- [ ] **Step 3: Run the full test suite**

Run: `.venv/Scripts/python.exe -m pytest tests/ tools/ -v`
Expected: all pass

Run: `cd server && npx vitest run`
Expected: all pass except the pre-existing `src/db/scrape-jobs.test.ts` failure

- [ ] **Step 4: Live smoke — discovery only**

This is mandatory before merge (project standing rule: no scraper change ships on fixture tests alone).

```bash
.venv/Scripts/python.exe -m tools.scraper.run --platform facebook --action search-posts \
  --filters '{"query":"looking for a plumber in Manchester","niche":"plumber","location":"Manchester","lead_type":"consumers","groups_only":false,"max_results":20}' \
  --output .tmp/fb_apify_smoke.json
```

Confirm: the run prints `PROGRESS:apify_run` with a non-zero `returned`, then `PROGRESS:search_done`, and `.tmp/fb_apify_smoke.json` contains stubs with populated `post_url`, `author_profile_url` and `content_excerpt`.

**Record the yield** — `returned` versus the final stub count after the Gemini filter. That ratio is the number the spec says to measure before scaling spend.

- [ ] **Step 5: Live smoke — full chain to the database**

```bash
.venv/Scripts/python.exe -m tools.scraper.run --platform facebook --action enrich-authors \
  --input .tmp/fb_apify_smoke.json --output .tmp/fb_apify_leads.json

.venv/Scripts/python.exe tools/db/upsert_leads.py --input .tmp/fb_apify_leads.json
```

Confirm in Supabase: new rows in `leads` and `lead_platform_presences` with `platform='facebook'`, and **no row with `company_name` matching `(N) Facebook`**.

- [ ] **Step 6: Commit**

```bash
git add .env.example CLAUDE.md workflows/scrape_facebook.md
git commit -m "docs(scraper): document Apify FB discovery config and smoke procedure"
```

---

## STAGE B — AdsPower engagement

### Task 8: Migration 057 and the AdsPower client

**Files:**
- Create: `supabase/migrations/057_social_account_adspower_profile.sql`
- Create: `tools/scraper/shared/adspower.py`
- Test: `tests/scraper/test_adspower.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `start_profile(profile_id: str) -> dict` returning `{'debugger_address': str, 'webdriver_path': str}`
  - `stop_profile(profile_id: str) -> None`
  - `class AdsPowerError(RuntimeError)`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/057_social_account_adspower_profile.sql`:

```sql
-- AdsPower profile binding for social accounts.
--
-- An account with an adspower_profile_id opens through AdsPower's anti-detect
-- browser (isolated fingerprint per profile). NULL keeps the account on the
-- existing undetected-chromedriver + Brave persistent-profile path, which is
-- how this change stays a no-op for un-migrated accounts and how it rolls back.
ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS adspower_profile_id text;

COMMENT ON COLUMN social_accounts.adspower_profile_id IS
  'AdsPower Local API user_id. NULL = use the legacy Brave profile-dir path.';
```

- [ ] **Step 2: Write the failing tests**

Create `tests/scraper/test_adspower.py`:

```python
"""AdsPower Local API client tests. No network — requests.get is patched."""
import pytest

from tools.scraper.shared import adspower


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


def test_start_profile_returns_debug_address_and_driver(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': 0,
        'data': {
            'ws': {'selenium': '127.0.0.1:51234', 'puppeteer': 'ws://127.0.0.1:51234/dev'},
            'webdriver': 'C:\\adspower\\chromedriver.exe',
        },
    }))
    out = adspower.start_profile('kxxxxx')
    assert out['debugger_address'] == '127.0.0.1:51234'
    assert out['webdriver_path'] == 'C:\\adspower\\chromedriver.exe'


def test_start_profile_raises_on_api_error_code(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': -1, 'msg': 'user_id does not exist',
    }))
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.start_profile('nope')
    assert 'user_id does not exist' in str(exc.value)


def test_start_profile_raises_when_local_api_unreachable(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)

    def refuse(url, **kw):
        raise adspower.requests.exceptions.ConnectionError('connection refused')

    monkeypatch.setattr(adspower.requests, 'get', refuse)
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.start_profile('kxxxxx')
    assert 'AdsPower desktop app' in str(exc.value)


def test_start_profile_rejects_missing_selenium_address(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': 0, 'data': {'ws': {}, 'webdriver': 'x'},
    }))
    with pytest.raises(adspower.AdsPowerError):
        adspower.start_profile('kxxxxx')


def test_calls_are_throttled_to_one_per_second(monkeypatch):
    slept = []
    monkeypatch.setattr(adspower.time, 'sleep', slept.append)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': 0, 'data': {'ws': {'selenium': '127.0.0.1:1'}, 'webdriver': 'd'},
    }))
    adspower.start_profile('a')
    adspower.start_profile('b')
    assert slept, 'second call within 1s must be throttled'


def test_stop_profile_tolerates_already_stopped(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': -1, 'msg': 'browser is not open',
    }))
    adspower.stop_profile('kxxxxx')  # must not raise


def test_api_key_is_sent_when_configured(monkeypatch):
    monkeypatch.setenv('ADSPOWER_API_KEY', 'secret')
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    seen = {}

    def capture(url, **kw):
        seen.update(kw)
        return _Resp(200, {'code': 0, 'data': {'ws': {'selenium': '1:2'}, 'webdriver': 'd'}})

    monkeypatch.setattr(adspower.requests, 'get', capture)
    adspower.start_profile('a')
    assert seen['headers']['Authorization'] == 'secret'
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.scraper.shared.adspower'`

- [ ] **Step 4: Write the implementation**

Create `tools/scraper/shared/adspower.py`:

```python
"""AdsPower Local API client.

WHY THIS EXISTS

  Facebook links accounts by browser fingerprint as well as by IP. Running
  several accounts from one machine through one Chrome build makes them
  trivially correlatable. AdsPower gives each account an isolated profile —
  its own canvas/WebGL/audio/font/screen fingerprint, user-agent, timezone and
  proxy slot — and exposes a Local API to launch one and drive it with
  Selenium over CDP.

  It is NOT a proxy. It isolates fingerprints, not IPs. A profile still exits
  through whatever IP the host has unless a proxy is configured on the profile.

REQUIREMENTS

  The AdsPower desktop app must be running on the SAME host as this process —
  the API listens on localhost. That keeps this half host-bound, unlike the
  Apify discovery path which is a plain outbound HTTPS call.
"""
from __future__ import annotations

import os
import time
from typing import Optional

import requests

DEFAULT_BASE = 'http://local.adspower.net:50325'
REQUEST_TIMEOUT = 60
# AdsPower documents a 1 request/second limit on the Local API.
MIN_INTERVAL_SECONDS = 1.1

_last_call_at: float = 0.0


class AdsPowerError(RuntimeError):
    """A Local API call failed."""


def _base() -> str:
    return (os.environ.get('ADSPOWER_API_BASE') or DEFAULT_BASE).rstrip('/')


def _headers() -> dict:
    key = (os.environ.get('ADSPOWER_API_KEY') or '').strip()
    return {'Authorization': key} if key else {}


def _throttle() -> None:
    global _last_call_at
    elapsed = time.time() - _last_call_at
    if _last_call_at and elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_call_at = time.time()


def _call(path: str, params: dict) -> dict:
    _throttle()
    url = f'{_base()}{path}'
    try:
        resp = requests.get(url, params=params, headers=_headers(), timeout=REQUEST_TIMEOUT)
    except requests.exceptions.RequestException as exc:
        raise AdsPowerError(
            f'Could not reach the AdsPower Local API at {url}. Is the AdsPower '
            f'desktop app running on this host? Underlying error: {exc}'
        ) from exc
    if resp.status_code >= 400:
        raise AdsPowerError(f'AdsPower {path} returned HTTP {resp.status_code}: {resp.text[:200]}')
    payload = resp.json()
    if payload.get('code') != 0:
        raise AdsPowerError(f'AdsPower {path} failed: {payload.get("msg") or payload}')
    return payload.get('data') or {}


def start_profile(profile_id: str) -> dict:
    """Launch an AdsPower profile and return its Selenium attach details."""
    data = _call('/api/v1/browser/start', {
        'user_id': profile_id,
        'open_tabs': 1,       # don't restore the previous session's tabs
        'ip_tab': 0,          # skip AdsPower's own IP-check tab
    })
    debugger_address = ((data.get('ws') or {}).get('selenium') or '').strip()
    webdriver_path = (data.get('webdriver') or '').strip()
    if not debugger_address:
        raise AdsPowerError(
            f'AdsPower started profile {profile_id} but returned no selenium '
            f'debugger address. Response data: {data}'
        )
    print(f'INFO: AdsPower profile {profile_id} at {debugger_address}', flush=True)
    return {'debugger_address': debugger_address, 'webdriver_path': webdriver_path}


def stop_profile(profile_id: str) -> None:
    """Close an AdsPower profile. Already-closed is not an error."""
    try:
        _call('/api/v1/browser/stop', {'user_id': profile_id})
    except AdsPowerError as exc:
        print(f'WARN: AdsPower stop for {profile_id}: {exc}', flush=True)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py -v`
Expected: 7 passed

- [ ] **Step 6: Verify the response shape against a live AdsPower install**

The field names above (`data.ws.selenium`, `data.webdriver`, `code == 0`) come from AdsPower's published examples and **must be confirmed against the operator's actual install**:

```bash
curl "http://local.adspower.net:50325/api/v1/browser/start?user_id=<PROFILE_ID>"
```

If the real response differs, fix `start_profile` and the fixtures in Step 2 together.

- [ ] **Step 7: Apply the migration and commit**

Apply `057_social_account_adspower_profile.sql` in the Supabase SQL editor, then verify:

```sql
select column_name from information_schema.columns
where table_name = 'social_accounts' and column_name = 'adspower_profile_id';
```

```bash
git add supabase/migrations/057_social_account_adspower_profile.sql tools/scraper/shared/adspower.py tests/scraper/test_adspower.py
git commit -m "feat(scraper): add AdsPower Local API client and profile binding"
```

---

### Task 9: AdsPower branch in the shared driver opener

**Files:**
- Modify: `tools/scraper/shared/uc_driver.py:190-231` (top of `open_uc_driver`)
- Test: `tests/scraper/test_adspower.py` (append)

**Interfaces:**
- Consumes: `adspower.start_profile`
- Produces: `open_uc_driver(..., adspower_profile_id: Optional[str] = None)` — same return type as before

The file header warns its body is a byte-for-byte move of production Facebook logic that must not change without a live regression scrape. Adding a branch **above** that body honours the warning; do not edit anything below it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scraper/test_adspower.py`:

```python
from tools.scraper.shared import uc_driver


class _FakeDriver:
    def __init__(self, *a, **kw):
        self.kwargs = kw
        self.page_load_timeout = None

    def set_page_load_timeout(self, t):
        self.page_load_timeout = t

    def execute_cdp_cmd(self, *a, **kw):
        return {}


def test_opener_uses_adspower_when_profile_id_passed(monkeypatch):
    monkeypatch.setattr(uc_driver, '_open_adspower_driver', lambda pid: _FakeDriver(pid=pid))

    def boom(*a, **kw):
        raise AssertionError('must not fall through to undetected-chromedriver')

    monkeypatch.setattr(uc_driver, '_detect_chrome_major_version', boom)
    drv = uc_driver.open_uc_driver('FB_PROFILE_DIR', adspower_profile_id='kxxxxx')
    assert isinstance(drv, _FakeDriver)


def test_opener_reads_adspower_id_from_env_when_not_passed(monkeypatch):
    monkeypatch.setenv('ADSPOWER_PROFILE_ID', 'from-env')
    seen = {}

    def fake_open(pid):
        seen['pid'] = pid
        return _FakeDriver()

    monkeypatch.setattr(uc_driver, '_open_adspower_driver', fake_open)
    uc_driver.open_uc_driver('FB_PROFILE_DIR')
    assert seen['pid'] == 'from-env'


def test_explicit_argument_beats_env(monkeypatch):
    monkeypatch.setenv('ADSPOWER_PROFILE_ID', 'from-env')
    seen = {}
    monkeypatch.setattr(uc_driver, '_open_adspower_driver',
                        lambda pid: seen.setdefault('pid', pid) or _FakeDriver())
    uc_driver.open_uc_driver('FB_PROFILE_DIR', adspower_profile_id='explicit')
    assert seen['pid'] == 'explicit'


def test_opener_falls_through_when_no_adspower_id(monkeypatch):
    monkeypatch.delenv('ADSPOWER_PROFILE_ID', raising=False)

    def marker(pid):
        raise AssertionError('AdsPower must not be used without a profile id')

    monkeypatch.setattr(uc_driver, '_open_adspower_driver', marker)
    # Prove we reached the legacy body by making its first real call raise a
    # distinctive error instead of launching Chrome.
    monkeypatch.setattr(uc_driver, '_detect_chrome_major_version',
                        lambda: (_ for _ in ()).throw(RuntimeError('reached legacy path')))
    with pytest.raises(RuntimeError, match='reached legacy path'):
        uc_driver.open_uc_driver('FB_PROFILE_DIR')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py -k opener -v`
Expected: FAIL — `AttributeError: module ... has no attribute '_open_adspower_driver'`

- [ ] **Step 3: Add the AdsPower opener helper**

Add to `tools/scraper/shared/uc_driver.py`, above `open_uc_driver`:

```python
def _open_adspower_driver(profile_id: str):
    """Attach Selenium to a running AdsPower profile.

    AdsPower launches its own Chromium with the profile's fingerprint and
    proxy already applied, then hands back a CDP debugger address. We attach
    to it rather than launching Chrome ourselves — undetected-chromedriver's
    patches are unnecessary and would fight AdsPower's own stealth build.
    """
    from selenium import webdriver  # noqa: WPS433 — lazy
    from selenium.webdriver.chrome.service import Service  # noqa: WPS433

    from tools.scraper.shared import adspower  # noqa: WPS433

    session = adspower.start_profile(profile_id)
    options = webdriver.ChromeOptions()
    options.add_experimental_option('debuggerAddress', session['debugger_address'])
    service = Service(executable_path=session['webdriver_path']) if session.get('webdriver_path') else Service()
    driver = webdriver.Chrome(service=service, options=options)
    driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
    try:
        driver.execute_cdp_cmd(
            'Browser.grantPermissions',
            {
                'origin': 'https://www.facebook.com',
                'permissions': ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            },
        )
    except Exception as exc:  # noqa: BLE001
        print(f'WARN: clipboard CDP grant failed on AdsPower profile: {exc}', file=sys.stderr)
    return driver
```

- [ ] **Step 4: Add the branch at the top of `open_uc_driver`**

Add the parameter to the signature and the branch as the **first statements** of the body, before `import undetected_chromedriver as uc`:

```python
def open_uc_driver(
    profile_dir_env: str,
    *,
    user_agent: Optional[str] = None,
    window_size: tuple[int, int] = (1280, 900),
    headless: Optional[bool] = None,
    proxy_location: Optional[str] = None,
    adspower_profile_id: Optional[str] = None,
):
    # AdsPower branch. When the account being used is bound to an AdsPower
    # profile, that profile IS the browser — it carries its own fingerprint,
    # its own persistent cookies and its own proxy, so none of the flags,
    # profile-dir handling or selenium-wire proxy wiring below applies.
    # Everything below this branch is the original undetected-chromedriver
    # path, unchanged, and is what runs for any account without a profile id.
    adspower_id = adspower_profile_id or (os.environ.get('ADSPOWER_PROFILE_ID') or '').strip()
    if adspower_id:
        return _open_adspower_driver(adspower_id)

    import undetected_chromedriver as uc  # noqa: WPS433 — lazy
    ...
```

Leave the remainder of the function untouched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py -v`
Expected: 11 passed

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_uc_driver.py -v`
Expected: 3 passed (the existing proxy-helper regressions must still pass)

- [ ] **Step 6: Commit**

```bash
git add tools/scraper/shared/uc_driver.py tests/scraper/test_adspower.py
git commit -m "feat(scraper): open social sessions through AdsPower when bound"
```

---

### Task 10: Bind the claimed account to its AdsPower profile

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:1283-1299` (`_open_driver`)
- Modify: `tools/scraper/platforms/facebook.py` (`_open_session`)
- Test: `tests/scraper/test_adspower.py` (append)

**Interfaces:**
- Consumes: `open_uc_driver(..., adspower_profile_id=...)` from Task 9
- Produces: `_open_driver(account: Optional[dict] = None)`

`_claim_or_raise()` already returns the full `social_accounts` row, so after migration 057 the profile id is in hand at the call site — no TypeScript plumbing needed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scraper/test_adspower.py`:

```python
from tools.scraper.platforms import facebook as fbp


def test_open_driver_passes_account_adspower_id(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        'tools.scraper.shared.uc_driver.open_uc_driver',
        lambda env, **kw: seen.update(kw) or 'driver',
    )
    fbp._open_driver({'id': 'a', 'adspower_profile_id': 'kxxxxx'})
    assert seen['adspower_profile_id'] == 'kxxxxx'


def test_open_driver_without_account_passes_none(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        'tools.scraper.shared.uc_driver.open_uc_driver',
        lambda env, **kw: seen.update(kw) or 'driver',
    )
    fbp._open_driver()
    assert seen['adspower_profile_id'] is None


def test_open_driver_tolerates_account_without_the_column(monkeypatch):
    """Rows read before migration 057 have no adspower_profile_id key."""
    seen = {}
    monkeypatch.setattr(
        'tools.scraper.shared.uc_driver.open_uc_driver',
        lambda env, **kw: seen.update(kw) or 'driver',
    )
    fbp._open_driver({'id': 'a'})
    assert seen['adspower_profile_id'] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py -k open_driver -v`
Expected: FAIL — `TypeError: _open_driver() takes 0 positional arguments but 1 was given`

- [ ] **Step 3: Write the implementation**

Replace `_open_driver` in `facebook.py` (lines 1283-1299):

```python
def _open_driver(account: Optional[dict] = None):
    """Open Facebook's browser session.

    When the claimed social_accounts row carries an adspower_profile_id, the
    session opens through AdsPower (isolated fingerprint + the profile's own
    proxy). Otherwise this is unchanged: the shared undetected-chromedriver
    opener with FB_PROFILE_DIR and the residential-proxy wiring.
    """
    from tools.scraper.shared.uc_driver import open_uc_driver  # noqa: WPS433 — lazy
    return open_uc_driver(
        'FB_PROFILE_DIR',
        user_agent=None,
        window_size=(1280, 900),
        proxy_location=_CURRENT_LOCATION,
        adspower_profile_id=(account or {}).get('adspower_profile_id') or None,
    )
```

- [ ] **Step 4: Pass the account through from `_open_session`**

Find `_open_session` in `facebook.py` and change its internal `_open_driver()` call to `_open_driver(account)`. It already receives the account row as its argument, so no signature change is needed.

Verify no other caller broke:

```bash
grep -rn "_open_driver(" tools/ --include=*.py
```

`interactive_login.py:61` calls `fb._open_driver()` with no argument — still valid because the parameter is optional, and that flow falls back to `ADSPOWER_PROFILE_ID` from the environment.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py -v`
Expected: 14 passed

Run: `.venv/Scripts/python.exe -m pytest tests/ tools/ -v`
Expected: all pass

- [ ] **Step 6: Live validation — the operator runbook**

Nothing automated can confirm "the comment landed and the account survived".

1. Install AdsPower on the Windows desktop; confirm Local API access on the plan.
2. Create one profile: Windows fingerprint, **no proxy** (the home residential IP is already trusted).
3. Log `james@optiratesolutions.net` in by hand. **Expect a new-device checkpoint** — the fingerprint has changed from the Brave profile. Clear it.
4. Leave the profile idle ~24h. Do not scrape straight after a checkpoint.
5. Set the profile id on the account row:
   ```sql
   update social_accounts set adspower_profile_id = '<PROFILE_ID>'
   where id = '0eec969c-a888-4e54-bdfe-057ca11c2af5';
   ```
6. Draft and post one comment on the GB test lead (Radek Andel, `11802d64-c161-46ab-9033-1f00588f329c`).
7. Confirm the comment is visible on the real post and `social_accounts.status` is still `active`.

- [ ] **Step 7: Commit**

```bash
git add tools/scraper/platforms/facebook.py tests/scraper/test_adspower.py
git commit -m "feat(scraper): bind FB sessions to the claimed account's AdsPower profile"
```

---

## Deployment (operator runs these — never automated)

After Stage A is merged:

```bash
git push -u origin feat/fb-apify-adspower
```

```powershell
powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --project=trustpilot-leadgen --quiet"
```

Set the new variables on Cloud Run:

```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'APIFY_API_TOKEN=<token>,FB_DISCOVERY=apify,FB_ENRICH=stub' --quiet"
```

Post-deploy verification: submit a Facebook scrape from the dashboard and confirm it completes on Cloud Run **without** being refused as a Linux social job.

## Rollback

| Symptom | Action |
|---|---|
| Apify yield too low or actor broken | `FB_DISCOVERY=browser` |
| Need private-group results | `FB_DISCOVERY=browser` for that job |
| Leads missing bio/website | `FB_ENRICH=browser` |
| AdsPower session unstable | `update social_accounts set adspower_profile_id = null` |

No migration is reversed and no code is deleted by any of these.
