# Yelp Browser-Based Listing + Country Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Yelp listing with a free headed-browser `/search` scraper (replacing the dead Fusion API), behind a `YELP_LISTING_SOURCE` toggle, and expand Yelp from 13 → 24 countries.

**Architecture:** Keep the existing `scrape_listing` city fan-out / in-process filter / `enrich_profiles` (ScrapingBee) flow. Swap only the per-city search call: a new browser path loads `yelp.com/search` via the existing `LocalBrowserFetcher` and a new card parser, returning **Fusion-shaped business dicts** so the downstream loop is unchanged.

**Tech Stack:** Python 3, undetected-chromedriver (headed, via `LocalBrowserFetcher`), BeautifulSoup (lxml), existing `BasePlatformScraper` contract.

## Global Constraints

- Plugin contract: `scrape_listing` / `enrich_profiles` signatures in `tools/scraper/platforms/base.py` must not change.
- Browser path is **owner-local-only** (headed Chrome + residential IP; cannot run on Cloud Run/EC2).
- `YELP_LISTING_SOURCE` ∈ {`browser`, `fusion`}, default `browser`.
- Block detection for Yelp uses the hard-block phrase `"Access to this page has been denied"` ONLY — never `perimeterx`/`captcha`/`px-captcha` (SDK present on every successful page).
- Conservative jittered pacing (PerimeterX is aggressive); abort + report on hard-block.
- Run tests with `.venv/Scripts/python.exe`. Filter dotenv noise with `2>&1 | grep -v 'could not parse'`.
- ScrapingBee `/biz` enrichment stays unchanged.

---

### Task 1: Make `LocalBrowserFetcher` block markers configurable

`BLOCK_MARKERS` is currently a module constant with TripAdvisor's phrases. Yelp's hard-block phrase differs, so make block markers a per-instance parameter (defaulting to the existing constant) and have `_is_block` use the instance value.

**Files:**
- Modify: `tools/scraper/shared/local_browser.py`
- Test: `tests/scraper/test_local_browser_block.py` (create)

**Interfaces:**
- Produces: `LocalBrowserFetcher(..., block_markers: tuple[str, ...] = BLOCK_MARKERS)`; instance method `_is_block(html: str) -> bool` reads `self.block_markers`.

- [ ] **Step 1: Write the failing test**

```python
# tests/scraper/test_local_browser_block.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.shared.local_browser import LocalBrowserFetcher

def test_default_block_markers_detect_tripadvisor_wall():
    f = LocalBrowserFetcher()
    assert f._is_block('... Access is temporarily restricted ...') is True

def test_custom_block_markers_detect_yelp_wall():
    f = LocalBrowserFetcher(block_markers=('Access to this page has been denied',))
    assert f._is_block('<h1>Access to this page has been denied</h1>') is True

def test_custom_block_markers_ignore_perimeterx_sdk():
    # The PerimeterX SDK string appears on EVERY successful Yelp page.
    f = LocalBrowserFetcher(block_markers=('Access to this page has been denied',))
    assert f._is_block('<script>window._pxAppId="PXxxxx";// perimeterx px-captcha</script>') is False

if __name__ == '__main__':
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for fn in fns:
        try: fn(); print(f'PASS {fn.__name__}')
        except Exception: failed += 1; print(f'FAIL {fn.__name__}'); traceback.print_exc()
    print(f'\n{len(fns)-failed}/{len(fns)} passed'); sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/scraper/test_local_browser_block.py 2>&1 | grep -v 'could not parse'`
Expected: FAIL — `_is_block` is currently a `@staticmethod` ignoring instance markers (custom-marker tests fail).

- [ ] **Step 3: Implement — make block markers per-instance**

In `local_browser.py` `__init__`, add a parameter and store it:

```python
        block_markers: tuple[str, ...] = BLOCK_MARKERS,
```
(add to the signature, after `reloads`), and in the body:
```python
        self.block_markers = block_markers
```

