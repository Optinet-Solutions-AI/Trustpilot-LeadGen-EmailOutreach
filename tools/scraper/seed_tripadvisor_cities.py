"""
Offline seeder for tripadvisor_cities.

Walks each country's Tourism page on TripAdvisor and extracts every
linked city: geo_id, slug, display name. UPSERTs into Supabase.

Run once per country, or all at once:

    python -m tools.scraper.seed_tripadvisor_cities --country US
    python -m tools.scraper.seed_tripadvisor_cities --all

Cost: ~1-3 ScrapingBee credits per country page. Idempotent: rerunning
preserves any row manually marked active=false (the `active` column is
omitted from the UPSERT payload so it's only set to true on INSERT, and
existing rows keep whatever value they had).
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

# Cities show up as <a href="/Tourism-g{geo}-{slug}-Vacations.html">Display Name</a>
# inside the country page, or as bare profile links from "Popular Destinations".
# We accept both Tourism-g{geo}-{slug}-Vacations and -Things_To_Do variants.
CITY_HREF_RE = re.compile(
    r'/Tourism-g(?P<geo>\d+)-(?P<slug>[A-Za-z0-9_]+)-(?:Vacations|Things_To_Do)\.html'
)
SLUG_TO_NAME_RE = re.compile(r'_+')


def _load_country_map() -> dict[str, dict]:
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def _country_url(geo: str, slug: str) -> str:
    return f"https://www.tripadvisor.com/Tourism-g{geo}-{slug}-Vacations.html"


def _slug_to_name(slug: str) -> str:
    return SLUG_TO_NAME_RE.sub(' ', slug).strip()


def _extract_cities(html: str, country_geo: str) -> list[dict]:
    """
    Pull every distinct city Tourism link out of a country page. Excludes the
    country's own geo so the country page doesn't get inserted as a city.

    Returns [{geo_id, slug, name}, ...] dedup'd by geo_id, in DOM order.
    """
    soup = BeautifulSoup(html, 'lxml')
    found: dict[str, dict] = {}
    for a in soup.find_all('a', href=True):
        m = CITY_HREF_RE.search(a['href'])
        if not m:
            continue
        geo = m.group('geo')
        if geo == country_geo:
            continue
        slug = m.group('slug')
        # Prefer anchor visible text as the display name; fall back to
        # de-underscoring the slug when the anchor is empty or obviously
        # non-name content (e.g. icon-only links).
        anchor_text = (a.get_text() or '').strip()
        name = anchor_text if anchor_text and len(anchor_text) <= 80 else _slug_to_name(slug)
        if geo not in found:
            found[geo] = {'geo_id': geo, 'slug': slug, 'name': name}
    return list(found.values())


def seed_country(country_code: str, country_geo: str, country_slug: str) -> int:
    url = _country_url(country_geo, country_slug)
    print(f"\n[{country_code}] fetching {url}")
    html = fetch_via_scrapingbee_tiered(url, render_js=True)
    if not html:
        print(f"[{country_code}] WARN: empty HTML returned — skipping")
        return 0

    cities = _extract_cities(html, country_geo)
    print(f"[{country_code}] extracted {len(cities)} cities")
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
        seed_country(args.country.upper(), entry['geo'], entry['slug'])
        return

    if args.all:
        total = 0
        for code, entry in geo_map.items():
            written = seed_country(code, entry['geo'], entry['slug'])
            total += written
            time.sleep(args.sleep)
        print(f"\nDONE — total rows upserted: {total}")
        return

    p.print_help()
    raise SystemExit(1)


if __name__ == '__main__':
    main()
