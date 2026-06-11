# Instagram Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the existing untested Instagram scraper skeleton to a live, lead-producing platform (business profiles + hashtag post authors), mirroring the proven Facebook stack.

**Architecture:** Extract Facebook's browser-opening and Gemini-classifier logic into shared modules, point both Facebook and Instagram at them, harden Instagram's driver/session/selectors, capture post captions for intent classification, generalize the worker's Linux guard + profile-dir routing to cover Instagram, then smoke-test locally and cut over to EC2.

**Tech Stack:** Python (undetected-chromedriver + selenium-wire + residential proxy), Express/TypeScript worker, Supabase (no schema changes), pytest (scraper) + vitest (server), Gemini 2.5 Flash (intent classifier).

**Spec:** [`docs/superpowers/specs/2026-06-11-instagram-scraper-design.md`](../specs/2026-06-11-instagram-scraper-design.md)

**Two deliberate deviations from the spec (smaller blast radius):**
1. Extract **only** `_classify_consumer_posts_with_gemini` to `social_nlp.py` (NOT the substring filters — they're entangled with 4+ module constants and IG doesn't need them; the batched Gemini call is the intent filter).
2. **Defer** the `campaign-scheduler.ts` → `lead_platform_posts` send-time join. The `{{post_excerpt}}`/`{{post_url}}` tokens already exist in `TOKEN_MAP`; v1 only guarantees the caption **data lands** in `lead_platform_posts`. The send-time join belongs to the future DM/consumer-email phase (v1 does not email consumer leads).

**Testing reality:** Browser scrapes can't be unit-tested against live DOM. Per repo convention ([`tests/scraper/test_facebook_helpers.py`](../../../tests/scraper/test_facebook_helpers.py) + the "smoke-test scrapers locally before push" rule), we write **pytest fixture/unit tests for pure functions** and run **explicit manual live-smoke steps** for anything that launches a browser. Steps are labeled `[AUTOMATED]` or `[MANUAL SMOKE]`.

---

## File Structure

**New files:**
- `tools/scraper/shared/uc_driver.py` — single parameterized undetected-chromedriver opener (profile dir, Brave binary, selenium-wire residential proxy, country swap). Used by Facebook, Instagram, and login_flows.
- `tools/scraper/shared/social_nlp.py` — `classify_consumer_posts_with_gemini()` (moved from facebook.py).
- `tests/scraper/test_uc_driver.py` — unit tests for the pure plumbing helpers in uc_driver.
- `tests/scraper/test_social_nlp.py` — unit tests for the classifier wrapper (no live API).
- `tests/scraper/test_instagram_parser.py` — fixture tests for IG caption/handle parsing.
- `server/src/services/social-routing.ts` — pure helpers `shouldRefuseSocialOnLinux(platform)` + `socialProfileEnv(platform, socialAccountId)`.
- `server/src/services/social-routing.test.ts` — vitest unit tests for the above.

**Modified files:**
- `tools/scraper/platforms/facebook.py` — `_open_driver` becomes a thin call to `uc_driver.open_uc_driver`; `_classify_consumer_posts_with_gemini` re-imported from `social_nlp`.
- `tools/scraper/platforms/instagram.py` — `_open_ig_driver` → shared opener; caption capture + intent filter in `_sync_search_hashtag`; `_open_session` uses persistent profile.
- `tools/scraper/shared/login_flows.py` — `_open_driver` delegates to the shared opener.
- `server/src/services/scrape-runner.ts` — Linux guard + profile-dir routing call the new pure helpers.

**Operational (no code):** Windows EC2 worker `PLATFORM_FILTER=facebook,instagram`; Linux EC2 worker `PLATFORM_EXCLUDE` includes `instagram`; `.env.example` documents `IG_PROFILE_DIR`.

---

## PHASE 0 — Shared extraction (GATED by a live Facebook regression)

### Task 1: Extract the shared UC-driver opener

**Files:**
- Create: `tools/scraper/shared/uc_driver.py`
- Create: `tests/scraper/test_uc_driver.py`
- Modify: `tools/scraper/platforms/facebook.py` (`_open_driver` ~1378-1572 and the proxy helpers ~1276-1376)
- Modify: `tools/scraper/shared/login_flows.py` (`_open_driver` ~113-176)

- [ ] **Step 1: Impact analysis (MANDATORY — repo golden rule)**