Change `_is_block` from a staticmethod to an instance method:
```python
    def _is_block(self, html: str) -> bool:
        return any(m in html for m in self.block_markers)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/scraper/test_local_browser_block.py 2>&1 | grep -v 'could not parse'`
Expected: `3/3 passed`

- [ ] **Step 5: Confirm existing TripAdvisor seeder still imports cleanly**

Run: `.venv/Scripts/python.exe -m py_compile tools/scraper/shared/local_browser.py tools/scraper/seed_tripadvisor_cities.py && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add tools/scraper/shared/local_browser.py tests/scraper/test_local_browser_block.py
git commit -m "refactor(scraper): make LocalBrowserFetcher block markers per-instance"
```

---

### Task 2: Yelp search-card parser

Parse a Yelp `/search` results HTML into business dicts. Backbone (verified working in the probe): each result links to `/biz/<slug>` with the visible name. Rating + review_count come from the card; the parser walks from each `/biz/` anchor up to its enclosing card container and reads the rating aria-label and review-count text. Validated against a captured real fixture.

**Files:**
- Create: `tools/scraper/data/../` fixture at `tests/scraper/fixtures/yelp_search_sf.html` (captured in Step 1)
- Modify: `tools/scraper/platforms/yelp.py` (add `_parse_yelp_search_cards`)
- Test: `tests/scraper/test_yelp_search_parser.py` (create)

**Interfaces:**
- Produces: `_parse_yelp_search_cards(html: str) -> list[dict]` returning Fusion-shaped dicts:
  `{'name': str, 'url': str, 'rating': float|None, 'review_count': int, 'phone': None, 'location': {'display_address': []}, 'id': None}`
  (`url` is the absolute `https://www.yelp.com/biz/<slug>`; shape matches what the Fusion `businesses[]` entries expose so the existing loop at `yelp.py:498-528` consumes both identically.)

- [ ] **Step 1: Capture a real fixture (one-time, headed browser)**

Run:
```bash
.venv/Scripts/python.exe -c "
import time, undetected_chromedriver as uc
opts=uc.ChromeOptions(); [opts.add_argument(a) for a in ('--window-size=1366,900','--no-sandbox','--disable-dev-shm-usage')]
d=uc.Chrome(options=opts, version_main=149, headless=False)
try:
    d.get('https://www.yelp.com/search?find_desc=Restaurants&find_loc=San+Francisco%2C+CA'); time.sleep(9)
    open('tests/scraper/fixtures/yelp_search_sf.html','w',encoding='utf-8').write(d.page_source)
    print('saved', len(d.page_source))
finally:
    try: d.quit()
    except Exception: pass
" 2>&1 | grep -vE 'could not parse|DevTools|WARNING:'
```
Expected: `saved <~1.2M>`. Then open the fixture and confirm the rating/review markup: search for `star rating` (aria-label) and `review` to lock the selectors used in Step 3.

- [ ] **Step 2: Write the failing test**

```python
# tests/scraper/test_yelp_search_parser.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.platforms.yelp import _parse_yelp_search_cards

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'yelp_search_sf.html')

def _load():
    with open(FIXTURE, encoding='utf-8') as f:
        return _parse_yelp_search_cards(f.read())

def test_extracts_many_businesses():
    rows = _load()
    assert len(rows) >= 8                       # a full SF results page

def test_rows_have_name_and_biz_url():
    for r in _load():
        assert r['name'] and isinstance(r['name'], str)
        assert '/biz/' in r['url']

def test_rows_have_numeric_rating_and_reviews():
    rows = _load()
    rated = [r for r in rows if r['rating'] is not None]
    assert len(rated) >= 5                       # most cards expose a rating
    for r in rated:
        assert 1.0 <= r['rating'] <= 5.0
        assert r['review_count'] >= 0

def test_drops_noise_anchors():
    names = {r['name'].lower() for r in _load()}
    assert 'order' not in names and 'menu' not in names

def test_shape_matches_fusion_consumer():
    # Downstream loop reads b.get('location') -> .get('display_address')
    for r in _load():
        assert isinstance(r['location'], dict)
        assert 'display_address' in r['location']

if __name__ == '__main__':
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for fn in fns:
        try: fn(); print(f'PASS {fn.__name__}')
        except Exception: failed += 1; print(f'FAIL {fn.__name__}'); traceback.print_exc()
    print(f'\n{len(fns)-failed}/{len(fns)} passed'); sys.exit(1 if failed else 0)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/scraper/test_yelp_search_parser.py 2>&1 | grep -v 'could not parse'`
