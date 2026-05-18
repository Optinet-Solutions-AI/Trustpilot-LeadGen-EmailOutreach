"""
Yelp platform plugin — ScrapingBee-only.

NETWORK STRATEGY

  Yelp's PerimeterX edge rejects direct Playwright on /, /search, and
  /biz/<slug> with 403. Empirical probe data is in
  docs/superpowers/specs/2026-05-15-yelp-platform-design.md (see the
  2026-05-18 addendum for the Fusion-to-ScrapingBee pivot rationale).

  Listing AND enrichment both go through ScrapingBee `stealth_proxy`
  (75 credits/page; `premium_proxy` is rejected with 500). The Fusion
  API is no longer used — the free quota proved too restrictive in
  practice and the operator preferred predictable cost over quota
  anxiety.

  Listing URL pattern (Yelp's public search):
    https://www.yelp.com/search?find_desc=<term>&find_loc=<city>&start=<offset>

  Pages ship ~10 results; we paginate `start=0,10,20,...` up to
  `max_pages` per city. City fan-out comes from the per-country seed
  in `data/yelp_country_cities.json`.

COST MODEL

  - Listing: 75 credits per page × 5-10 pages × N cities per country.
    A 6-city × 5-page fan-out = 30 listing fetches = 2,250 credits.
  - Profile enrichment: 75 credits per profile (after in-process rating
    + review_count filter), screenshots ride free on the same fetch.

  Typical scrape footprint ~3,500-6,000 credits.

PARSING

  Listing card extraction leans on stable signals:
    • <a href="/biz/<slug>"> for the profile link + business name
    • aria-label containing "X star rating" for the rating
    • "N reviews" text near the rating for review_count

  Profile page parsing is unchanged from the Fusion era — see
  `_extract_profile_detail` below.

FAILURE MODES

  - SCRAPINGBEE_API_KEY missing → listing returns [] with FAILED:listing
  - ScrapingBee returns 500 on a page → that page is skipped; pagination
    continues. Repeated 500s usually mean Yelp tightened detection and
    the stealth_proxy pool needs ScrapingBee-side updates.
  - Empty card list on a page → treated as last-page signal; stops
    paginating for that city.
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
        {
            'name': 'min_review_count',
            'type': 'number',
            'label': 'Min review count',
            'required': False,
            'default': 5,
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
        if not scrapingbee_enabled():
            print(
                "FAILED:listing|yelp|missing_key|SCRAPINGBEE_API_KEY is not set; "
                "Yelp listing fetches /search via ScrapingBee stealth_proxy.",
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
        max_pages_per_city = int(filters.get('max_pages', _DEFAULT_MAX_PAGES_PER_CITY))

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

        for city_idx, city in enumerate(cities):
            for page_idx in range(max_pages_per_city):
                offset = page_idx * _RESULTS_PER_PAGE
                url = _build_search_url(category, city, offset)
                print(
                    f"  [city {city_idx + 1}/{len(cities)}] {city} page {page_idx + 1}: {url}",
                    flush=True,
                )

                # Yelp profile + search pages BOTH need stealth_proxy —
                # premium_proxy returns ScrapingBee 500. No tiered escalation.
                html = await asyncio.to_thread(
                    fetch_via_scrapingbee,
                    url,
                    render_js=True,
                    premium_proxy=False,
                    stealth_proxy=True,
                )
                if not html:
                    print(
                        f"FAILED:listing|{url}|empty_html|ScrapingBee returned no HTML",
                        flush=True,
                    )
                    # If the very first page of a city fails, skip remaining
                    # pages of that city to save credits.
                    break

                cards = _extract_search_cards(html)
                if not cards:
                    print(
                        f"  no cards found on page {page_idx + 1}; stopping pagination for {city}",
                        flush=True,
                    )
                    break

                page_kept = 0
                for c in cards:
                    profile_url = c['profile_url']
                    if profile_url in seen_urls:
                        continue
                    rating = c.get('rating')
                    review_count = c.get('review_count') or 0
                    if rating is None:
                        # No rating means too few reviews to display one — skip.
                        continue
                    if not (min_rating <= float(rating) <= max_rating):
                        continue
                    if review_count < min_review_count:
                        continue
                    seen_urls.add(profile_url)
                    results.append({
                        'name': c['name'],
                        'profile_url': profile_url,
                        'rating': float(rating),
                        'review_count': int(review_count),
                        'platform': self.name,
                        'country': country,
                        'category': category,
                        'city': city,
                    })
                    page_kept += 1

                print(
                    f"  page {page_idx + 1}: {len(cards)} cards, {page_kept} matched "
                    f"(rating {min_rating}-{max_rating}, min_reviews {min_review_count})",
                    flush=True,
                )
                print(
                    f"PROGRESS:listing_page:{city_idx + 1}.{page_idx + 1}|{city}|"
                    f"{len(results)}",
                    flush=True,
                )
                if on_progress:
                    on_progress({
                        'stage': 'listing',
                        'city': city,
                        'page': page_idx + 1,
                        'found': len(results),
                        'page_found': page_kept,
                    })

                if max_results is not None and len(results) >= max_results:
                    results = results[:max_results]
                    return results
                if len(cards) < _RESULTS_PER_PAGE:
                    # Yelp returned a short page → no more results for this city.
                    break

        print(f"\nTotal: {len(results)} Yelp businesses matched filter.", flush=True)
        print(f"PROGRESS:listing_done:{len(results)}", flush=True)
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

                screenshot_path = ''
                if screenshots_dir:
                    png = await asyncio.to_thread(
                        fetch_screenshot_via_scrapingbee,
                        profile_url,
                        full_page=False,
                        stealth_proxy=True,
                        render_js=True,
                    )
                    if png:
                        try:
                            screenshot_path = os.path.join(
                                screenshots_dir, f"{slug_for_file}.png",
                            )
                            with open(screenshot_path, 'wb') as f:
                                f.write(png)
                        except OSError as e:
                            print(
                                f"    Yelp screenshot write failed for "
                                f"{slug_for_file}: {e}",
                                flush=True,
                            )
                            screenshot_path = ''

                enriched = {**stub, 'platform': self.name}
                if detail.get('company_name'):
                    enriched['company_name'] = detail['company_name']
                else:
                    enriched.setdefault('company_name', stub.get('name'))
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
