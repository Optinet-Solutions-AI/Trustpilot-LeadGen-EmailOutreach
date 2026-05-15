"""
Offline seeder for tripadvisor_cities.

Walks each country's geographic tree on TripAdvisor and extracts every
linked city: geo_id, slug, display name. UPSERTs into Supabase.

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
import re
import sys
import time

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


def _walk_country(country_geo: str, country_slug: str, shallow: bool) -> list[dict]:
    """
    Two-pass walk producing a deduped list of city dicts for one country.

    Pass 1: fetch the country's Tourism page.
    Pass 2 (skipped when `shallow` is True or page-1 returned a tiny set):
            recurse one level into each candidate to harvest sub-cities.
    """
    url = _tourism_url(country_geo, country_slug)
    print(f"  pass 1: {url}")
    html = fetch_via_scrapingbee_tiered(url, render_js=True)
    if not html:
        print(f"  WARN: empty HTML for country page")
        return []

    page1 = _extract_cities(html, country_geo)
    print(f"  pass 1: {len(page1)} candidates")

    if shallow or len(page1) < SHALLOW_THRESHOLD:
        if shallow:
            print('  pass 2: skipped (--shallow)')
        else:
            print(f'  pass 2: skipped (page 1 yielded {len(page1)} < {SHALLOW_THRESHOLD})')
        return page1

    # Pass 2: walk every page-1 candidate one level deep.
    # Cities don't typically link back to more cities, so recursing into a leaf
    # is wasted credit but produces no false positives. Regions yield 30–200
    # more sub-cities each. Net effect: 5–10× the city count for big countries.
    seen: dict[str, dict] = {c['geo_id']: c for c in page1}
    page2_added = 0
    for idx, cand in enumerate(page1, start=1):
        sub_url = _tourism_url(cand['geo_id'], cand['slug'])
        sub_html = fetch_via_scrapingbee_tiered(sub_url, render_js=True)
        if not sub_html:
            print(f"    [{idx}/{len(page1)}] {cand['name']}: empty page, skip")
            continue
        sub_cities = _extract_cities(sub_html, exclude_geo=cand['geo_id'])
        new_here = 0
        for sc in sub_cities:
            if sc['geo_id'] not in seen:
                seen[sc['geo_id']] = sc
                new_here += 1
                page2_added += 1
        print(f"    [{idx}/{len(page1)}] {cand['name']}: +{new_here} new (sub-page had {len(sub_cities)})")

    print(f"  pass 2: added {page2_added} new cities (total {len(seen)})")
    return list(seen.values())


def seed_country(country_code: str, country_geo: str, country_slug: str, shallow: bool) -> int:
    print(f"\n[{country_code}] seeding (shallow={shallow})")
    cities = _walk_country(country_geo, country_slug, shallow)
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


def main() -> None:
    p = argparse.ArgumentParser(prog='seed_tripadvisor_cities')
    p.add_argument('--country', help='ISO-2 country code, e.g. US')
    p.add_argument('--all', action='store_true', help='Seed every country in the geo map')
    p.add_argument('--sleep', type=float, default=1.0, help='Seconds to sleep between countries when --all is set')
    p.add_argument('--shallow', action='store_true', help='Pass 1 only — skip the per-region recursion')
    args = p.parse_args()

    if not scrapingbee_enabled():
        print('ERROR: SCRAPINGBEE_API_KEY is not set — required for the seeder.')
        raise SystemExit(2)

    geo_map = _load_country_map()

    if args.country:
        entry = geo_map.get(args.country.upper())
        if not entry:
            print(f"ERROR: country '{args.country}' is not in {DATA_PATH}")
            raise SystemExit(2)
        seed_country(args.country.upper(), entry['geo'], entry['slug'], shallow=args.shallow)
        return

    if args.all:
        total = 0
        for code, entry in geo_map.items():
            written = seed_country(code, entry['geo'], entry['slug'], shallow=args.shallow)
            total += written
            time.sleep(args.sleep)
        print(f"\nDONE — total rows upserted: {total}")
        return

    p.print_help()
    raise SystemExit(1)


if __name__ == '__main__':
    main()