Run the GitNexus impact tool and report the blast radius before editing:
```
gitnexus_impact({target: "_open_driver", direction: "upstream"})
```
Expected: lists `facebook._sync_*` callers + `login_flows`. If risk is HIGH/CRITICAL, surface it to the user before continuing.

- [ ] **Step 2: [AUTOMATED] Write failing tests for the pure plumbing helpers**

Create `tests/scraper/test_uc_driver.py`. These test only the string/logic helpers that move with the driver — never launch Chrome:
```python
from tools.scraper.shared.uc_driver import (
    resolve_proxy_country, apply_proxy_country, apply_proxy_country_password,
)


def test_resolve_proxy_country_falls_back_when_unmappable():
    assert resolve_proxy_country(None, fallback='AT') == 'AT'
    assert resolve_proxy_country('Atlantis, Nowhere', fallback='AT') == 'AT'


def test_apply_proxy_country_rewrites_area_token():
    assert apply_proxy_country('pl-XYZ_area-AT', 'GB') == 'pl-XYZ_area-GB'


def test_apply_proxy_country_password_rewrites_country_token():
    assert apply_proxy_country_password('58fc_country-AT', 'GB') == '58fc_country-GB'
```

- [ ] **Step 3: [AUTOMATED] Run the tests to confirm they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_uc_driver.py -v`
Expected: FAIL — `ModuleNotFoundError: tools.scraper.shared.uc_driver`.

- [ ] **Step 4: Create `uc_driver.py` by moving the driver logic verbatim**

Move these functions **verbatim** out of `facebook.py` into the new module, renaming the proxy helpers to public names (drop the leading underscore) so the tests above resolve: `_build_proxy_auth_extension`, `_resolve_proxy_country → resolve_proxy_country`, `_apply_proxy_country → apply_proxy_country`, `_apply_proxy_country_password → apply_proxy_country_password`. Then add the parameterized opener whose body is Facebook's current `_open_driver` (lines ~1378-1572) with three substitutions:
- the profile-dir env var name becomes the `profile_dir_env` parameter,
- the optional custom user-agent becomes the `user_agent` parameter (Facebook passes `None` → no `--user-agent` arg, preserving current behavior; Instagram passes the mobile UA),
- the window size becomes the `window_size` parameter, and `_CURRENT_LOCATION` becomes the `proxy_location` parameter.

```python
"""Single undetected-chromedriver opener shared by all social platforms.

Extracted verbatim from facebook.py (2026-06-11) so Instagram gets the
same persistent-profile + selenium-wire residential-proxy stack that
keeps Facebook from being checkpointed on datacenter IPs. Behavior for
Facebook is unchanged — facebook._open_driver() now just calls this.
"""
from __future__ import annotations
import os, re, sys, zipfile, tempfile, textwrap
from typing import Optional

PAGE_LOAD_TIMEOUT = 60  # keep in sync with facebook.PAGE_LOAD_TIMEOUT

def _detect_chrome_major_version() -> Optional[int]:
    ...  # move facebook.py's copy verbatim (or import from login_flows)

def _build_proxy_auth_extension(host, port, username, password) -> str:
    ...  # verbatim move

def resolve_proxy_country(location: Optional[str], fallback: str = 'AT') -> str:
    ...  # verbatim move of _resolve_proxy_country

def apply_proxy_country(username: str, cc: str) -> str:
    ...  # verbatim move of _apply_proxy_country

def apply_proxy_country_password(password: str, cc: str) -> str:
    ...  # verbatim move of _apply_proxy_country_password

def open_uc_driver(
    profile_dir_env: str,
    *,
    user_agent: Optional[str] = None,
    window_size: tuple[int, int] = (1280, 900),
    headless: Optional[bool] = None,
    proxy_location: Optional[str] = None,
):
    """Body = facebook._open_driver() verbatim, with the four substitutions
    described in the plan. Reads RESIDENTIAL_PROXY_* + the profile dir from
    os.environ[profile_dir_env]. Returns a webdriver; caller must quit()."""
    ...
```

The `_extract_country_from_excerpt` dependency of `resolve_proxy_country` stays in `facebook.py`; import it into `uc_driver.py` lazily inside `resolve_proxy_country` to avoid a circular import:
```python
def resolve_proxy_country(location, fallback='AT'):
    if not location:
        return fallback
    from tools.scraper.platforms.facebook import _extract_country_from_excerpt
    cc = _extract_country_from_excerpt(location)
    return cc if cc else fallback
