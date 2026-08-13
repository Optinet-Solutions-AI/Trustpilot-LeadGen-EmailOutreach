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

import re
from typing import Optional

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
