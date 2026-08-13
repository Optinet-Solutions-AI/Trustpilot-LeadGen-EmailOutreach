"""Apify-backed Yelp business discovery — cookieless, no browser, no DataDome.

WHY THIS EXISTS

  Yelp /search is guarded by DataDome. The free path (headed Chrome on a
  residential IP) only runs on the owner's desktop, and the relay path needs a
  human to solve a slider to mint an IP-bound cookie that holds ~10 minutes.
  Neither runs on Cloud Run or the Linux worker, so Yelp jobs from any other
  user sat pending forever.

  An Apify actor does the extraction on their infrastructure and returns JSON
  over plain HTTP, which runs anywhere. It also returns website, phone,
  contact email and claimed status in the SAME response as the listing, which
  collapses what used to be two ScrapingBee fetches per lead.

SHAPE CONTRACT

  map_business() deliberately returns the same "Fusion-shaped" dict that
  _parse_yelp_search_cards in yelp.py produces, so scrape_listing's existing
  rating/review filter loop consumes Apify results unchanged.
  Three extra keys ride along (website_url, website_email, profile_claimed)
  because this source knows them up front.

  NEVER import yelp.py here — yelp.py imports this module, and the reverse
  makes the import circular.
"""
from __future__ import annotations

import os
import re
from typing import Optional

from tools.scraper.shared.apify import ApifyCreditError, run_actor  # noqa: F401

DEFAULT_ACTOR = 'memo23/yelp-scraper'

# Local copy of yelp.py's review-count regex. Duplicated on purpose: importing
# it from yelp.py would make the import cycle described above.
_REVIEWS_RE = re.compile(r'([\d,]+(?:\.\d+)?)\s*(k)?\s*reviews?', re.I)


def parse_review_count(raw: object) -> int:
    """memo23 returns "118 reviews"; epctex returns 118. Normalise to int.

    Returns 0 for anything unparsable — never raises, because one malformed
    row must not abort a whole city.
    """
    if isinstance(raw, bool):
        return 0
    if isinstance(raw, (int, float)):
        return int(raw)
    if not raw:
        return 0
    m = _REVIEWS_RE.search(str(raw))
    if not m:
        return 0
    n = float(m.group(1).replace(',', ''))
    return int(n * 1000) if m.group(2) else int(n)


def parse_claimed(raw: object) -> Optional[bool]:
    """memo23 returns the words "Claimed"/"Unclaimed", not a boolean.

    None means "this actor doesn't report it" — distinct from False
    ("Yelp says nobody has claimed this"), which is the high-intent
    cold-outreach signal we actually want.
    """
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if text == 'claimed':
        return True
    if text == 'unclaimed':
        return False
    return None


def _to_float(raw: object) -> Optional[float]:
    try:
        return float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _address(item: dict) -> list[str]:
    """memo23 gives a flat `fullAddress` string; epctex gives an `address` dict."""
    full = item.get('fullAddress')
    if isinstance(full, str) and full.strip():
        return [full.strip()]
    addr = item.get('address')
    if isinstance(addr, dict):
        parts = [addr.get('addressLine1'), addr.get('city'), addr.get('regionCode')]
        joined = [str(p).strip() for p in parts if p]
        if joined:
            return [', '.join(joined)]
    return []


def map_business(item: dict) -> Optional[dict]:
    """Map one actor dataset item to a Fusion-shaped business dict.

    Returns None (rather than raising) for items missing a url or a name, so a
    single junk row can't take down the city.
    """
    if not isinstance(item, dict):
        return None
    url = str(item.get('url') or '').strip()
    name = str(item.get('title') or '').strip()
    if not url or '/biz/' not in url or not name:
        return None

    return {
        # Fusion-shaped keys — consumed by scrape_listing's existing filter loop
        'name': name,
        'url': url,
        'rating': _to_float(item.get('rating')),
        'review_count': parse_review_count(item.get('reviewCount')),
        'phone': item.get('phoneNumber') or None,
        'location': {'display_address': _address(item)},
        'id': item.get('yelp_biz_id') or item.get('businessId') or None,
        # Extras this source knows up front — see SHAPE CONTRACT above
        'website_url': item.get('website') or item.get('contactWebsite') or None,
        'website_email': item.get('contactEmail') or None,
        'profile_claimed': parse_claimed(item.get('isClaimed')),
    }