```

- [ ] **Step 5: [AUTOMATED] Run the helper tests to confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_uc_driver.py -v`
Expected: 3 passed.

- [ ] **Step 6: Rewire `facebook._open_driver` to a thin call**

Replace the body of `facebook._open_driver()` with:
```python
def _open_driver():
    """Thin wrapper — see tools/scraper/shared/uc_driver.open_uc_driver.
    Facebook keeps its desktop fingerprint (no custom UA) + 1280x900."""
    from tools.scraper.shared.uc_driver import open_uc_driver
    return open_uc_driver(
        'FB_PROFILE_DIR',
        user_agent=None,
        window_size=(1280, 900),
        proxy_location=_CURRENT_LOCATION,
    )
```
Delete the now-moved proxy helper definitions from `facebook.py` and replace any internal references (`_resolve_proxy_country`, etc.) with imports from `uc_driver` if still used elsewhere in `facebook.py` (grep first: `grep -n "_resolve_proxy_country\|_apply_proxy_country\|_build_proxy_auth_extension" tools/scraper/platforms/facebook.py`).

- [ ] **Step 7: Rewire `login_flows._open_driver` to delegate**

In `login_flows.py`, replace the `use_proxy` delegation block (which imports `facebook as fb` and calls `fb._open_driver()`) with a direct call to the shared opener so login no longer reaches into the facebook module:
```python
from tools.scraper.shared.uc_driver import open_uc_driver
region = os.environ.get('RESIDENTIAL_PROXY_REGION', 'PH').upper()
region_to_city = {'PH':'Cebu','GB':'London','DE':'Berlin','FR':'Paris','ES':'Madrid',
                  'IT':'Rome','NL':'Amsterdam','US':'New York','AU':'Sydney','SG':'Singapore','IE':'Dublin'}
return open_uc_driver('FB_PROFILE_DIR', headless=headless,
                      proxy_location=region_to_city.get(region, 'Cebu'))
```

- [ ] **Step 8: [AUTOMATED] Full pytest + import sanity**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/ -v`
Then: `.venv/Scripts/python.exe -c "import tools.scraper.platforms.facebook; import tools.scraper.shared.login_flows; print('imports ok')"`
Expected: all green, `imports ok`.

- [ ] **Step 9: [MANUAL SMOKE — HARD GATE] Live Facebook regression**

With the owner's FB session/profile available locally, run one small real FB scrape:
```
.venv/Scripts/python.exe -m tools.scraper.run --platform facebook --action search-posts \
  --filters "{\"lead_type\":\"consumers\",\"niche\":\"handyman\",\"location\":\"London\",\"groups_only\":true}" \
  --output .tmp/fb_regress.json --max-results 3
```
Expected: completes with ≥1 post stub, **no checkpoint**, proxy line printed in stderr when proxy env is set.
**STOP CONDITION:** If Facebook regresses and can't be fixed within this task, revert Task 1 entirely (`git checkout -- .`) and switch Instagram to a self-contained copy of the driver (spec fallback "B"). Do not proceed to Task 2 with a broken FB.

- [ ] **Step 10: Commit**
```
git add tools/scraper/shared/uc_driver.py tests/scraper/test_uc_driver.py tools/scraper/platforms/facebook.py tools/scraper/shared/login_flows.py
git commit -m "refactor(scraper): extract shared uc_driver opener for FB + IG"
```

---

### Task 2: Extract the Gemini consumer classifier

**Files:**
- Create: `tools/scraper/shared/social_nlp.py`
- Create: `tests/scraper/test_social_nlp.py`
- Modify: `tools/scraper/platforms/facebook.py` (`_classify_consumer_posts_with_gemini` ~498-645)

- [ ] **Step 1: Impact analysis**

Run: `gitnexus_impact({target: "_classify_consumer_posts_with_gemini", direction: "upstream"})`. Report callers (expected: `facebook._sync_group_first_scrape` / consumer path).

- [ ] **Step 2: [AUTOMATED] Write failing test**

Create `tests/scraper/test_social_nlp.py`:
```python
import os
from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini


def test_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('NEXT_PUBLIC_GEMINI_API_KEY', raising=False)
    assert classify_consumer_posts_with_gemini(['anyone know a plumber?'], 'plumber') is None


