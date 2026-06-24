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
  the current SSR markup that ScrapingBee returns (last verified
  2026-05-13). The parser favors stable signals in this order:
    1. JSON-LD `schema.org/LocalBusiness` (canonical, survives redesigns)
    2. `data-automation="bubbleRatingValue"` for rating
    3. `data-automation$="-card-title"` for listing cards
    4. Last-resort: legacy `class*="bubble_XX"` and `aria-label*="of 5"`
  If a smoke run produces parser failures (FAILED:profile|...|parser_*),
  prefer adding new JSON-LD shapes over more DOM selectors.

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
from tools.scraper.shared.supabase_storage import (
    supabase_storage_enabled,
    upload_screenshot_bytes,
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

    Approach (verified against live HTML on 2026-05-25):
      • Hotels and Restaurants still use the legacy `[data-automation$="-card-title"]`
        wrapper (hotel-card-title / restaurant-card-title).
      • Attractions pages were restructured: titles now use
        [data-automation="cardTitle"] (with cardHeaderTitleLink as the anchor),
        and the Attractions listing primarily surfaces bookable products
        (AttractionProductReview-* URLs) rather than venues. For cold-outreach
        on actual business owners, prefer listing_type=hotels or restaurants
        — Attractions products are mostly third-party tour aggregators with
        no individually reachable operator.
      • Rating lives in `[data-automation="bubbleRatingValue"]` somewhere
        inside the same parent — first hit in DOM order is the venue's own
        rating (subsequent hits are embedded review snippets).
    """
    soup = BeautifulSoup(html, 'lxml')

    # Selectors for the card-title element across all listing types,
    # plus a permissive fallback so the parser survives minor renames.
    title_selectors = (
        '[data-automation="hotel-card-title"]',
        '[data-automation="restaurant-card-title"]',
        '[data-automation="attractions-card-title"]',  # legacy attractions DOM
        '[data-automation="cardTitle"]',               # modern attractions DOM (2026-05)
        '[data-automation="cardHeaderTitleLink"]',     # modern attractions anchor
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

        # If `title` is itself the anchor (cardHeaderTitleLink case), use it directly.
        if title.name == 'a' and title.get('href'):
            link = title
        else:
            link = title.select_one('a[href]')
        if link is None:
            link = card.select_one(
                'a[href*="-Review-"], a[href*="Hotel_Review"], '
                'a[href*="Restaurant_Review"], a[href*="Attraction_Review"], '
                'a[href*="AttractionProductReview"]'
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
        empty_html_pages = 0  # diagnostic counter — see FAILED emit below

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
                # Without this FAILED row, a key-revoked / quota-exhausted
                # state shows up as "completed, 0 found" with NO diagnostic
                # rows in scrape_failures — operator has nowhere to look.
                # Bug discovered 2026-05-19 when a DE/restaurants scrape ran
                # for 6 minutes against a 401 ScrapingBee key and looked
                # like a parser failure.
                print(
                    f"FAILED:listing|tripadvisor|empty_html|"
                    f"ScrapingBee returned no HTML for {url} (page {page_idx + 1}). "
                    f"Usually means SCRAPINGBEE_API_KEY is invalid/exhausted, "
                    f"or the platform served a CAPTCHA-only response.",
                    flush=True,
                )
                empty_html_pages += 1
                print(f"  ScrapingBee returned no HTML for page {page_idx + 1}. Stopping pagination.")
                break

            cards = _extract_listing_cards(html)
            if not cards:
                # ScrapingBee returned HTML but our parser found 0 listings on
                # it. Two common causes: (a) selector drift (TripAdvisor
                # restyled the listing markup and our extractor doesn't match
                # the new DOM), (b) page is actually empty for this city +
                # listing_type combo (rare). Either way, log it so the next
                # debug session has the offending URL + HTML size to inspect.
                # Bug discovered 2026-05-20 when a US/hotels scrape ran with
                # 10 cities × 1 page and emitted zero FAILED rows despite
                # returning 0 leads.
                print(
                    f"FAILED:listing|tripadvisor|no_cards_parsed|"
                    f"{url} returned {len(html)} bytes of HTML but the listing "
                    f"parser matched 0 cards. Either TripAdvisor's DOM drifted "
                    f"(selectors in _extract_listing_cards need updating) or "
                    f"the page is genuinely empty for this geo+listing_type.",
                    flush=True,
                )
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

        # Cap profile enrichment to the top-N highest-quality leads. Each
        # ScrapingBee fetch is ~15-75 credits and ~5-30 seconds; without a
        # cap, a US/hotels scrape that finds 58 listings burns ~870-4,350
        # credits and ~15+ minutes on profile pages, most of which never
        # get used. We rank by rating × log(1 + review_count) — same scoring
        # the Yelp plugin uses. Operator can override via TA_MAX_ENRICH env
        # var (e.g. for exhaustive runs once leads are vetted).
        # Default chosen 2026-05-20 after a US/hotels test scrape (job
        # 15c898c5) found 58 cards in ~4 min then sat in enrichment 10+ min.
        import math
        try:
            max_enrich = max(1, int(os.environ.get('TA_MAX_ENRICH', '25')))
        except ValueError:
            max_enrich = 25

        if len(profile_stubs) > max_enrich:
            def _quality(stub: dict) -> float:
                rating = float(stub.get('rating') or 0.0)
                reviews = int(stub.get('review_count') or 0)
                return rating * math.log1p(reviews)
            ranked = sorted(profile_stubs, key=_quality, reverse=True)
            print(
                f"PROGRESS:enrich_capped:{max_enrich}|{len(profile_stubs)}|"
                f"keeping top {max_enrich} by rating × log(review_count); "
                f"skipping {len(profile_stubs) - max_enrich} long-tail leads",
                flush=True,
            )
            profile_stubs = ranked[:max_enrich]

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

                # Screenshot — fetch from ScrapingBee, upload to Supabase
                # Storage directly, store the public URL on the row. Local
                # copy is best-effort (kept for debugging). This atomic
                # approach replaces the previous two-step path-matching dance
                # that left 4/4 TripAdvisor leads with NULL screenshot_path
                # in production (issue surfaced 2026-05-19).
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
                        if screenshots_dir:
                            try:
                                local_path = os.path.join(screenshots_dir, f"{slug_for_file}.png")
                                with open(local_path, 'wb') as f:
                                    f.write(png)
                            except OSError as e:
                                print(f"    TA screenshot disk write failed for {slug_for_file}: {e}")
                        public_url = await asyncio.to_thread(
                            upload_screenshot_bytes,
                            png,
                            f'tripadvisor/{slug_for_file}.png',
                        )
                        if public_url:
                            screenshot_path = public_url
                        else:
                            print(f"    TA screenshot upload returned no URL for {slug_for_file}")

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
        """
        Populate platform_countries from the seeded `tripadvisor_cities` table.

        TripAdvisor itself has no enumerable global taxonomy (millions of
        locations, no public categories endpoint). But the country dropdown
        in the Scrape UI reads from `platform_countries`, so we mirror the
        list of countries we've actually seeded cities for. Categories are
        hardcoded in the manifest (Hotels / Restaurants / Attractions) so
        the dropdown doesn't need a database entry — but we upsert them
        anyway for consistency with how Trustpilot/Yelp populate their rows.
        """
        from datetime import datetime, timezone

        print("PROGRESS:taxonomy_start:tripadvisor", flush=True)

        try:
            from tools.db.supabase_client import table

            # Distinct country codes from seeded cities (active=true only).
            # PostgREST caps a single read at 1000 rows and tripadvisor_cities
            # now exceeds that — so paginate, or we silently drop the countries
            # whose rows sit past the first page (the most-recently-seeded ones).
            seen_codes: set[str] = set()
            offset, PAGE = 0, 1000
            while True:
                page = (
                    table('tripadvisor_cities')
                    .select('country_code')
                    .eq('active', True)
                    .range(offset, offset + PAGE - 1)
                    .execute()
                )
                rows = page.data or []
                for row in rows:
                    if row.get('country_code'):
                        seen_codes.add(row['country_code'])
                if len(rows) < PAGE:
                    break
                offset += PAGE
            country_codes = sorted(seen_codes)

            if not country_codes:
                print(
                    "PROGRESS:taxonomy_error:no_seeded_cities|run "
                    "tools/scraper/seed_tripadvisor_cities.py first",
                    flush=True,
                )
                return {'categories': [], 'countries': []}

            countries = [
                {'code': cc, 'name': _ISO_COUNTRY_NAMES.get(cc.upper(), cc.upper())}
                for cc in country_codes
            ]
            now_iso = datetime.now(timezone.utc).isoformat()

            # Persist countries
            print(f"PROGRESS:taxonomy_saving_countries:{len(countries)}", flush=True)
            country_rows = [
                {
                    'platform': self.name,
                    'code': c['code'],
                    'name': c['name'],
                    'last_seen_at': now_iso,
                }
                for c in countries
            ]
            (
                table('platform_countries')
                .upsert(country_rows, on_conflict='platform,code')
                .execute()
            )

            # Mirror the hardcoded listing types as categories.
            categories = [
                {'slug': 'hotels',      'display_name': 'Hotels'},
                {'slug': 'restaurants', 'display_name': 'Restaurants'},
                {'slug': 'attractions', 'display_name': 'Attractions'},
            ]
            print(f"PROGRESS:taxonomy_saving_categories:{len(categories)}", flush=True)
            cat_rows = [
                {
                    'platform': self.name,
                    'slug': c['slug'],
                    'parent_slug': None,
                    'display_name': c['display_name'],
                    'sort_order': i,
                    'last_seen_at': now_iso,
                }
                for i, c in enumerate(categories)
            ]
            (
                table('platform_categories')
                .upsert(cat_rows, on_conflict='platform,slug')
                .execute()
            )

            # taxonomy-discovery.ts parses PROGRESS:taxonomy_done:<cats>|<ctys>
            print(
                f"PROGRESS:taxonomy_done:{len(categories)}|{len(countries)}",
                flush=True,
            )
            return {'categories': categories, 'countries': countries}
        except Exception as e:  # noqa: BLE001
            print(f"PROGRESS:taxonomy_error:{e}", flush=True)
            return {'categories': [], 'countries': []}


# ISO-3166-1 alpha-2 → display name. Covers every country code we've seeded
# in tripadvisor_cities + every code listed in yelp_country_cities.json, plus
# a generous tail of additional markets so a future seed-list expansion
# doesn't need a code edit. Unknown codes fall back to the uppercased code.
_ISO_COUNTRY_NAMES = {
    'AE': 'United Arab Emirates', 'AR': 'Argentina', 'AT': 'Austria', 'AU': 'Australia',
    'BE': 'Belgium', 'BG': 'Bulgaria', 'BR': 'Brazil', 'CA': 'Canada', 'CH': 'Switzerland',
    'CL': 'Chile', 'CN': 'China', 'CO': 'Colombia', 'CR': 'Costa Rica', 'CY': 'Cyprus',
    'CZ': 'Czech Republic', 'DE': 'Germany', 'DK': 'Denmark', 'EE': 'Estonia', 'EG': 'Egypt',
    'ES': 'Spain', 'FI': 'Finland', 'FR': 'France', 'GB': 'United Kingdom', 'UK': 'United Kingdom',
    'GR': 'Greece', 'HK': 'Hong Kong', 'HR': 'Croatia', 'HU': 'Hungary', 'ID': 'Indonesia',
    'IE': 'Ireland', 'IL': 'Israel', 'IN': 'India', 'IS': 'Iceland', 'IT': 'Italy',
    'JP': 'Japan', 'KR': 'South Korea', 'LT': 'Lithuania', 'LU': 'Luxembourg', 'LV': 'Latvia',
    'MT': 'Malta', 'MX': 'Mexico', 'MY': 'Malaysia', 'NL': 'Netherlands', 'NO': 'Norway',
    'NZ': 'New Zealand', 'PE': 'Peru', 'PH': 'Philippines', 'PL': 'Poland', 'PT': 'Portugal',
    'RO': 'Romania', 'RU': 'Russia', 'SA': 'Saudi Arabia', 'SE': 'Sweden', 'SG': 'Singapore',
    'SI': 'Slovenia', 'SK': 'Slovakia', 'TH': 'Thailand', 'TR': 'Turkey', 'TW': 'Taiwan',
    'UA': 'Ukraine', 'US': 'United States', 'VN': 'Vietnam', 'ZA': 'South Africa',
    'BH': 'Bahrain', 'DO': 'Dominican Republic', 'JO': 'Jordan', 'MA': 'Morocco',
    'OM': 'Oman', 'QA': 'Qatar',
}
