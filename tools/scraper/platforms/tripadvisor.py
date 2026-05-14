"""
TripAdvisor platform plugin.

NETWORK STRATEGY

  TripAdvisor fronts every page with Cloudflare + fingerprint detection.
  Playwright from a residential IP gets 403'd reliably (verified during
  Phase 5.5). The only path that works is fetching pages through
  ScrapingBee's stealth_proxy tier — they handle the CF challenge
  server-side and return rendered HTML which we parse with BeautifulSoup.

  Cost: ~75 credits per page (stealth_proxy + render_js). At 1000 free
  credits/month that's ~13 listing-page scrapes including profile
  enrichment. Production volume planning is the operator's concern.

  This plugin therefore does NOT use Playwright at all. The Trustpilot
  plugin continues to use the existing direct-Playwright path because
  Trustpilot's CF stance is lenient enough to allow it.

DOM EXPECTATIONS

  TripAdvisor's HTML changes frequently. Selectors below are based on
  the current SSR markup that ScrapingBee returns. Markers tagged
  `# TODO(tripadvisor):` are the spots most likely to need iteration
  if the markup drifts.

NETWORK FALLBACK

  If SCRAPINGBEE_API_KEY isn't set, every method here returns empty —
  the plugin manifest still loads, but no scraping happens. Operator
  sees that immediately via PROGRESS:profile_done:0 and can set the key.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Iterable, Optional

from bs4 import BeautifulSoup

from tools.scraper.platforms.base import (
    BasePlatformScraper,
    FilterField,
    ProgressCallback,
)
from tools.scraper.shared.scrapingbee import (
    fetch_screenshot_via_scrapingbee,
    fetch_via_scrapingbee_tiered,
    scrapingbee_enabled,
)


# URL templates per listing type. (geo_id, location_slug, offset)
LISTING_URL_TEMPLATES = {
    'hotels':      'https://www.tripadvisor.com/Hotels-g{geo}-{slug}.html',
    'restaurants': 'https://www.tripadvisor.com/Restaurants-g{geo}-{slug}.html',
    'attractions': 'https://www.tripadvisor.com/Attractions-g{geo}-{slug}.html',
}
LISTING_URL_TEMPLATES_PAGED = {
    'hotels':      'https://www.tripadvisor.com/Hotels-g{geo}-oa{offset}-{slug}.html',
    'restaurants': 'https://www.tripadvisor.com/Restaurants-g{geo}-oa{offset}-{slug}.html',
    'attractions': 'https://www.tripadvisor.com/Attractions-g{geo}-oa{offset}-{slug}.html',
}
RESULTS_PER_PAGE = 30


EXCLUDED_DOMAINS = (
    'tripadvisor.com', 'facebook.com', 'twitter.com', 'x.com',
    'instagram.com', 'linkedin.com', 'youtube.com', 'tiktok.com',
    'pinterest.com', 'google.com', 'apple.com', 'microsoft.com',
    'apps.apple.com', 'play.google.com',
)


def _is_external(href: str) -> bool:
    if not href or not href.startswith('http'):
        return False
    lower = href.lower()
    return not any(d in lower for d in EXCLUDED_DOMAINS)


def _parse_bubble_rating(soup_or_element) -> Optional[float]:
    """
    TripAdvisor ships ratings in three forms — try them in order:
      1. `data-automation="bubbleRatingValue"` — element text is the rating
         (this is what TripAdvisor currently ships, verified 2026-05-13)
      2. class="bubble_XX" where XX = rating*10 (legacy 2024-and-earlier)
      3. aria-label="X.X of 5 bubbles" (an even older variant)
    Returns None if no rating signal could be parsed.

    For listing CARDS, the same card has multiple bubbleRatingValue elements
    (one for the venue rating, several for embedded review snippets). The
    caller passes the per-card subtree, and we take the FIRST hit in DOM
    order, which is the venue's own rating.
    """
    # Pattern 1 — current data-automation attribute
    rv = soup_or_element.select_one('[data-automation="bubbleRatingValue"]')
    if rv is not None:
        text = (rv.get_text() or '').strip()
        try:
            return float(text)
        except ValueError:
            pass
    # Pattern 2 — legacy bubble_XX class
    bubble = soup_or_element.select_one('[class*="bubble_"]')
    if bubble is not None:
        cls = ' '.join(bubble.get('class') or [])
        m = re.search(r'bubble_(\d{2,3})', cls)
        if m:
            try:
                return int(m.group(1)) / 10
            except ValueError:
                pass
    # Pattern 3 — aria-label
    for el in soup_or_element.select('[aria-label*="of 5"]'):
        aria = el.get('aria-label') or ''
        m = re.search(r'(\d+(?:\.\d+)?)\s*of 5', aria)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                pass
    return None


def _absolute(href: str) -> str:
    if href.startswith('/'):
        return f"https://www.tripadvisor.com{href}"
    return href


def _strip_query(url: str) -> str:
    return url.split('#', 1)[0].split('?', 1)[0]


def _extract_listing_cards(html: str) -> list[dict]:
    """
    Parse TripAdvisor listing HTML and return profile stubs:
      {name, profile_url, rating}

    Approach (verified against live HTML on 2026-05-13):
      • TripAdvisor wraps each card-title in `[data-automation$="-card-title"]`
        with the variant hotel-card-title / restaurant-card-title /
        attractions-card-title. Their immediate parent <div> is the full card
        (contains title + rating + review snippet).
      • The title div contains the anchor with the profile URL and the name.
      • Rating lives in `[data-automation="bubbleRatingValue"]` somewhere
        inside the same parent — first hit in DOM order is the venue's own
        rating (subsequent hits are embedded review snippets).
    """
    soup = BeautifulSoup(html, 'lxml')

    # Selectors for the card-title element across all three listing types,
    # plus a permissive fallback so the parser survives minor renames.
    title_selectors = (
        '[data-automation="hotel-card-title"]',
        '[data-automation="restaurant-card-title"]',
        '[data-automation="attractions-card-title"]',
        '[data-automation$="-card-title"]',
    )

    title_elements: list = []
    seen_ids: set[int] = set()
    for sel in title_selectors:
        for el in soup.select(sel):
            if id(el) in seen_ids:
                continue
            seen_ids.add(id(el))
            title_elements.append(el)

    out: list[dict] = []
    seen_urls: set[str] = set()

    for title in title_elements:
        # The card is the immediate parent of the title element. If for some
        # reason the title is the document root or detached, skip it.
        card = title.parent or title

        link = title.select_one('a[href]')
        if link is None:
            link = card.select_one(
                'a[href*="-Review-"], a[href*="Hotel_Review"], '
                'a[href*="Restaurant_Review"], a[href*="Attraction_Review"]'
            )
        if link is None:
            continue
        href = link.get('href') or ''
        if not href:
            continue
        profile_url = _strip_query(_absolute(href))
        if profile_url in seen_urls:
            continue

        name = (link.get_text() or '').strip()
        if not name:
            continue
        # TripAdvisor prefixes ranked listings with "1. ", "2. ", etc. (sponsored
        # listings have no prefix). Strip the prefix so the cleaned business
        # name lands in leads.company_name as the operator expects.
        name = re.sub(r'^\d{1,3}\.\s+', '', name)

        rating = _parse_bubble_rating(card)

        seen_urls.add(profile_url)
        out.append({
            'name': name,
            'profile_url': profile_url,
            'rating': rating,
        })

    return out


def _walk_json_ld_entities(html: str) -> Iterable[dict]:
    """
    Yield every Schema.org entity found in the page's JSON-LD scripts.

    TripAdvisor ships profile data in <script type="application/ld+json">
    blocks. Some scripts wrap multiple entities under @graph, others are
    a single object. We handle both shapes.
    """
    soup = BeautifulSoup(html, 'lxml')
    for s in soup.find_all('script', type='application/ld+json'):
        if not s.string:
            continue
        try:
            parsed = json.loads(s.string)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            graph = parsed.get('@graph')
            if isinstance(graph, list):
                for item in graph:
                    if isinstance(item, dict):
                        yield item
            else:
                yield parsed
        elif isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict):
                    yield item


# Schema.org @type values TripAdvisor uses for business profiles.
_BUSINESS_TYPES = {
    'LodgingBusiness', 'Hotel', 'Resort', 'BedAndBreakfast',
    'Restaurant', 'FoodEstablishment',
    'TouristAttraction', 'LocalBusiness', 'Place',
}


def _extract_profile_detail(html: str) -> dict:
    """
    Parse a TripAdvisor profile page. Strategy: read Schema.org JSON-LD first
    (LodgingBusiness / Restaurant / TouristAttraction), fall back to DOM
    selectors for anything missing.

    Schema.org keys we care about (verified against live TripAdvisor 2026-05-13):
      • name             → company_name
      • sameAs           → website_url (canonical official URL — this is the
                           one piece TripAdvisor hides behind /Commerce?p=
                           affiliate redirects in the visible DOM)
      • telephone        → phone
      • aggregateRating.ratingValue → rating

    Falling back to DOM gives us a phone (from tel: href) and rating
    (from bubbleRatingValue) when JSON-LD is absent or partial. Website,
    however, is JSON-LD-only on TripAdvisor — there is no DOM path to the
    real external URL because the visible "Visit website" button always
    points at TripAdvisor's affiliate redirect.
    """
    result: dict = {
        'company_name': None,
        'website_url': None,
        'phone': None,
        'rating': None,
    }

    for entity in _walk_json_ld_entities(html):
        type_field = entity.get('@type')
        types = (
            {type_field} if isinstance(type_field, str)
            else set(type_field) if isinstance(type_field, list)
            else set()
        )
        if not (types & _BUSINESS_TYPES):
            continue
        if result['company_name'] is None and isinstance(entity.get('name'), str):
            result['company_name'] = entity['name'].strip() or None
        # sameAs may be a string or an array. Take the first external URL.
        if result['website_url'] is None:
            same_as = entity.get('sameAs')
            if isinstance(same_as, str):
                if _is_external(same_as):
                    result['website_url'] = same_as.rstrip('/')
            elif isinstance(same_as, list):
                for u in same_as:
                    if isinstance(u, str) and _is_external(u):
                        result['website_url'] = u.rstrip('/')
                        break
        if result['phone'] is None and isinstance(entity.get('telephone'), str):
            tel = entity['telephone'].strip()
            if tel:
                result['phone'] = tel
        if result['rating'] is None:
            agg = entity.get('aggregateRating')
            if isinstance(agg, dict):
                rv = agg.get('ratingValue')
                if isinstance(rv, (int, float)):
                    result['rating'] = float(rv)
                elif isinstance(rv, str):
                    try:
                        result['rating'] = float(rv)
                    except ValueError:
                        pass

    # ── DOM fallbacks for anything JSON-LD didn't supply ──────────────
    if not result['company_name']:
        soup = BeautifulSoup(html, 'lxml')
        h1 = soup.find('h1')
        if h1:
            txt = (h1.get_text() or '').strip()
            if txt:
                result['company_name'] = txt

    if not result['phone']:
        soup = BeautifulSoup(html, 'lxml')
        tel = soup.select_one('a[href^="tel:"]')
        if tel is not None:
            href = tel.get('href') or ''
            if href.startswith('tel:'):
                result['phone'] = href[len('tel:'):].strip() or None

    if result['rating'] is None:
        soup = BeautifulSoup(html, 'lxml')
        result['rating'] = _parse_bubble_rating(soup)

    return result


class TripAdvisorScraper(BasePlatformScraper):
    name = 'tripadvisor'
    base_url = 'https://www.tripadvisor.com'
    requires_proxy = True

    filter_schema: list[FilterField] = [
        {
            'name': 'location_id',
            'type': 'text',
            'label': 'TripAdvisor geo ID',
            'required': True,
        },
        {
            'name': 'location_slug',
            'type': 'text',
            'label': 'Location slug',
            'required': True,
        },
        {
            'name': 'listing_type',
            'type': 'select',
            'label': 'Listing type',
            'required': True,
            'options': [
                {'value': 'hotels',      'label': 'Hotels'},
                {'value': 'restaurants', 'label': 'Restaurants'},
                {'value': 'attractions', 'label': 'Attractions'},
            ],
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
            'name': 'max_rating',
            'type': 'number',
            'label': 'Max rating',
            'required': False,
            'default': 3.0,
            'min': 1.0,
            'max': 5.0,
            'step': 0.5,
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
            print("FAILED:listing|tripadvisor|missing_key|SCRAPINGBEE_API_KEY is not set; TripAdvisor cannot be scraped without it.")
            return []

        listing_type = (filters.get('listing_type') or 'hotels').lower()
        if listing_type not in LISTING_URL_TEMPLATES:
            raise ValueError(
                f"Unknown listing_type '{listing_type}'. Expected one of {list(LISTING_URL_TEMPLATES)}."
            )

        geo = str(filters['location_id'])
        slug = str(filters['location_slug'])
        min_rating = float(filters.get('min_rating', 1.0))
        max_rating = float(filters.get('max_rating', 3.0))
        max_pages = int(filters.get('max_pages', 30))

        results: list[dict] = []

        for page_idx in range(max_pages):
            offset = page_idx * RESULTS_PER_PAGE
            if offset == 0:
                url = LISTING_URL_TEMPLATES[listing_type].format(geo=geo, slug=slug)
            else:
                url = LISTING_URL_TEMPLATES_PAGED[listing_type].format(
                    geo=geo, offset=offset, slug=slug,
                )

            print(f"\n[TA page {page_idx + 1}] {url}")

            # Tiered fetch: premium_proxy (~15 cr) first, stealth_proxy (~75 cr)
            # only if premium gets challenged. ~5x cheaper when premium works.
            html = await asyncio.to_thread(
                fetch_via_scrapingbee_tiered,
                url,
                render_js=True,
            )
            if not html:
                print(f"  ScrapingBee returned no HTML for page {page_idx + 1}. Stopping pagination.")
                break

            cards = _extract_listing_cards(html)
            if not cards:
                print(f"  No cards found on page {page_idx + 1}. Stopping pagination.")
                break

            page_kept = 0
            for c in cards:
                rating = c.get('rating')
                if rating is not None and not (min_rating <= rating <= max_rating):
                    continue
                c['platform'] = self.name
                c['listing_type'] = listing_type
                c['location_id'] = geo
                results.append(c)
                page_kept += 1

            print(f"  Found {len(cards)} cards, {page_kept} matched filter (rating {min_rating}-{max_rating}).")
            print(f"PROGRESS:category_progress:{page_idx + 1}:{len(results)}", flush=True)
            print(f"PROGRESS:category_page_done:{page_idx + 1}|{page_kept}|{len(results)}", flush=True)
            if on_progress:
                on_progress({
                    'stage': 'category',
                    'page': page_idx + 1,
                    'found': len(results),
                    'page_found': page_kept,
                })

            if max_results is not None and len(results) >= max_results:
                results = results[:max_results]
                break

            if len(cards) < RESULTS_PER_PAGE:
                # Last page — TripAdvisor exhausted.
                break

        print(f"\nTotal: {len(results)} TripAdvisor businesses found matching filter.")
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
            print("FAILED:enrich|tripadvisor|missing_key|SCRAPINGBEE_API_KEY is not set; TripAdvisor cannot be enriched.")
            return [{**s} for s in profile_stubs]

        # `output_path` / `flush_every` are honored on Trustpilot's plugin but
        # the SB-based path doesn't have a long-running browser context so the
        # incremental-flush dance isn't worth the complexity here. Suppress
        # unused-arg lint by binding to a temp.
        del output_path, flush_every

        total = len(profile_stubs)
        if screenshots_dir:
            os.makedirs(screenshots_dir, exist_ok=True)

        # Bound concurrency via a semaphore so we don't unleash hundreds of
        # ScrapingBee calls in parallel (their account caps + our credit pool
        # both prefer measured pace). parallel_tabs is the soft cap.
        sem = asyncio.Semaphore(max(1, parallel_tabs))
        results: dict[int, dict] = {}

        async def _one(idx: int, stub: dict) -> None:
            async with sem:
                profile_url = stub.get('profile_url') or ''
                if not profile_url:
                    results[idx] = {**stub}
                    return

                slug_for_file = re.sub(r'[^A-Za-z0-9._-]', '_', profile_url.rsplit('/', 1)[-1])[:120]
                print(f"  [{idx + 1}/{total}] {profile_url}", flush=True)
                print(f"PROGRESS:profile_start:{idx + 1}|{total}|{slug_for_file}", flush=True)

                # Fetch profile HTML — same tiered escalation as the listing.
                html = await asyncio.to_thread(
                    fetch_via_scrapingbee_tiered,
                    profile_url,
                    render_js=True,
                )
                if not html:
                    print(f"FAILED:profile|{profile_url}|empty_page|ScrapingBee returned no HTML", flush=True)
                    results[idx] = {**stub}
                    print(f"PROGRESS:profile_progress:{idx + 1}/{total}", flush=True)
                    return

                detail = _extract_profile_detail(html)

                # Screenshot — separate ScrapingBee call (still free, but uses
                # another stealth_proxy unit). Skip if no screenshots_dir.
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
                            screenshot_path = os.path.join(screenshots_dir, f"{slug_for_file}.png")
                            with open(screenshot_path, 'wb') as f:
                                f.write(png)
                        except OSError as e:
                            print(f"    TA screenshot write failed for {slug_for_file}: {e}")
                            screenshot_path = ''

                enriched = {**stub}
                for key in ('company_name', 'website_url', 'phone'):
                    if detail.get(key):
                        enriched[key] = detail[key]
                if detail.get('rating') is not None:
                    enriched['rating'] = detail['rating']
                if screenshot_path:
                    enriched['screenshot_path'] = screenshot_path
                enriched['platform'] = self.name
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
        print(f"\nEnriched {len(enriched)} TripAdvisor profiles.")
        print(f"PROGRESS:profile_done:{len(enriched)}", flush=True)
        return enriched

    async def discover_taxonomy(self) -> dict:
        # TripAdvisor has no global enumerable taxonomy — geographic, dynamic,
        # and several million locations. The operator enters geo_id directly.
        print("PROGRESS:taxonomy_skip:tripadvisor has no enumerable global taxonomy", flush=True)
        return {'categories': [], 'countries': []}