Expected: FAIL — `_parse_yelp_search_cards` not defined.

- [ ] **Step 4: Implement the parser**

Add near the other module helpers in `yelp.py` (after imports; `re` and `BeautifulSoup` — add `from bs4 import BeautifulSoup` and `import re` if not already imported):

```python
_BIZ_HREF_RE = re.compile(r'/biz/([a-z0-9\-]+)')
_RATING_RE = re.compile(r'([0-5](?:\.\d)?)\s*star rating', re.I)
_REVIEWS_RE = re.compile(r'([\d,]+)\s+review', re.I)
_NOISE_NAMES = {'order', 'menu', 'more', 'website', 'directions', 'call',
                'see all', 'read more', 'order now', ''}


def _parse_yelp_search_cards(html: str) -> list[dict]:
    """Parse a Yelp /search results page into Fusion-shaped business dicts.

    Backbone: each result is an <a href="/biz/<slug>"> with the visible name.
    Rating + review_count are read from the nearest enclosing card container
    (aria-label "<n> star rating" and "<n> reviews"). Returns the same shape
    the Fusion `businesses[]` entries expose so the existing scrape_listing
    loop consumes browser + fusion results identically.
    """
    soup = BeautifulSoup(html or '', 'lxml')
    out: list[dict] = []
    seen: set[str] = set()
    for a in soup.find_all('a', href=True):
        m = _BIZ_HREF_RE.match(a['href'])
        if not m:
            continue
        slug = m.group(1)
        name = (a.get_text() or '').strip()
        if not name or name.lower() in _NOISE_NAMES or len(name) > 80:
            continue
        if slug in seen:
            continue
        seen.add(slug)

        # Walk up to a card-sized container to scope rating/review lookups.
        card = a
        for _ in range(6):
            if card.parent is None:
                break
            card = card.parent
        blob = card.get_text(' ', strip=True) if card else ''
        # aria-labels live on descendant elements; include them in the search text.
        aria = ' '.join(
            el.get('aria-label', '') for el in (card.find_all(attrs={'aria-label': True}) if card else [])
        )
        hay = f'{aria} {blob}'

        rm = _RATING_RE.search(hay)
        rating = float(rm.group(1)) if rm else None
        vm = _REVIEWS_RE.search(hay)
        review_count = int(vm.group(1).replace(',', '')) if vm else 0

        out.append({
            'name': name,
            'url': f'https://www.yelp.com/biz/{slug}',
            'rating': rating,
            'review_count': review_count,
            'phone': None,
            'location': {'display_address': []},
            'id': None,
        })
    return out
```

- [ ] **Step 5: Run test; if a selector assertion fails, inspect the fixture and adjust the regex/scope**

Run: `.venv/Scripts/python.exe tests/scraper/test_yelp_search_parser.py 2>&1 | grep -v 'could not parse'`
Expected: `5/5 passed`. If `test_rows_have_numeric_rating_and_reviews` fails, grep the fixture for the exact aria-label/review wording and widen `_RATING_RE`/`_REVIEWS_RE` to match, then re-run.

- [ ] **Step 6: Commit**

```bash
git add tools/scraper/platforms/yelp.py tests/scraper/test_yelp_search_parser.py tests/scraper/fixtures/yelp_search_sf.html
git commit -m "feat(scraper): parse Yelp /search result cards into business dicts"
```