def test_returns_none_on_empty_input(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    assert classify_consumer_posts_with_gemini([], 'plumber') is None
```

- [ ] **Step 3: [AUTOMATED] Run to confirm it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_social_nlp.py -v`
Expected: FAIL — module not found.

- [ ] **Step 4: Move the classifier verbatim**

Create `social_nlp.py` and move `_classify_consumer_posts_with_gemini` into it as the public `classify_consumer_posts_with_gemini` (drop the underscore; body verbatim — it only reads `GEMINI_API_KEY`/`NEXT_PUBLIC_GEMINI_API_KEY` and `requests`, no FB-module dependencies). In `facebook.py`, replace the definition with a re-export so existing FB callers keep working unchanged:
```python
from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini as _classify_consumer_posts_with_gemini
```

- [ ] **Step 5: [AUTOMATED] Run to confirm pass + FB import sanity**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_social_nlp.py -v`
Then: `.venv/Scripts/python.exe -c "import tools.scraper.platforms.facebook; print('ok')"`
Expected: 2 passed, `ok`.

- [ ] **Step 6: Commit**
```
git add tools/scraper/shared/social_nlp.py tests/scraper/test_social_nlp.py tools/scraper/platforms/facebook.py
git commit -m "refactor(scraper): extract gemini consumer classifier to social_nlp"
```

---

## PHASE 1 — Instagram driver + session hardening

### Task 3: Point `_open_ig_driver` at the shared opener

**Files:**
- Modify: `tools/scraper/platforms/instagram.py` (`_open_ig_driver` ~55-68)

- [ ] **Step 1: Replace the vanilla driver with the shared opener**

```python
def _open_ig_driver():
    """Mobile-flavored driver with the SAME proxy + persistent-profile
    stack Facebook uses. IG_PROFILE_DIR holds the logged-in profile."""
    from tools.scraper.shared.uc_driver import open_uc_driver
    return open_uc_driver(
        'IG_PROFILE_DIR',
        user_agent=MOBILE_UA,
        window_size=(414, 896),
        proxy_location=os.environ.get('IG_PROXY_LOCATION'),
    )
```

- [ ] **Step 2: [AUTOMATED] Import sanity**

Run: `.venv/Scripts/python.exe -c "from tools.scraper.platforms.instagram import InstagramScraper; print('ok')"`
Expected: `ok` (no Chrome launch — `_open_ig_driver` isn't called at import).

- [ ] **Step 3: Commit**
```
git add tools/scraper/platforms/instagram.py
git commit -m "feat(scraper): give instagram the shared proxy + profile driver"
```

---

### Task 4: Persistent-profile session in `_open_session`

**Files:**
- Modify: `tools/scraper/platforms/instagram.py` (`_open_session` ~200-211)

- [ ] **Step 1: Keep cookie injection as a second layer behind the profile**

The persistent `IG_PROFILE_DIR` profile already carries the logged-in session; injected `sessionid` is a fallback for first-run/empty profiles. Leave the existing `_open_session` logic (it already injects cookies and detects the `/accounts/login` redirect as checkpoint) — confirm it still works against the shared driver and add a clarifying comment:
```python
def _open_session(self, account: dict):
    driver = _open_ig_driver()            # now profile + proxy aware
    driver.get(IG_BASE)
    jar = load_cookies(account['id'])     # 2nd-layer fallback; profile is primary
    if jar:
        _inject_cookies(driver, jar)
        driver.get(IG_BASE)
    if '/accounts/login' in driver.current_url:
        driver.quit()
        _flag_checkpoint(account['id'], 'cookies-rejected-redirected-to-login')
        raise RuntimeError(f"Instagram rejected cookies for {account['handle']} — needs re-connect")
    return driver
```

- [ ] **Step 2: Commit**
```
git add tools/scraper/platforms/instagram.py
git commit -m "docs(scraper): clarify instagram session uses profile-first + cookie fallback"
```

---

## PHASE 2 — Caption capture + intent filter

### Task 5: Capture post captions during hashtag search

**Files:**
- Modify: `tools/scraper/platforms/instagram.py` (`_sync_search_hashtag` ~213-264)
- Create: `tests/scraper/test_instagram_parser.py`

- [ ] **Step 1: [AUTOMATED] Write failing test for the caption parser**

Add a pure module-level helper `_caption_from_og(html: str) -> str` and test it against a fixture string (mirrors the repo's fixture convention):
```python
from tools.scraper.platforms.instagram import _caption_from_og


def test_caption_from_og_extracts_description():
    html = '<meta property="og:description" content="2,300 likes - someone: Need a plumber in Leeds ASAP">'
    assert 'plumber in Leeds' in _caption_from_og(html)


def test_caption_from_og_returns_empty_when_absent():
    assert _caption_from_og('<html><head></head></html>') == ''
```

- [ ] **Step 2: [AUTOMATED] Run to confirm it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_instagram_parser.py -v`
Expected: FAIL — `_caption_from_og` not defined.

- [ ] **Step 3: Implement the parser + wire caption capture into the search loop**

Add the helper near the top of `instagram.py`:
```python
import re as _re
_OG_DESC_RE = _re.compile(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']*)["\']', _re.I)

def _caption_from_og(html: str) -> str:
    """Pull the post caption out of the og:description meta tag — robust to
    IG's React DOM churn (the meta tag is server-rendered). Strips the
    leading 'N likes - author:' prefix IG prepends."""
    m = _OG_DESC_RE.search(html or '')
    if not m:
        return ''
    raw = m.group(1)
    return raw.split(':', 1)[1].strip() if ':' in raw else raw.strip()
```
Then in `_sync_search_hashtag`, after a PostStub's `post_url` is collected, visit it and fill `content_excerpt` (cap by `max_results`, sleep between loads):
```python
for stub in results:
    try:
        driver.get(stub['post_url'])
        time.sleep(SCROLL_PAUSE)
        if _is_checkpoint(driver):
            _flag_checkpoint(account['id'], 'captcha-during-caption')
            break
        stub['content_excerpt'] = _caption_from_og(driver.page_source)
        _emit(on_progress, 'caption_captured', url=stub['post_url'])
    except Exception:
        stub['content_excerpt'] = ''
```

- [ ] **Step 4: [AUTOMATED] Run to confirm pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_instagram_parser.py -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**
```
git add tools/scraper/platforms/instagram.py tests/scraper/test_instagram_parser.py
git commit -m "feat(scraper): capture instagram post captions via og:description"
```

---

### Task 6: Filter hashtag posts by consumer intent

**Files:**
- Modify: `tools/scraper/platforms/instagram.py` (`_sync_search_hashtag` return path)
- Modify: `tests/scraper/test_instagram_parser.py`

- [ ] **Step 1: [AUTOMATED] Write failing test for the filter glue (classifier stubbed)**

```python
import tools.scraper.platforms.instagram as ig


def test_filter_keeps_only_consumer_verdicts(monkeypatch):
    posts = [{'content_excerpt': 'need a plumber'}, {'content_excerpt': 'BOOK NOW 20% off'}]
    monkeypatch.setattr(ig, 'classify_consumer_posts_with_gemini', lambda excerpts, niche, location=None: [True, False])
    kept = ig._filter_consumer_posts(posts, niche='plumber', location=None)
    assert len(kept) == 1 and kept[0]['content_excerpt'] == 'need a plumber'


def test_filter_keeps_all_when_classifier_unavailable(monkeypatch):
    posts = [{'content_excerpt': 'a'}, {'content_excerpt': 'b'}]
    monkeypatch.setattr(ig, 'classify_consumer_posts_with_gemini', lambda *a, **k: None)
    assert ig._filter_consumer_posts(posts, niche='plumber', location=None) == posts
```

- [ ] **Step 2: [AUTOMATED] Run to confirm it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_instagram_parser.py -k filter -v`
Expected: FAIL — `_filter_consumer_posts` not defined.

- [ ] **Step 3: Implement the filter and call it before returning from search**

Add the import at the top of `instagram.py`:
```python
from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini
```
Add the function:
```python
def _filter_consumer_posts(posts: list[dict], *, niche: str, location):
    """Drop posts the Gemini classifier marks non-consumer. Classifier
    None (no key / API fail) => keep everything (substring fallback is
    FB-only; IG relies on the LLM verdict)."""
    if not posts:
        return posts
    verdicts = classify_consumer_posts_with_gemini(
        [p.get('content_excerpt', '') for p in posts], niche, location=location,
    )
    if verdicts is None or len(verdicts) != len(posts):
        return posts
    return [p for p, keep in zip(posts, verdicts) if keep]
```
In `_sync_search_hashtag`, after caption capture, filter before returning (use the hashtag as the niche, the `location` filter if present):
```python
results = _filter_consumer_posts(results, niche=tag, location=None)
_emit(on_progress, 'search_done', total=len(results))
return results
```

- [ ] **Step 4: [AUTOMATED] Run to confirm pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_instagram_parser.py -v`
Expected: all passed.

- [ ] **Step 5: Commit**
```
git add tools/scraper/platforms/instagram.py tests/scraper/test_instagram_parser.py
git commit -m "feat(scraper): filter instagram hashtag posts by consumer intent"
```

---

## PHASE 3 — Worker / dispatch wiring

### Task 7: Generalize the Linux guard + profile-dir routing to Instagram

**Files:**
- Create: `server/src/services/social-routing.ts`
- Create: `server/src/services/social-routing.test.ts`
- Modify: `server/src/services/scrape-runner.ts` (Linux guard ~655-661; profile-dir ~642-645)

- [ ] **Step 1: [AUTOMATED] Write failing vitest unit tests**

Create `server/src/services/social-routing.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { shouldRefuseSocialOnLinux, socialProfileEnv } from './social-routing.js';

describe('shouldRefuseSocialOnLinux', () => {
  it('refuses facebook and instagram on linux', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux')).toBe(true);
    expect(shouldRefuseSocialOnLinux('instagram', 'linux')).toBe(true);
  });
  it('allows review platforms on linux and any platform on win32', () => {
    expect(shouldRefuseSocialOnLinux('yelp', 'linux')).toBe(false);
    expect(shouldRefuseSocialOnLinux('instagram', 'win32')).toBe(false);
  });
});

describe('socialProfileEnv', () => {
  it('maps facebook/instagram to their per-account profile dirs', () => {
    expect(socialProfileEnv('facebook', 'abc')).toEqual({ FB_PROFILE_DIR: 'C:\\fb-profiles\\abc' });
    expect(socialProfileEnv('instagram', 'abc')).toEqual({ IG_PROFILE_DIR: 'C:\\ig-profiles\\abc' });
  });
  it('returns empty when no social account id', () => {
    expect(socialProfileEnv('facebook', undefined)).toEqual({});
    expect(socialProfileEnv('yelp', 'abc')).toEqual({});
  });
});
```

- [ ] **Step 2: [AUTOMATED] Run to confirm failure**

Run: `cd server && npx vitest run src/services/social-routing.test.ts`
Expected: FAIL — cannot find `./social-routing.js`.

- [ ] **Step 3: Implement the pure helpers**

Create `server/src/services/social-routing.ts`:
```typescript
/** Routing decisions for social-platform scrape jobs, extracted as pure
 *  functions so scrape-runner stays thin and these stay unit-testable. */
const SOCIAL_PLATFORMS = new Set(['facebook', 'instagram']);

export function shouldRefuseSocialOnLinux(platform: string, osPlatform: NodeJS.Platform | string): boolean {
  return SOCIAL_PLATFORMS.has(platform) && osPlatform === 'linux';
}

export function socialProfileEnv(platform: string, socialAccountId?: string): Record<string, string> {
  if (!socialAccountId) return {};
  if (platform === 'facebook') return { FB_PROFILE_DIR: `C:\\fb-profiles\\${socialAccountId}` };
  if (platform === 'instagram') return { IG_PROFILE_DIR: `C:\\ig-profiles\\${socialAccountId}` };
  return {};
}
```

- [ ] **Step 4: [AUTOMATED] Run to confirm pass**

Run: `cd server && npx vitest run src/services/social-routing.test.ts`
Expected: all passed.

- [ ] **Step 5: Wire the helpers into scrape-runner.ts**

Replace the FB-only `platformEnv` block (~642-645) with:
```typescript
import { shouldRefuseSocialOnLinux, socialProfileEnv } from './social-routing.js';
// ...
const platformEnv: NodeJS.ProcessEnv = socialProfileEnv(platform, socialAccountId);
```
Replace the FB-only Linux guard (~655-661) with:
```typescript
if (shouldRefuseSocialOnLinux(platform, process.platform)) {
  throw new Error(
    `${platform} scraping is not supported on Linux workers — set ` +
    `PLATFORM_EXCLUDE=${platform} on this worker. Job will be re-queued for a Windows worker.`,
  );
}
```

- [ ] **Step 6: [AUTOMATED] Type-check the server**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**
```
git add server/src/services/social-routing.ts server/src/services/social-routing.test.ts server/src/services/scrape-runner.ts
git commit -m "feat(scraper): route instagram jobs to windows worker like facebook"
```

---

### Task 8: Document the Instagram env vars + worker filters

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md` (Known Constraints → Instagram)

- [ ] **Step 1: Add the IG env vars to `.env.example`**

```
# Instagram scraper (mirrors FB). Per-account profile dir injected by the
# worker; single-tenant default below for owner runs.
IG_PROFILE_DIR=
IG_PROXY_LOCATION=
```

- [ ] **Step 2: Note the worker filter requirement in CLAUDE.md**

Under the Instagram constraints, add: "Runs on the Windows EC2 worker only (set `PLATFORM_FILTER=facebook,instagram` there and add `instagram` to the Linux worker's `PLATFORM_EXCLUDE`). Smoke-tested locally first on the owner's residential IP."

- [ ] **Step 3: Commit**
```
git add .env.example CLAUDE.md
git commit -m "docs(scraper): document instagram env vars + worker routing"
```

---

## PHASE 4 — Connect Instagram + local smoke (MANUAL)

### Task 9: Connect an Instagram account locally

**Files:** none (operational)

- [ ] **Step 1: Create the social_accounts row**

With the local API running (`cd server && npm run dev`), create the row:
```
POST http://localhost:3001/api/social-accounts  body: {"platform":"instagram","handle":"<ig_handle>"}
```
Note the returned `id`.

- [ ] **Step 2: [MANUAL SMOKE] Run the local connect/login flow**

Set `IG_PROFILE_DIR` to a fresh local dir, then:
```
.venv/Scripts/python.exe -m tools.scraper.shared.login_flows --account-id <id>
```
A Chrome window opens on IG's login page. Log in (+2FA). Expected stdout: `STAGE:cookies_captured` then `STAGE:done`. Verify `social_accounts.status='active'` and `has_cookies=true` via `GET /api/social-accounts`.

---

### Task 10: [MANUAL SMOKE] Business-mode local run

**Files:** `tools/scraper/platforms/instagram.py` (selector fixes as needed)

- [ ] **Step 1: Run business-mode listing**
```
.venv/Scripts/python.exe -m tools.scraper.run --platform instagram --action list \
  --filters "{\"lead_type\":\"businesses\",\"category\":\"plumber\"}" \
  --output .tmp/ig_biz.json --max-results 10
```
Expected: `.tmp/ig_biz.json` has rows with `profile_url`. If empty, inspect the live DOM (`driver.page_source`) and fix the `a[role="link"][href^="/"]` selector in `_sync_scrape_business_profiles`; re-run until ≥1 row.

- [ ] **Step 2: Run business-mode enrichment**
```
.venv/Scripts/python.exe -m tools.scraper.run --platform instagram --action enrich \
  --input .tmp/ig_biz.json --output .tmp/ig_biz_enriched.json
```
Expected: rows gain `website_url` (bio link) where present. Fix the bio-link selector if all null and the profiles visibly have links.

- [ ] **Step 3: Commit any selector fixes**
```
git add tools/scraper/platforms/instagram.py
git commit -m "fix(scraper): tune instagram business-mode selectors against live DOM"
```

---

### Task 11: [MANUAL SMOKE] Hashtag-mode local run

- [ ] **Step 1: Run hashtag search-posts**
```
.venv/Scripts/python.exe -m tools.scraper.run --platform instagram --action search-posts \
  --filters "{\"query\":\"plumberlondon\"}" --output .tmp/ig_posts.json --max-results 8
```
Expected: post stubs with `post_url`, `author_profile_url`, and **non-empty `content_excerpt`** for most; `caption_captured` events in the log. After the Gemini filter, count should drop to consumer-intent posts only (verify `GEMINI_API_KEY` is set). Fix the `a[href*="/p/"]` grid selector if zero posts.

- [ ] **Step 2: Run enrich-authors**
```
.venv/Scripts/python.exe -m tools.scraper.run --platform instagram --action enrich-authors \
  --input .tmp/ig_posts.json --output .tmp/ig_authors.json
```
Expected: AuthorLeads with `profile_url` + `posts[]` carrying `content_excerpt`.

- [ ] **Step 3: Commit any selector fixes**
```
git add tools/scraper/platforms/instagram.py
git commit -m "fix(scraper): tune instagram hashtag-mode selectors against live DOM"
```

---

## PHASE 5 — Pipeline test (local, MANUAL)

### Task 12: End-to-end business-mode → verified email in CRM

- [ ] **Step 1: Submit a real business-mode scrape through the local API**
```
POST http://localhost:3001/api/scrape  body:
{"platform":"instagram","filters":{"lead_type":"businesses","category":"plumber"},"max_results":15,"socialAccountId":"<id>"}
```
Watch the SSE status to completion.

- [ ] **Step 2: Verify leads + presences landed**

In Supabase, confirm `lead_platform_presences` rows with `platform='instagram'` and the leads appear in the CRM Leads table.

- [ ] **Step 3: Enrich websites → verify emails**

Run `scrape_website.py` over the new leads' `website_url`s, then `POST /api/verify` (ZeroBounce). Confirm ≥1 lead reaches `verification_status='valid'` and shows a `primary_email` in the CRM.

- [ ] **Step 4: Verify caption data for the hashtag run**

Confirm `lead_platform_posts` rows for the hashtag-mode leads carry a non-empty `content_excerpt` (this is the `{{post_excerpt}}` data source; send-time rendering is deferred to the DM phase).

---

## PHASE 6 — Live on EC2 (MANUAL)

### Task 13: Connect an EC2 Instagram session + enable the worker

- [ ] **Step 1: Connect a second IG session through the EC2 noVNC tunnel**

`POST /api/social-accounts/:id/connect` (or a fresh IG row), open the returned tunnel URL, log in through the Enigma-proxied browser so the cookies bind to the EC2 IP class. Confirm `status='active'`.

- [ ] **Step 2: Add instagram to the worker platform filters**

On the Windows EC2 worker set `PLATFORM_FILTER=facebook,instagram`; on the Linux worker add `instagram` to `PLATFORM_EXCLUDE`. Restart the workers (per the EC2 deploy memory).

- [ ] **Step 3: Provide the deploy commands to the operator (do NOT auto-deploy)**

Output the git push + `gcloud run deploy trustpilot-crm ... --project=trustpilot-leadgen` commands and the EC2 worker restart steps for the user to run.

---

### Task 14: [MANUAL] Live run meeting the success bar

- [ ] **Step 1: Run one real business-mode category/city on EC2**

Submit via the local API (owner-driven) targeting a real niche/city; the Windows EC2 worker claims it.

- [ ] **Step 2: Confirm the success bar**

Pass = **≥10 business profiles with a `website_url`**, **≥3 enriching to a verified email** visible in the CRM, and the IG account **stays `active`** (no checkpoint) through the run. If the account checkpoints, recover via `POST /api/social-accounts/:id/recover` and lower `daily_cap`/add per-post delay before retrying.

- [ ] **Step 3: Capture a fixture for regression**

Save one IG post-page HTML and one profile-page HTML into `tests/scraper/fixtures/` and add a parser assertion to `test_instagram_parser.py` so future IG DOM drift is caught in CI. Commit.

---

## Self-Review

**Spec coverage:**
- Both lead modes → Tasks 10 (business) + 11 (hashtag). ✓
- Shared uc_driver extraction (decision #4) → Task 1, with the mandatory impact-analysis + FB-regression gate. ✓
- Classifier extraction (decision #5) → Task 2 (classifier only; filters deliberately left in FB — documented deviation). ✓
- Caption capture + intent filter (decision #5) → Tasks 5 + 6. ✓
- Connect-IG (decision #2) → Task 9 (local) + Task 13 (EC2). ✓
- Local-smoke → EC2-live (decision #3) → Phases 4-5 local, Phase 6 EC2. ✓
- Linux guard + profile-dir generalization → Task 7. ✓
- `{{post_excerpt}}` → tokens already in TOKEN_MAP; data capture covered (Task 5 + Task 12 step 4); send-time join deferred (documented deviation). ✓
- Success bar (decision #6) → Task 14 step 2. ✓
- Risk: FB regression → Task 1 step 9 hard gate + revert path. ✓

**Placeholder scan:** Extraction tasks (1, 2) use "move verbatim" for bodies that already exist — this is a complete instruction for a move, not a hand-wave; all NEW glue (signatures, wrappers, imports, tests) is shown in full. No TBD/TODO. ✓

**Type/name consistency:** `open_uc_driver(profile_dir_env, *, user_agent, window_size, headless, proxy_location)` used identically in Tasks 1, 3. `classify_consumer_posts_with_gemini(excerpts, niche, location=)` consistent across Tasks 2, 6. `_caption_from_og`, `_filter_consumer_posts`, `shouldRefuseSocialOnLinux`, `socialProfileEnv` referenced with the same signatures where defined and used. ✓
