"""
Yelp platform plugin — Fusion (listing) + ScrapingBee (profiles).

NETWORK STRATEGY (revised 2026-05-18 after the listing pivot smoke test)

  Yelp's PerimeterX edge rejects direct Playwright on every public
  endpoint (/, /search, /biz/<slug>). ScrapingBee `stealth_proxy`
  bypasses PerimeterX ONLY for /biz/<slug> profile pages; /search
  pages time out 100% of the time at 90s (verified by a local smoke
  test that burned ~5×75=375 ScrapingBee credits with zero successful
  fetches).

  So the listing stage routes through the Yelp Fusion API instead:

    Listing   →  Yelp Fusion API (free, 5000 calls/day, YELP_API_KEY)
    Profile   →  ScrapingBee stealth_proxy (75 credits/page)

  The original Fusion-based plan in the design spec is the correct
  one. An interim pivot to ScrapingBee-end-to-end (commit 4253896)
  shipped without verifying ScrapingBee could reach /search, and was
  reverted in commit <this one>.

COST MODEL

  - Listing: $0. Free tier of Yelp Fusion (5000 calls/day, no card).
    A typical 6-city × 5-page fan-out = ~30 calls.
  - In-process filter: rating range + min_review_count applied BEFORE
    profile enrichment, so ScrapingBee credits are only spent on leads
    that already passed the filter.
  - Profile enrichment: 75 credits per profile (stealth_proxy). For
    a post-filter set of 30-60 leads, that's 2,250-4,500 credits.

  Total typical scrape: 2,250-4,500 ScrapingBee credits + ~30 free
  Fusion calls.

PARSING

  Listing: Fusion responses are clean JSON (name, rating, phone,
  review_count, location.display_address) — no HTML parsing required.

  Profile (`/biz/<slug>`): see _extract_profile_detail. Yelp wraps the
  business website link in /biz_redir?url=...; unwrap and URL-decode
  the `url=` parameter. Phone via tel: link, claim flag via "Claim
  this business" CTA text.

FAILURE MODES

  - YELP_API_KEY missing → scrape_listing emits FAILED:listing|yelp|missing_key
    and returns []. UI sees the failure in scrape_failures.
  - Fusion 429 → emits FAILED + stops paginating; cron will not retry
    a failed commit (see deploy_ec2.sh anti-spam marker), operator
    can re-run after the daily quota resets.
  - SCRAPINGBEE_API_KEY missing during enrich → returns stubs with
    Fusion-only data (name, rating, phone, address), no website/
    screenshot/claim flag.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup

from tools.scraper.platforms.base import (
    BasePlatformScraper,
    FilterField,
    ProgressCallback,
)
from tools.scraper.shared.supabase_storage import (
    supabase_storage_enabled,
    upload_screenshot_bytes,
)
from tools.scraper.shared.yelp_fusion import (
    search_businesses_paged,
    yelp_fusion_enabled,
)
from tools.scraper.shared.scrapingbee import (
    fetch_screenshot_via_scrapingbee,
    fetch_via_scrapingbee,
    scrapingbee_enabled,
)


# Where the country → list-of-cities seed lives.
_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data')
_COUNTRY_CITIES_PATH = os.path.join(_DATA_DIR, 'yelp_country_cities.json')
_CATEGORIES_PATH = os.path.join(_DATA_DIR, 'yelp_categories.json')

# Yelp's search results page is paginated with ?start= offsets in
# increments of 10. We cap pagination per city to keep credit spend
# bounded — operator can override per-scrape via filters.max_pages.
_DEFAULT_MAX_PAGES_PER_CITY = 5
_RESULTS_PER_PAGE = 10

# Domains we never accept as a business "website" (Yelp links these on
# unclaimed pages or as social fallbacks).
_EXCLUDED_DOMAINS = (
    'yelp.com', 'yelp.co.uk', 'yelp.ca', 'yelp.ie', 'yelp.com.au', 'yelp.co.nz',
    'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com',
    'youtube.com', 'tiktok.com', 'pinterest.com',
)

_BIZ_SLUG_RE = re.compile(r'^/biz/[a-z0-9._-]+/?$', re.IGNORECASE)


def _load_country_cities() -> dict[str, list[str]]:
    try:
        with open(_COUNTRY_CITIES_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[yelp] could not load country-cities seed: {e}")
        return {}
    return {k: v for k, v in data.items() if not k.startswith('_') and isinstance(v, list)}


def _load_categories_seed() -> list[dict]:
    """Curated Yelp category seed used by discover_taxonomy when ScrapingBee
    isn't desirable for taxonomy enumeration. Each entry: {slug, display_name,
    parent_slug?}."""
    try:
        with open(_CATEGORIES_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[yelp] could not load categories seed: {e}")
        return []
    if isinstance(data, dict):
        # File may have a `_comment` key + a `categories` list.
        return data.get('categories') or []
    return data if isinstance(data, list) else []


def _strip_query(url: str) -> str:
    return url.split('?', 1)[0].split('#', 1)[0]


def _unwrap_biz_redir(href: str) -> Optional[str]:
    """
    Yelp wraps every external link in:
        https://www.yelp.com/biz_redir?url=<URL-encoded target>&cachebuster=...
    Return the decoded target, or the input if it's not a biz_redir, or
    None if the URL points at a domain we exclude (social, yelp itself).
    """
    if not href:
        return None
    if 'biz_redir' in href:
        try:
            parsed = urllib.parse.urlparse(href)
            qs = urllib.parse.parse_qs(parsed.query)
            urls = qs.get('url') or []
            if not urls:
                return None
            target = urllib.parse.unquote(urls[0])
        except (ValueError, IndexError):
            return None
    else:
        target = href

    if not target.startswith('http'):
        return None
    lower = target.lower()
    if any(d in lower for d in _EXCLUDED_DOMAINS):
        return None
    return target.rstrip('/')


def _build_search_url(category: str, city: str, start: int) -> str:
    """Compose the public Yelp search URL the same way the UI does."""
    qs = urllib.parse.urlencode({
        'find_desc': category,
        'find_loc': city,
        'start': start,
    })
    return f'https://www.yelp.com/search?{qs}'


def _extract_search_cards(html: str) -> list[dict]:
    """
    Parse a /search results page and return business stubs.

    Yelp wraps each result in <li> (sometimes <div role="listitem">).
    Inside the card boundary we find:
      • The /biz/<slug> anchor(s) — name link, rating link, review-count
        link all share the same href. Pick the name (non-empty text,
        not a bare digit, not a "N reviews" link).
      • Rating via `[aria-label*="star rating"]` (Yelp ships a 0.5-step
        decimal like "4.5 star rating").
      • Review count via plain text "N reviews" anywhere in the card.

    Honoring the card boundary is critical — without it the ancestor
    walk picks up the rating of an adjacent card and assigns it to a
    rating-less business. The boundary is the nearest `<li>` /
    `[role="listitem"]` ancestor.

    Defensive: Yelp redesigns the search UI semi-regularly. We dedupe
    by profile_url so a card with no rating still emits a stub (the
    in-process filter in scrape_listing drops it before enrichment).
    """
    soup = BeautifulSoup(html, 'lxml')
    seen_urls: set[str] = set()
    cards: list[dict] = []

    # Card containers — Yelp's listing has used both shapes across
    # redesigns. Iterate <li> first, then any [role="listitem"]
    # not already seen (parents inside an <li> won't double-count).
    containers: list = list(soup.find_all('li'))
    seen_container_ids = {id(c) for c in containers}
    for el in soup.select('[role="listitem"]'):
        if id(el) in seen_container_ids:
            continue
        seen_container_ids.add(id(el))
        containers.append(el)

    for card in containers:
        # Collect biz anchors in this card; skip biz_redir (those are
        # profile-side external links, not search-result entries).
        biz_anchors = [
            a for a in card.select('a[href^="/biz/"]')
            if 'biz_redir' not in (a.get('href') or '')
        ]
        if not biz_anchors:
            continue

        # Resolve the slug path — all biz anchors in one card point at
        # the same business, modulo query params (?hrid=, ?ad_business_id=).
        slug_path: Optional[str] = None
        for a in biz_anchors:
            href = (a.get('href') or '').split('?', 1)[0].split('#', 1)[0].rstrip('/')
            if _BIZ_SLUG_RE.match(href):
                slug_path = href
                break
        if not slug_path:
            continue

        profile_url = f'https://www.yelp.com{slug_path}'
        if profile_url in seen_urls:
            continue

        # Pick the name anchor — anchor text must be non-empty, not a
        # bare digit, and not a "N review(s)" link.
        name: Optional[str] = None
        for a in biz_anchors:
            text = (a.get_text() or '').strip()
            if not text or text.isdigit() or len(text) > 200:
                continue
            if re.search(r'\b\d+\s+reviews?\b', text, re.IGNORECASE):
                continue
            name = text
            break
        if not name:
            continue
        # Strip search-result rank prefixes ("1. Acme Plumbing")
        name = re.sub(r'^\d{1,3}\.\s+', '', name)

        # Rating: aria-label="X.X star rating" anywhere within the card
        rating: Optional[float] = None
        rating_el = card.select_one('[aria-label*="star rating"]')
        if rating_el is not None:
            m = re.search(r'(\d+(?:\.\d+)?)\s*star', rating_el.get('aria-label') or '')
            if m:
                try:
                    rating = float(m.group(1))
                except ValueError:
                    pass

        # Review count: first "N review(s)" hit in card text
        review_count: Optional[int] = None
        card_text = card.get_text(' ', strip=True)
        m = re.search(r'\b(\d{1,6})\s+reviews?\b', card_text)
        if m:
            try:
                review_count = int(m.group(1))
            except ValueError:
                pass

        seen_urls.add(profile_url)
        cards.append({
            'name': name,
            'profile_url': profile_url,
            'rating': rating,
            'review_count': review_count,
        })

    return cards


def _extract_profile_detail(html: str) -> dict:
    """
    Parse a /biz/<slug> page. Yelp's modern SSR HTML uses dynamic class
    names so we lean on stable signals:
      • <a href="/biz_redir?url=..."> for the business website
      • <a href="tel:..."> for phone (profile-authoritative)
      • A 'Claim this business' string for the claimed flag (un-claimed
        listings convert better in cold outreach).
      • JSON-LD <script type="application/ld+json"> for fallback name/phone.

    Returns dict with optional keys: company_name, website_url, phone, profile_claimed.
    """
    out: dict = {
        'company_name': None,
        'website_url': None,
        'phone': None,
        'profile_claimed': None,
    }
    soup = BeautifulSoup(html, 'lxml')

    # Website URL via biz_redir
    for a in soup.select('a[href*="biz_redir"]'):
        candidate = _unwrap_biz_redir(a.get('href') or '')
        if candidate:
            out['website_url'] = candidate
            break

    # Phone via tel: link
    tel = soup.select_one('a[href^="tel:"]')
    if tel is not None:
        href = tel.get('href') or ''
        if href.startswith('tel:'):
            phone = href[len('tel:'):].strip()
            if phone:
                out['phone'] = phone

    # Claimed flag — "Claim this business" CTA means UNclaimed
    page_text = soup.get_text(' ', strip=True).lower()
    if 'claim this business' in page_text:
        out['profile_claimed'] = False
    elif 'verified license' in page_text or 'claimed' in page_text:
        out['profile_claimed'] = True

    # JSON-LD fallback for name/phone
    for s in soup.find_all('script', type='application/ld+json'):
        if not s.string:
            continue
        try:
            parsed = json.loads(s.string)
        except json.JSONDecodeError:
            continue
        items = parsed if isinstance(parsed, list) else [parsed]
        for item in items:
            if not isinstance(item, dict):
                continue
            if out['company_name'] is None and isinstance(item.get('name'), str):
                out['company_name'] = item['name'].strip() or None
            if out['phone'] is None and isinstance(item.get('telephone'), str):
                tel = item['telephone'].strip()
                if tel:
                    out['phone'] = tel

    # Last-resort name from <h1>
    if not out['company_name']:
        h1 = soup.find('h1')
        if h1:
            txt = (h1.get_text() or '').strip()
            if txt:
                out['company_name'] = txt

    return out


class YelpScraper(BasePlatformScraper):
    name = 'yelp'
    base_url = 'https://www.yelp.com'
    requires_proxy = True

    filter_schema: list[FilterField] = [
        {
            'name': 'country',
            'type': 'select',
            'label': 'Country',
            'required': True,
            'options_source': 'taxonomy:countries',
        },
        {
            'name': 'category',
            'type': 'select',
            'label': 'Category',
            'required': True,
            'options_source': 'taxonomy:categories',
        },
        {
            'name': 'max_rating',
            'type': 'number',
            'label': 'Max rating',
            'required': False,
            'default': 3.5,
            'min': 1.0,
            'max': 5.0,
            'step': 0.5,
        },
        {
            'name': 'min_rating',
            'type': 'number',
            'label': 'Min rating',
            'required': False,
            'default': 1.0,
            'min': 1.0,
            'max': 5.0,
            'step': 0.5,
        },
        # Default lowered from 5 to 1 after 2026-05-19 incident: a BR
        # roofing scrape found 337 businesses in Fusion but kept 0 because
        # every result had <5 reviews. Yelp coverage outside US/UK is
        # sparse — the typical BR/MX/JP listing has 0-1 reviews. Operator
        # can still raise the bar in the UI.
        {
            'name': 'min_review_count',
            'type': 'number',
            'label': 'Min review count',
            'required': False,
            'default': 1,
            'min': 1,
            'max': 1000,
            'step': 1,
        },
    ]

    async def scrape_listing(
        self,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        # Listing routes through Yelp Fusion (free 5000/day) because
        # ScrapingBee can't reach /search. See module docstring.
        if not yelp_fusion_enabled():
            print(
                "FAILED:listing|yelp|missing_key|YELP_API_KEY is not set; "
                "Yelp listing requires the free Fusion API. Register at "
                "https://docs.developer.yelp.com/ (no card required).",
                flush=True,
            )
            return []

        country = str(filters.get('country') or '').upper()
        category = str(filters.get('category') or '').strip()
        if not country or not category:
            print(
                f"FAILED:listing|yelp|invalid_filters|country='{country}' "
                f"category='{category}' (both required)",
                flush=True,
            )
            return []

        min_rating = float(filters.get('min_rating', 1.0))
        max_rating = float(filters.get('max_rating', 3.5))
        min_review_count = int(filters.get('min_review_count', 5))
        per_city_cap = int(filters.get('per_city_cap', 240))

        country_cities = _load_country_cities()
        cities = country_cities.get(country) or []
        if not cities:
            print(
                f"FAILED:listing|yelp|no_seed_cities|country='{country}' "
                f"is not in tools/scraper/data/yelp_country_cities.json",
                flush=True,
            )
            return []

        results: list[dict] = []
        seen_urls: set[str] = set()
        global_page = 0  # SSE event counter — frontend's "page N" label
        total_seen_pre_filter = 0  # counts every Fusion result, for diagnostics

        for city_idx, city in enumerate(cities):
            global_page += 1
            print(
                f"  [city {city_idx + 1}/{len(cities)}] {city}: querying Fusion...",
                flush=True,
            )
            # Emit "we're looking at page N" the moment we START fetching.
            print(f"PROGRESS:category_progress:{global_page}:{len(results)}", flush=True)

            # on_page callback: called by search_businesses_paged after each
            # Fusion call. We use it to emit progress for sub-pages within
            # a city's pagination (every 50 results).
            sub_seen_so_far = [0]

            def _on_fusion_page(seen: int, total_cap: int) -> None:
                # `seen` = how many businesses Fusion returned for this city so far
                # We don't increment global_page within a city — Fusion is fast,
                # so the per-city granularity is good enough for the UI.
                sub_seen_so_far[0] = seen

            businesses = await asyncio.to_thread(
                search_businesses_paged,
                location=city,
                categories=category,
                max_results=per_city_cap,
                on_page=_on_fusion_page,
            )

            page_kept = 0
            total_seen_pre_filter += len(businesses)
            for b in businesses:
                rating = b.get('rating')
                review_count = int(b.get('review_count') or 0)
                if rating is None:
                    continue
                rating_f = float(rating)
                if not (min_rating <= rating_f <= max_rating):
                    continue
                if review_count < min_review_count:
                    continue
                profile_url = _strip_query(b.get('url') or '')
                if not profile_url or profile_url in seen_urls:
                    continue
                seen_urls.add(profile_url)

                location_obj = b.get('location') or {}
                display_address = location_obj.get('display_address') or []

                results.append({
                    'name': b.get('name') or '',
                    'profile_url': profile_url,
                    'rating': rating_f,
                    'review_count': review_count,
                    'phone': b.get('phone') or None,
                    'address': ', '.join(display_address) if display_address else None,
                    'fusion_id': b.get('id'),
                    'platform': self.name,
                    'country': country,
                    'category': category,
                    'city': city,
                })
                page_kept += 1

            print(
                f"  {city}: Fusion returned {len(businesses)} businesses, "
                f"{page_kept} matched filter (rating {min_rating}-{max_rating}, "
                f"min_reviews {min_review_count})",
                flush=True,
            )
            # category_page_done shape: {page}|{kept_on_page}|{total}
            # — matches TripAdvisor / Trustpilot so the frontend's
            # JobProgress.summarize() picks up companiesFound.
            print(
                f"PROGRESS:category_page_done:{global_page}|{page_kept}|{len(results)}",
                flush=True,
            )
            if on_progress:
                on_progress({
                    'stage': 'listing',
                    'city': city,
                    'found': len(results),
                    'page_found': page_kept,
                })

            if max_results is not None and len(results) >= max_results:
                results = results[:max_results]
                print(f"PROGRESS:category_done:{len(results)}", flush=True)
                return results

        print(f"\nTotal: {len(results)} Yelp businesses matched filter.", flush=True)
        # Diagnostic for the "Fusion returned data but everything got filtered
        # out" case. Common in low-coverage markets (BR/MX/JP) where most
        # listings have rating=0 or rating=5.0 with <5 reviews. Without this
        # event the operator sees "completed, 0 found" and can't tell whether
        # Yelp had no data or the filter was too strict. Surfaced as a
        # FAILED row so it shows up in the per-job Failures pane.
        if total_seen_pre_filter > 0 and not results:
            print(
                f"FAILED:listing|yelp|filter_too_strict|"
                f"Fusion returned {total_seen_pre_filter} businesses for "
                f"{country}/{category} but 0 passed the filter "
                f"(rating {min_rating}-{max_rating}, min_reviews "
                f"{min_review_count}). Try widening max_rating to 5.0 and "
                f"lowering min_review_count — Yelp coverage in {country} "
                f"is thin and most listings have <5 reviews.",
                flush=True,
            )
        print(f"PROGRESS:category_done:{len(results)}", flush=True)
        return results

    async def enrich_profiles(
        self,
        profile_stubs: list[dict],
        *,
        screenshots_dir: str = '',
        parallel_tabs: int = 3,
        output_path: str = '',
        flush_every: int = 25,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        if not profile_stubs:
            return []
        if not scrapingbee_enabled():
            print(
                "FAILED:enrich|yelp|missing_key|SCRAPINGBEE_API_KEY is not set; "
                "returning stubs without website/phone/screenshot.",
                flush=True,
            )
            return [{**s, 'platform': self.name} for s in profile_stubs]

        del output_path, flush_every  # not needed — Yelp profiles are stateless HTTP fetches

        total = len(profile_stubs)
        if screenshots_dir:
            os.makedirs(screenshots_dir, exist_ok=True)

        sem = asyncio.Semaphore(max(1, parallel_tabs))
        results: dict[int, dict] = {}

        async def _one(idx: int, stub: dict) -> None:
            async with sem:
                profile_url = stub.get('profile_url') or ''
                if not profile_url:
                    results[idx] = {**stub, 'platform': self.name}
                    return

                slug = profile_url.rsplit('/', 1)[-1]
                slug_for_file = re.sub(r'[^A-Za-z0-9._-]', '_', slug)[:120]
                print(f"  [{idx + 1}/{total}] {profile_url}", flush=True)
                print(
                    f"PROGRESS:profile_start:{idx + 1}|{total}|{slug_for_file}",
                    flush=True,
                )

                html = await asyncio.to_thread(
                    fetch_via_scrapingbee,
                    profile_url,
                    render_js=True,
                    premium_proxy=False,
                    stealth_proxy=True,
                )
                if not html:
                    print(
                        f"FAILED:profile|{profile_url}|empty_html|"
                        f"ScrapingBee returned no HTML",
                        flush=True,
                    )
                    results[idx] = {**stub, 'platform': self.name}
                    print(f"PROGRESS:profile_progress:{idx + 1}/{total}", flush=True)
                    return

                detail = _extract_profile_detail(html)

                # Screenshot: fetch from ScrapingBee, upload to Supabase
                # Storage directly, and store the resulting PUBLIC URL on the
                # lead. We also keep the local copy on disk (for debugging /
                # the legacy scrape-runner upload step), but the row's
                # screenshot_path is the public URL from this moment on so
                # there's no two-step race with the post-enrich upload.
                screenshot_path = ''
                if screenshots_dir or supabase_storage_enabled():
                    png = await asyncio.to_thread(
                        fetch_screenshot_via_scrapingbee,
                        profile_url,
                        full_page=False,
                        stealth_proxy=True,
                        render_js=True,
                    )
                    if png:
                        # Local copy (best-effort; failure here is fine).
                        if screenshots_dir:
                            try:
                                local_path = os.path.join(
                                    screenshots_dir, f"{slug_for_file}.png",
                                )
                                with open(local_path, 'wb') as f:
                                    f.write(png)
                            except OSError as e:
                                print(
                                    f"    Yelp screenshot disk write failed for "
                                    f"{slug_for_file}: {e}",
                                    flush=True,
                                )
                        # Supabase Storage upload — the canonical path that
                        # ends up in the DB. If this fails, the row gets no
                        # screenshot_path (better than a dead local path).
                        public_url = await asyncio.to_thread(
                            upload_screenshot_bytes,
                            png,
                            f'yelp/{slug_for_file}.png',
                        )
                        if public_url:
                            screenshot_path = public_url
                        else:
                            print(
                                f"    Yelp screenshot upload returned no URL for "
                                f"{slug_for_file}",
                                flush=True,
                            )

                enriched = {**stub, 'platform': self.name}
                # Fusion's stub.name is the canonical business name. The
                # profile-page parser sometimes picks up section headers
                # like "Business Photos" from Yelp's modern SPA markup, so
                # only fall back to parsed name when Fusion didn't give us
                # one (rare — Fusion always returns name).
                stub_name = stub.get('name')
                if stub_name:
                    enriched['company_name'] = stub_name
                elif detail.get('company_name'):
                    enriched['company_name'] = detail['company_name']
                if detail.get('website_url'):
                    enriched['website_url'] = detail['website_url']
                if detail.get('phone'):
                    enriched['phone'] = detail['phone']
                if detail.get('profile_claimed') is not None:
                    enriched['profile_claimed'] = detail['profile_claimed']
                if screenshot_path:
                    enriched['screenshot_path'] = screenshot_path
                results[idx] = enriched

                shot_flag = 'shot' if screenshot_path else 'noshot'
                site_flag = 'site' if detail.get('website_url') else 'nosite'
                print(
                    f"PROGRESS:profile_saved:{idx + 1}|{total}|{slug_for_file}|"
                    f"none|{shot_flag}|{site_flag}",
                    flush=True,
                )
                print(f"PROGRESS:profile_progress:{idx + 1}/{total}", flush=True)

        await asyncio.gather(*(_one(i, s) for i, s in enumerate(profile_stubs)))

        enriched = [results[i] for i in range(total) if i in results]
        print(f"\nEnriched {len(enriched)} Yelp profiles.", flush=True)
        print(f"PROGRESS:profile_done:{len(enriched)}", flush=True)
        return enriched

    async def discover_taxonomy(self) -> dict:
        """
        Populate platform_categories + platform_countries for Yelp from a
        curated seed (no Fusion API). The curated seed lives at
        `tools/scraper/data/yelp_categories.json` and is intentionally
        small — top SMB verticals for cold-outreach. Add entries to that
        file when you want a new vertical.

        Countries come from `yelp_country_cities.json` (same seed used
        for city fan-out at scrape time).
        """
        from datetime import datetime, timezone

        print("PROGRESS:taxonomy_start:yelp", flush=True)

        seed = _load_categories_seed()
        countries_seed = _load_country_cities()

        if not seed:
            print("PROGRESS:taxonomy_error:no_categories_seed", flush=True)
            return {'categories': [], 'countries': []}

        kept = [
            {
                'slug': c.get('slug'),
                'parent_slug': c.get('parent_slug'),
                'display_name': c.get('display_name') or c.get('slug'),
            }
            for c in seed
            if c.get('slug')
        ]
        countries = [{'code': k, 'name': k} for k in sorted(countries_seed.keys())]

        try:
            from tools.db.supabase_client import get_client

            client = get_client()
            now_iso = datetime.now(timezone.utc).isoformat()

            if kept:
                print(f"PROGRESS:taxonomy_saving_categories:{len(kept)}", flush=True)
                rows = [
                    {
                        'platform': self.name,
                        'slug': c['slug'],
                        'parent_slug': c['parent_slug'],
                        'display_name': c['display_name'],
                        'sort_order': i,
                        'last_seen_at': now_iso,
                    }
                    for i, c in enumerate(kept)
                ]
                client.from_('platform_categories').upsert(
                    rows, on_conflict='platform,slug',
                ).execute()

            if countries:
                print(f"PROGRESS:taxonomy_saving_countries:{len(countries)}", flush=True)
                client.from_('platform_countries').upsert(
                    [
                        {
                            'platform': self.name,
                            'code': c['code'],
                            'name': c['name'],
                            'last_seen_at': now_iso,
                        }
                        for c in countries
                    ],
                    on_conflict='platform,code',
                ).execute()
        except Exception as e:  # noqa: BLE001
            print(f"PROGRESS:taxonomy_error:persist_failed|{e}", flush=True)

        # taxonomy-discovery.ts parses PROGRESS:taxonomy_done:<cats>|<ctys>
        print(f"PROGRESS:taxonomy_done:{len(kept)}|{len(countries)}", flush=True)
        return {'categories': kept, 'countries': countries}