_DEFAULT_OVERFETCH = 4
# Sized against the SERVER-side 300s ceiling on run-sync-get-dataset-items,
# not against appetite. Measured 2026-08-13: the actor produced 169 items in
# 324s (~2s/item) and still wasn't finished, so the original 200 could never
# land inside the window — it 408'd, and the abandoned run billed anyway.
# 100 items ≈ 200s leaves real headroom. Overrunning is survivable now that
# a 408 routes to run recovery (see shared/apify.py), but it is never free,
# so the default stays inside the window.
_DEFAULT_MAX_ITEMS = 100
_DEFAULT_CACHE_DAYS = 30
_DEFAULT_MARKETS = 'US'


def _env_int(name: str, default: int) -> int:
    try:
        value = int(str(os.environ.get(name, '')).strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def actor_id() -> str:
    return (os.environ.get('APIFY_YELP_ACTOR') or '').strip() or DEFAULT_ACTOR


def resolve_max_items(per_city_cap: int) -> int:
    """How many businesses to ask the actor for, for one city.

    Yelp offers no ascending-rating sort (searchSortBy is
    ''|rating|review_count, and `rating` is DESCENDING), so the low-rated
    leads we want can only be reached by pulling a wider slice and filtering
    client-side. The ceiling keeps a wide over-fetch from running away with
    spend.
    """
    overfetch = _env_int('YELP_APIFY_OVERFETCH', _DEFAULT_OVERFETCH)
    ceiling = _env_int('YELP_APIFY_MAX_ITEMS', _DEFAULT_MAX_ITEMS)
    return max(1, min(per_city_cap * overfetch, ceiling))


def build_actor_input(city: str, category: str, max_items: int) -> dict:
    """Actor input. `searchSortBy` is deliberately '' (Yelp's Recommended
    order) — it returns a MIXED rating spread, whereas 'rating' returns
    nothing but 5.0s and would starve a max_rating=3.5 run."""
    enrich_emails = (os.environ.get('YELP_APIFY_ENRICH_EMAILS', 'true')
                     .strip().lower() != 'false')
    return {
        'searchTerms': [category],
        'searchLocation': city,
        'searchSortBy': '',
        'maxItems': max_items,
        'fetchBusinessDetails': True,
        'scrapeReviews': False,
        'enrichEmails': enrich_emails,
        'useCachedData': True,
        # This actor's maxCacheAgeDays defaults to UNSET, i.e. cached rows of
        # unbounded age. Pin it so we keep the cache discount without serving
        # arbitrarily stale businesses.
        'maxCacheAgeDays': _env_int('YELP_APIFY_CACHE_DAYS', _DEFAULT_CACHE_DAYS),
    }


def market_allowed(country: str) -> bool:
    """Only markets verified by a live probe are enabled.

    Adding one is a probe plus an env edit, never a code change.
    """
    raw = (os.environ.get('YELP_APIFY_MARKETS') or '').strip() or _DEFAULT_MARKETS
    allowed = {c.strip().upper() for c in raw.split(',') if c.strip()}
    return str(country or '').strip().upper() in allowed


def search_city_apify(city: str, category: str, per_city_cap: int) -> list[dict]:
    """Run the actor for one city and return mapped, Fusion-shaped businesses.

    Raises ApifyCreditError straight through — an out-of-credit account must
    never be reported as an empty market.
    """
    max_items = resolve_max_items(per_city_cap)
    items = run_actor(actor_id(), build_actor_input(city, category, max_items))
    mapped = [map_business(i) for i in (items or [])]
    return [m for m in mapped if m]
