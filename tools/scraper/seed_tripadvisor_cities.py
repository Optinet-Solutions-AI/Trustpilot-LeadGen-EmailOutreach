"""
Offline seeder for tripadvisor_cities.

Walks each country's geographic tree on TripAdvisor and extracts every
linked city: geo_id, slug, display name. UPSERTs into Supabase.

The v1 limitation noted in commit 364aa1d (seeder only walked ~1 level
deep) was resolved by the hybrid 2-pass walk that landed in dae9767.
Big countries (US, FR, IT, DE) now seed at 5–10× the page-1 count.
Re-run per-country once a quarter or whenever the TripAdvisor scrape
shows thin city coverage; the upsert is idempotent.

HYBRID WALK STRATEGY

  TA's `Tourism-g{geo}-{slug}-Vacations.html` page only lists ~30 "Popular
  Destinations" by default — fine for tiny countries, but misses the long
  tail of smaller cities that are often the most interesting cold-outreach
  targets in big countries.

  So the seeder does two passes:

    Pass 1 — fetch the country page; collect all linked Tourism geos.
             For tiny countries (page-1 cities < SHALLOW_THRESHOLD) this is
             the final answer.

    Pass 2 — for non-tiny countries, recurse one level: fetch each candidate
             geo's Tourism page and harvest its sub-cities. This catches
             US states, French régions, Italian provinces, etc., and surfaces
             every city they link to. Stops at depth 1 — we never recurse
             past city-level pages.

  Worst-case cost: ~1 + page1_city_count credits per country. With a
  typical ~30 candidates per big country and 41 countries seeded, the
  one-time spend lands around 600–1,500 SB credits.

Run once per country, or all at once:

    python -m tools.scraper.seed_tripadvisor_cities --country US
    python -m tools.scraper.seed_tripadvisor_cities --all
    python -m tools.scraper.seed_tripadvisor_cities --country US --shallow   # disable pass 2

Idempotent: rerunning preserves any row manually marked active=false (the
`active` column is omitted from the UPSERT payload, so it's only set to
true on INSERT and existing rows keep whatever value they had).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from typing import Callable, Optional

from bs4 import BeautifulSoup

# Allow running as `python tools/scraper/seed_tripadvisor_cities.py`
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from tools.scraper.shared.scrapingbee import (
    fetch_via_scrapingbee_tiered,
    scrapingbee_enabled,
)
from tools.db.supabase_client import table

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'tripadvisor_country_geo.json')

# Cities & regions both appear as Tourism-g{geo}-{slug}-(Vacations|Things_To_Do)
# links in TA's hierarchy. We don't distinguish region from leaf at parse time —
# pass 2 walks every page-1 candidate; leaf city pages just yield no new sub-cities.
CITY_HREF_RE = re.compile(
    r'/Tourism-g(?P<geo>\d+)-(?P<slug>[A-Za-z0-9_]+)-(?:Vacations|Things_To_Do)\.html'
)
SLUG_TO_NAME_RE = re.compile(r'_+')

# Below this number of page-1 cities, skip recursion. Tiny markets where TA
# lists 1–5 destinations have a long tail of basically nothing — recursing
# wastes credits for marginal coverage.
SHALLOW_THRESHOLD = 6


def _load_country_map() -> dict[str, dict]:
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def _tourism_url(geo: str, slug: str) -> str:
    return f"https://www.tripadvisor.com/Tourism-g{geo}-{slug}-Vacations.html"


def _slug_to_name(slug: str) -> str:
    return SLUG_TO_NAME_RE.sub(' ', slug).strip()


def _extract_cities(html: str, exclude_geo: str) -> list[dict]:
    """
    Pull every distinct Tourism-g link out of a TA page. Excludes the geo we
    came from so the page's own self-link doesn't get inserted as a child.

    Returns [{geo_id, slug, name}, ...] dedup'd by geo_id, in DOM order.
    """
    soup = BeautifulSoup(html, 'lxml')
    found: dict[str, dict] = {}
    for a in soup.find_all('a', href=True):
        m = CITY_HREF_RE.search(a['href'])
        if not m:
            continue
        geo = m.group('geo')
        if geo == exclude_geo:
            continue
        slug = m.group('slug')
        anchor_text = (a.get_text() or '').strip()
        name = anchor_text if anchor_text and len(anchor_text) <= 80 else _slug_to_name(slug)
        if geo not in found:
            found[geo] = {'geo_id': geo, 'slug': slug, 'name': name}
    return list(found.values())


# Geo id embedded in a TripAdvisor breadcrumb item URL, e.g.
# ".../Tourism-g190311-Malta-Vacations.html" -> "190311".
BREADCRUMB_GEO_RE = re.compile(r'-g(\d+)')
JSONLD_RE = re.compile(
    r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S | re.I
)


def _breadcrumb_geos(html: str) -> set[str]:
    """
    Return the set of geo ids in a page's JSON-LD BreadcrumbList ancestry.

    TripAdvisor pages embed a `BreadcrumbList` whose items are the geographic
    ancestors of the page (World > Continent > Country > Region > City). The
    current page itself is the last item and carries no URL, so only its
    ANCESTORS contribute geos here — which is exactly what we want for a
    containment check.

    Returns an empty set if no parseable breadcrumb is present (e.g. a
    Cloudflare interstitial), which callers treat as "not in country".
    """
    geos: set[str] = set()
    for block in JSONLD_RE.findall(html or ''):
        try:
            obj = json.loads(block)
        except Exception:
            continue
        for node in (obj if isinstance(obj, list) else [obj]):
            if not isinstance(node, dict) or node.get('@type') != 'BreadcrumbList':
                continue
            for el in node.get('itemListElement', []):
                if not isinstance(el, dict):
                    continue
                item = el.get('item')
                if isinstance(item, dict):
                    url = item.get('@id') or item.get('url')
                elif isinstance(item, str):
                    url = item
                else:
                    url = el.get('@id') if isinstance(el.get('@id'), str) else None
                if not url:
                    continue
                m = BREADCRUMB_GEO_RE.search(url)
                if m:
                    geos.add(m.group(1))
    return geos


def _in_country(page_html: str, country_geo: str) -> bool:
    """
    True iff the target country's geo appears in this page's breadcrumb
    ancestry — i.e. the page is a place WITHIN that country. Cross-promo
    links ("travelers also viewed") and continent up-links fail this test.
    """
    return country_geo in _breadcrumb_geos(page_html)


# A fetch callable: takes a URL, returns page HTML or None. Injected so the
# walk can run over ScrapingBee (paid) or a local headed browser (free).
FetchFn = 'Callable[[str], Optional[str]]'


def _scrapingbee_fetch(url: str) -> Optional[str]:
    return fetch_via_scrapingbee_tiered(url, render_js=True)


def _walk_country(country_geo: str, country_slug: str, shallow: bool,
                  fetch: 'Callable[[str], Optional[str]]') -> list[dict]:
    """
    Two-pass walk producing a deduped list of IN-COUNTRY city dicts.

    Every candidate is verified by fetching its own page and confirming the
    target country's geo appears in its JSON-LD breadcrumb ancestry. This is
    what keeps continent up-links ("Europe") and "travelers also viewed"
    cross-promo links (Paris on a Malta page, etc.) out of the result — they
    don't have the country in their breadcrumb, so they're dropped. Without
    this gate the geo_id-keyed upsert would re-tag shared city rows to the
    wrong country.

    Pass 1: fetch the country page; verify each linked candidate is in-country.
    Pass 2 (skipped when `shallow` or the verified set is tiny): recurse one
            level into each verified candidate and verify its sub-cities too.

    A per-geo HTML cache means each page is fetched at most once even though a
    geo can be linked from several pages.
    """
    cache: dict[str, Optional[str]] = {}

    def fetch_page(geo: str, slug: str) -> Optional[str]:
        if geo not in cache:
            cache[geo] = fetch(_tourism_url(geo, slug))
        return cache[geo]

    url = _tourism_url(country_geo, country_slug)
    print(f"  pass 1: {url}")
    html = fetch(url)
    cache[country_geo] = html
    if not html:
        print("  WARN: empty HTML for country page")
        return []

    # The country page's own breadcrumb is its ancestry (World > Continent >
    # Country). Those are up-links, never children — exclude them outright so
    # we don't recurse into a continent and vacuum up its popular cities.
    ancestry = _breadcrumb_geos(html)
    ancestry.add(country_geo)

    candidates = [
        c for c in _extract_cities(html, country_geo)
        if c['geo_id'] not in ancestry
    ]
    print(f"  pass 1: {len(candidates)} candidates "
          f"(excluded {len(ancestry) - 1} ancestor up-link(s))")

    kept: dict[str, dict] = {}
    verified_pages: list[tuple[dict, str]] = []
    dropped = 0
    for idx, cand in enumerate(candidates, start=1):
        page = fetch_page(cand['geo_id'], cand['slug'])
        if page and _in_country(page, country_geo):
            kept[cand['geo_id']] = cand
            verified_pages.append((cand, page))
        else:
            dropped += 1
    print(f"  pass 1: kept {len(kept)} in-country, dropped {dropped} out-of-country")

    if not kept:
        # City-territories (Hong Kong) have no child country-geos, and some
        # country pages don't render their destination module as anchors. In
        # both cases seed the country geo itself so the scraper can still fan
        # out to the country-level hotels listing rather than getting nothing.
        print("  no in-country children — seeding the country geo itself")
        return [{
            'geo_id': country_geo,
            'slug': country_slug,
            'name': _slug_to_name(country_slug),
        }]

    if shallow or len(kept) < SHALLOW_THRESHOLD:
        print('  pass 2: skipped (--shallow)' if shallow
              else f'  pass 2: skipped (pass 1 kept {len(kept)} < {SHALLOW_THRESHOLD})')
        return list(kept.values())

    # Pass 2: recurse one level into each verified candidate, verifying every
    # harvested sub-city the same way. Regions yield real sub-cities; leaf
    # cities mostly yield cross-promo, which the containment check discards.
    page2_added = 0
    for idx, (cand, cand_html) in enumerate(verified_pages, start=1):
        new_here = 0
        for sc in _extract_cities(cand_html, exclude_geo=cand['geo_id']):
            if sc['geo_id'] in ancestry or sc['geo_id'] in kept:
                continue
            page = fetch_page(sc['geo_id'], sc['slug'])
            if page and _in_country(page, country_geo):
                kept[sc['geo_id']] = sc
                new_here += 1
                page2_added += 1
        print(f"    [{idx}/{len(verified_pages)}] {cand['name']}: +{new_here} in-country")

    print(f"  pass 2: added {page2_added} new cities (total {len(kept)})")
    return list(kept.values())


def seed_country(country_code: str, country_geo: str, country_slug: str, shallow: bool,
                 fetch: 'Callable[[str], Optional[str]]') -> int:
    print(f"\n[{country_code}] seeding (shallow={shallow})")
    cities = _walk_country(country_geo, country_slug, shallow, fetch)
    if not cities:
        return 0

    # Omit `active` from the payload so manual disables persist on rerun.
    # The column's DEFAULT true applies to brand-new INSERTs only; UPDATEs
    # leave missing columns at their existing value.
    rows = [
        {
            'geo_id':       c['geo_id'],
            'country_code': country_code,
            'name':         c['name'],
            'slug':         c['slug'],
            'rank':         idx,
        }
        for idx, c in enumerate(cities)
    ]

    try:
        res = (
            table('tripadvisor_cities')
            .upsert(rows, on_conflict='geo_id')
            .execute()
        )
        written = len(res.data) if res.data else 0
        print(f"[{country_code}] upserted {written} rows")
        return written
    except Exception as e:
        print(f"[{country_code}] ERROR upserting: {e}")
        return 0


def _resolve_targets(args, geo_map: dict) -> list[tuple[str, dict]]:
    """Resolve the requested countries into [(CC, entry), ...]."""
    if args.all:
        return list(geo_map.items())
    codes: list[str] = []
    if args.countries:
        codes += [c.strip().upper() for c in args.countries.split(',') if c.strip()]
    if args.country:
        codes.append(args.country.upper())
    targets = []
    for cc in codes:
        entry = geo_map.get(cc)
        if not entry:
            print(f"ERROR: country '{cc}' is not in {DATA_PATH}")
            raise SystemExit(2)
        targets.append((cc, entry))
    return targets


def main() -> None:
    p = argparse.ArgumentParser(prog='seed_tripadvisor_cities')
    p.add_argument('--country', help='ISO-2 country code, e.g. US')
    p.add_argument('--countries', help='Comma-separated ISO-2 codes, e.g. MT,CY,HR (one browser session)')
    p.add_argument('--all', action='store_true', help='Seed every country in the geo map')
    p.add_argument('--sleep', type=float, default=8.0,
                   help='Base seconds to pause between countries (jittered +0-50%%)')
    p.add_argument('--shallow', action='store_true', help='Pass 1 only — skip the per-region recursion')
    p.add_argument('--fetcher', choices=['scrapingbee', 'browser'], default='scrapingbee',
                   help="'scrapingbee' (paid, server-safe) or 'browser' "
                        "(free headed Chrome, residential IP only)")
    p.add_argument('--min-pace', type=float, default=5.0,
                   help='Browser fetcher: min seconds between page loads (jitter floor)')
    p.add_argument('--max-pace', type=float, default=12.0,
                   help='Browser fetcher: max seconds between page loads (jitter ceiling)')
    args = p.parse_args()

    geo_map = _load_country_map()
    targets = _resolve_targets(args, geo_map)
    if not targets:
        p.print_help()
        raise SystemExit(1)

    def run(fetch: 'Callable[[str], Optional[str]]') -> None:
        from tools.scraper.shared.local_browser import BrowserBlocked
        total = 0
        done: list[str] = []
        for code, entry in targets:
            try:
                total += seed_country(code, entry['geo'], entry['slug'],
                                      shallow=args.shallow, fetch=fetch)
                done.append(code)
            except BrowserBlocked as e:
                # IP rate-flagged — stop now; hammering a blocked IP only
                # extends the cooldown. Report what completed so a later run
                # can resume the rest.
                print(f"\nBLOCKED by site bot-detection at {e}. Aborting run.")
                print(f"Completed this run: {done or 'none'}")
                remaining = [c for c, _ in targets if c not in done]
                print(f"Still to seed: {remaining}")
                raise SystemExit(3)
            except Exception as e:
                print(f"[{code}] ERROR (skipped): {e}")
            # Jittered inter-country pause so the cadence isn't metronomic.
            time.sleep(args.sleep * random.uniform(1.0, 1.5))
        if len(targets) > 1:
            print(f"\nDONE — total rows upserted: {total} across {len(done)} countries")

    if args.fetcher == 'browser':
        # Free path: one reused headed Chrome session (residential IP).
        from tools.scraper.shared.local_browser import LocalBrowserFetcher
        print('Fetcher: local headed browser (no ScrapingBee credits)')
        with LocalBrowserFetcher(min_pace=args.min_pace, max_pace=args.max_pace) as fetch:
            run(fetch)
        return

    if not scrapingbee_enabled():
        print('ERROR: SCRAPINGBEE_API_KEY is not set — required for the scrapingbee fetcher.')
        raise SystemExit(2)
    print('Fetcher: ScrapingBee (paid)')
    run(_scrapingbee_fetch)


if __name__ == '__main__':
    main()