---

### Task 3: Browser city-search + `YELP_LISTING_SOURCE` dispatch

Add `_search_city_browser` (paginates one city's `/search` via the fetcher + parser) and wire `scrape_listing` to choose browser vs fusion. The fetcher opens once around the whole city loop so PerimeterX clearance persists.

**Files:**
- Modify: `tools/scraper/platforms/yelp.py`
- Test: `tests/scraper/test_yelp_browser_search.py` (create)

**Interfaces:**
- Consumes: `_parse_yelp_search_cards` (Task 2); `LocalBrowserFetcher` (Task 1, with `block_markers`).
- Produces: `_search_city_browser(fetch_fn, city: str, category: str, max_results: int) -> list[dict]` (Fusion-shaped); `scrape_listing` honoring `YELP_LISTING_SOURCE`.

- [ ] **Step 1: Write the failing test (no network — inject a fake fetch)**

```python
# tests/scraper/test_yelp_browser_search.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.platforms.yelp import _search_city_browser

PAGE = '''<html><body>
<a href="/biz/alpha-cafe-london">Alpha Cafe</a><span aria-label="4.5 star rating"></span> 120 reviews
<a href="/biz/beta-bistro-london">Beta Bistro</a><span aria-label="3.0 star rating"></span> 8 reviews
</body></html>'''

def test_paginates_and_stops_on_empty():
    calls = []
    def fake_fetch(url):
        calls.append(url)
        return PAGE if 'start=0' in url or 'start=' not in url else '<html><body>no results</body></html>'
    rows = _search_city_browser(fake_fetch, 'London', 'restaurants', max_results=50)
    assert len(rows) == 2
    assert rows[0]['url'].endswith('/biz/alpha-cafe-london')
    assert any('find_loc=London' in u for u in calls)

def test_respects_max_results():
    def fake_fetch(url): return PAGE
    rows = _search_city_browser(fake_fetch, 'London', 'restaurants', max_results=1)
    assert len(rows) == 1

if __name__ == '__main__':
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for fn in fns:
        try: fn(); print(f'PASS {fn.__name__}')
        except Exception: failed += 1; print(f'FAIL {fn.__name__}'); traceback.print_exc()
    print(f'\n{len(fns)-failed}/{len(fns)} passed'); sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/scraper/test_yelp_browser_search.py 2>&1 | grep -v 'could not parse'`
Expected: FAIL — `_search_city_browser` not defined.

- [ ] **Step 3: Implement `_search_city_browser`**

Add to `yelp.py` (uses `urllib.parse.quote_plus`; add `from urllib.parse import quote_plus` if absent):

```python
def _search_city_browser(fetch_fn, city: str, category: str, max_results: int) -> list[dict]:
    """Paginate one city's Yelp /search via a browser fetch callable.

    fetch_fn(url) -> html|None (e.g. LocalBrowserFetcher.get). Stops when a page
    yields no new businesses, max_results is hit, or _RESULTS_PER_PAGE not met.
    Returns Fusion-shaped dicts (see _parse_yelp_search_cards).
    """
    out: list[dict] = []
    seen: set[str] = set()
    offset = 0
    while len(out) < max_results:
        url = (
            'https://www.yelp.com/search'
            f'?find_desc={quote_plus(category)}&find_loc={quote_plus(city)}&start={offset}'
        )
        html = fetch_fn(url)
        if not html:
            break
        cards = _parse_yelp_search_cards(html)
        new = [c for c in cards if c['url'] not in seen]
        for c in new:
            seen.add(c['url'])
        out.extend(new)
        if not new or len(cards) < _RESULTS_PER_PAGE:
            break
        offset += _RESULTS_PER_PAGE
    return out[:max_results]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/scraper/test_yelp_browser_search.py 2>&1 | grep -v 'could not parse'`
Expected: `2/2 passed`

- [ ] **Step 5: Wire the dispatch into `scrape_listing`**

In `yelp.py`, add at module top (if absent): `import os` and `from tools.scraper.shared.local_browser import LocalBrowserFetcher, BrowserBlocked`.

Replace the Fusion gate at `scrape_listing` start (lines ~427-436) with source resolution:

```python
        source = os.environ.get('YELP_LISTING_SOURCE', 'browser').strip().lower()
        if source == 'fusion' and not yelp_fusion_enabled():
            print(
                "FAILED:listing|yelp|missing_key|YELP_LISTING_SOURCE=fusion but "
                "YELP_API_KEY is unset/expired. Set YELP_LISTING_SOURCE=browser "
                "(free, owner-local) or restore the Fusion plan.",
                flush=True,
            )
            return []
```

Open the fetcher once around the city loop and dispatch per city. Wrap the existing `for city_idx, city in enumerate(cities):` body so the per-city `businesses = await asyncio.to_thread(search_businesses_paged, ...)` call (lines ~488-494) becomes:

```python
                if source == 'browser':
                    businesses = await asyncio.to_thread(
                        _search_city_browser, fetch_fn, city, category, per_city_cap,
                    )
                else:
                    businesses = await asyncio.to_thread(
                        search_businesses_paged,
                        location=city, categories=category,
                        max_results=per_city_cap, on_page=_on_fusion_page,
                    )
```

Surround the whole `for` loop with fetcher setup/teardown + block handling:

```python
        browser_ctx = (
            LocalBrowserFetcher(
                markers=('/biz/',),
                block_markers=('Access to this page has been denied',),
                min_pace=8.0, max_pace=18.0,
            ) if source == 'browser' else None
        )
        fetch_fn = browser_ctx.__enter__() if browser_ctx else None
        try:
            for city_idx, city in enumerate(cities):
                # ... existing body, with the dispatch from above ...
        except BrowserBlocked as e:
            print(
                f"FAILED:listing|yelp|ip_blocked|PerimeterX hard-blocked the IP "
                f"at {e}. Stopping; {len(results)} businesses collected from "
                f"earlier cities. Wait for cooldown and re-run remaining cities.",
                flush=True,
            )
        finally:
            if browser_ctx:
                browser_ctx.__exit__(None, None, None)
```

(Keep everything from `page_kept = 0` through the per-city progress prints and the `max_results` early-return unchanged inside the loop. The early-return path must also close the browser — change the early `return results` to `results = results[:max_results]; break` so the `finally` runs, then return after the loop.)

- [ ] **Step 6: Verify compile + existing parser tests still pass**

Run: `.venv/Scripts/python.exe -m py_compile tools/scraper/platforms/yelp.py && .venv/Scripts/python.exe tests/scraper/test_yelp_search_parser.py tests/scraper/test_yelp_browser_search.py 2>&1 | grep -v 'could not parse' | tail -4`
Expected: compiles; both suites pass.

- [ ] **Step 7: Commit**

```bash
git add tools/scraper/platforms/yelp.py tests/scraper/test_yelp_browser_search.py
git commit -m "feat(scraper): browser-based Yelp listing behind YELP_LISTING_SOURCE toggle"
```

---

### Task 4: Expand `yelp_country_cities.json` + refresh taxonomy

Add the 11 verified countries (~8–10 major cities each; SG = 1). Then mirror into `platform_countries`.

**Files:**
- Modify: `tools/scraper/data/yelp_country_cities.json`
- Verify: DB `platform_countries` (yelp)

- [ ] **Step 1: Add the countries**

Add these keys to `yelp_country_cities.json` (values are arrays of `"City, Country"` strings Yelp's `find_loc` resolves):

```json
"AT": ["Vienna, Austria","Graz, Austria","Linz, Austria","Salzburg, Austria","Innsbruck, Austria","Klagenfurt, Austria","Villach, Austria","Wels, Austria"],
"NL": ["Amsterdam, Netherlands","Rotterdam, Netherlands","The Hague, Netherlands","Utrecht, Netherlands","Eindhoven, Netherlands","Groningen, Netherlands","Tilburg, Netherlands","Breda, Netherlands"],
"CH": ["Zurich, Switzerland","Geneva, Switzerland","Basel, Switzerland","Lausanne, Switzerland","Bern, Switzerland","Winterthur, Switzerland","Lucerne, Switzerland","St. Gallen, Switzerland"],
"SE": ["Stockholm, Sweden","Gothenburg, Sweden","Malmo, Sweden","Uppsala, Sweden","Vasteras, Sweden","Orebro, Sweden","Linkoping, Sweden","Helsingborg, Sweden"],
"DK": ["Copenhagen, Denmark","Aarhus, Denmark","Odense, Denmark","Aalborg, Denmark","Esbjerg, Denmark","Randers, Denmark","Kolding, Denmark","Horsens, Denmark"],
"PL": ["Warsaw, Poland","Krakow, Poland","Lodz, Poland","Wroclaw, Poland","Poznan, Poland","Gdansk, Poland","Szczecin, Poland","Lublin, Poland"],
"PT": ["Lisbon, Portugal","Porto, Portugal","Braga, Portugal","Coimbra, Portugal","Funchal, Portugal","Faro, Portugal","Aveiro, Portugal","Cascais, Portugal"],
"SG": ["Singapore"],
"TR": ["Istanbul, Turkey","Ankara, Turkey","Izmir, Turkey","Bursa, Turkey","Antalya, Turkey","Adana, Turkey","Gaziantep, Turkey","Konya, Turkey"],
"CZ": ["Prague, Czech Republic","Brno, Czech Republic","Ostrava, Czech Republic","Plzen, Czech Republic","Liberec, Czech Republic","Olomouc, Czech Republic","Hradec Kralove, Czech Republic","Pardubice, Czech Republic"],
"NO": ["Oslo, Norway","Bergen, Norway","Trondheim, Norway","Stavanger, Norway","Drammen, Norway","Fredrikstad, Norway","Kristiansand, Norway","Tromso, Norway"]
```

- [ ] **Step 2: Validate JSON + count**

Run:
```bash
.venv/Scripts/python.exe -c "import json; d=json.load(open('tools/scraper/data/yelp_country_cities.json')); real=[k for k in d if k!='_comment']; print('countries:',len(real)); [print(c, 'MISSING') for c in ['AT','NL','CH','SE','DK','PL','PT','SG','TR','CZ','NO'] if c not in d]"
```
Expected: `countries: 24` and no `MISSING` lines.

- [ ] **Step 3: Refresh taxonomy (free, DB-only)**

Run: `.venv/Scripts/python.exe -m tools.scraper.run --platform yelp --action discover-taxonomy 2>&1 | grep -E 'saving_countries|taxonomy_done'`
Expected: `...saving_countries:24` (or 24).

- [ ] **Step 4: Verify dropdown source**

Run:
```bash
.venv/Scripts/python.exe -c "from tools.db.supabase_client import table; c={x['code'] for x in table('platform_countries').select('code').eq('platform','yelp').execute().data}; print('yelp dropdown:',len(c)); print('missing:',[x for x in ['AT','NL','CH','SE','DK','PL','PT','SG','TR','CZ','NO'] if x not in c] or 'none')" 2>&1 | grep -v 'could not parse'
```
Expected: `yelp dropdown: 24`, `missing: none`.

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/data/yelp_country_cities.json
git commit -m "feat(scraper): add 11 verified Yelp markets (13->24 countries)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (Yelp section + env table), `.env.example`

- [ ] **Step 1: Update CLAUDE.md Yelp constraints**

Replace the "Listing uses Yelp Fusion API — free 5,000 calls/day" bullet with:

```markdown
- **Listing**: Yelp Fusion moved to a PAID plan and the trial has expired (returns `400 TRIAL_EXPIRED`), so listing now defaults to a FREE headed-browser `/search` scraper (`YELP_LISTING_SOURCE=browser`, default). It is **owner-local-only** (headed Chrome + residential IP; cannot run on Cloud Run/EC2). Set `YELP_LISTING_SOURCE=fusion` to use the API again if a paid plan is restored. PerimeterX is aggressive — conservative jittered pacing + hard-block abort (`"Access to this page has been denied"` only; the `perimeterx`/`captcha` SDK strings are on every successful page).
- **Profile enrichment** still uses ScrapingBee `stealth_proxy` on `/biz/<slug>` (75 credits/page) — unchanged.
- Country fan-out via `yelp_country_cities.json` (24 markets as of 2026-06-18).
```

- [ ] **Step 2: Update the env table row**

Change the `YELP_API_KEY` row to note it's now paid/expired, and add a `YELP_LISTING_SOURCE` row (`browser` default). Update value from `unset` to `set (trial expired)`.

- [ ] **Step 3: Document the toggle in `.env.example`**

Add: `YELP_LISTING_SOURCE=browser   # browser (free, owner-local) | fusion (paid API)`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .env.example
git commit -m "docs(scraper): document Yelp browser listing + paid Fusion reality"
```

---

### Task 6: Live smoke test (manual verification)

**Goal:** Prove the browser path returns real, filterable businesses end-to-end on new countries.

- [ ] **Step 1: Scrape one new country, 1 city, via the browser path**

Run:
```bash
YELP_LISTING_SOURCE=browser .venv/Scripts/python.exe -c "
import asyncio
from tools.scraper.platforms import get_platform
p=get_platform('yelp')
r=asyncio.run(p.scrape_listing({'country':'AT','category':'restaurants','min_rating':1.0,'max_rating':5.0,'min_review_count':0,'per_city_cap':10}, max_results=8))
print('results:',len(r))
[print(' -', x['company_name'] if 'company_name' in x else x.get('name'), x.get('rating'), x.get('profile_url')) for x in r[:8]]
" 2>&1 | grep -vE 'could not parse|DevTools|WARNING:'
```
Expected: ≥5 real Austrian businesses with ratings + `/biz/` URLs; no `ip_blocked` FAILED row.

- [ ] **Step 2: Confirm a second country (NL) the same way**

Repeat Step 1 with `'country':'NL'`. Expected: real Amsterdam-area businesses.

- [ ] **Step 3: Confirm enrichment still joins (ScrapingBee, 1 profile)**

Run `enrich_profiles` on the first result's stub (1 `/biz` page, ~75 credits) and confirm `website_url`/`company_name` populate. Expected: enriched dict with a website or a clean `None` (no exception).

- [ ] **Step 4: Final commit (if any doc/data tweaks emerged)**

```bash
git add -A tools/scraper tests/scraper docs/superpowers
git commit -m "test(scraper): live-verify browser Yelp listing on AT/NL"
```

---

## Self-Review

- **Spec coverage:** listing toggle (T3) ✓, browser search path (T3) ✓, card parser (T2) ✓, fetcher Yelp tuning/block markers (T1) ✓, 11-country expansion + taxonomy (T4) ✓, ScrapingBee enrich unchanged (untouched) ✓, owner-local-only doc (T5) ✓, fixture+live tests (T2/T6) ✓.
- **Placeholders:** none — every code step shows code; selectors validated against a captured fixture in T2.
- **Type consistency:** `_parse_yelp_search_cards` returns Fusion-shaped dicts (`url`, `location.display_address`) consumed unchanged by `scrape_listing:498-528`; `_search_city_browser(fetch_fn, city, category, max_results)` and `LocalBrowserFetcher(block_markers=...)` signatures match across tasks.
- **Risk noted in-plan:** T2 Step 5 explicitly handles Yelp DOM drift on rating/review selectors against the fixture.
