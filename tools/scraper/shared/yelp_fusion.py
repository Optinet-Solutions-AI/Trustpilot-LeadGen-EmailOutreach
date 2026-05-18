"""
Yelp Fusion API client.

Yelp's /search page is unreachable via ScrapingBee stealth_proxy (smoke
tested 2026-05-18 — every request times out at 90s). Profile pages
/biz/<slug> ARE reachable. So Yelp listing flows through Fusion (free,
5000 calls/day) and profile enrichment flows through ScrapingBee.

ENV
    YELP_API_KEY — required. Register at https://docs.developer.yelp.com/
    for a free key. No credit card required for the free tier.

QUOTA
    5000 calls/day. A typical 6-city x 5-page fan-out = 30 calls.
    166 full scrapes/day before the cap.

SEMANTICS
    Returns None on transport / 4xx / quota errors. Caller treats None
    as "couldn't fetch — proceed with empty result" rather than raising.
    Mirrors the same fail-soft pattern shared/scrapingbee.py uses.
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable, Optional

import requests


FUSION_BASE = 'https://api.yelp.com/v3'
FUSION_TIMEOUT_S = 30
FUSION_MAX_LIMIT = 50            # Fusion's per-call max
FUSION_HARD_CAP_PER_QUERY = 240  # Fusion refuses offset >= 240 on /search


def yelp_fusion_enabled() -> bool:
    return bool(os.environ.get('YELP_API_KEY'))


def _auth_headers() -> dict[str, str]:
    key = os.environ.get('YELP_API_KEY')
    if not key:
        raise RuntimeError('YELP_API_KEY not set')
    return {'Authorization': f'Bearer {key}', 'Accept': 'application/json'}


def search_businesses(
    *,
    location: str,
    categories: Optional[str] = None,
    limit: int = FUSION_MAX_LIMIT,
    offset: int = 0,
    sort_by: str = 'best_match',
    extra: Optional[dict[str, Any]] = None,
) -> Optional[dict]:
    """Single GET /v3/businesses/search call. Returns the response dict
    (with 'businesses' and 'total') or None on error."""
    params: dict[str, Any] = {
        'location': location,
        'limit': min(max(limit, 1), FUSION_MAX_LIMIT),
        'offset': max(offset, 0),
        'sort_by': sort_by,
    }
    if categories:
        params['categories'] = categories
    if extra:
        params.update(extra)

    try:
        resp = requests.get(
            f'{FUSION_BASE}/businesses/search',
            headers=_auth_headers(),
            params=params,
            timeout=FUSION_TIMEOUT_S,
        )
    except requests.exceptions.RequestException as e:
        print(f"[yelp_fusion:search] transport error: {e}")
        return None

    if resp.status_code == 429:
        retry_after = resp.headers.get('Retry-After', '0')
        print(f"[yelp_fusion:search] 429 rate-limited (Retry-After={retry_after})")
        return None
    if resp.status_code == 401:
        print("[yelp_fusion:search] 401 - YELP_API_KEY is invalid")
        return None
    if resp.status_code >= 400:
        snippet = resp.text[:300]
        print(f"[yelp_fusion:search] non-2xx {resp.status_code}: {snippet}")
        return None

    try:
        return resp.json()
    except ValueError as e:
        print(f"[yelp_fusion:search] decode error: {e}")
        return None


def search_businesses_paged(
    *,
    location: str,
    categories: Optional[str] = None,
    max_results: int = 240,
    page_size: int = FUSION_MAX_LIMIT,
    on_page: Optional[Callable[[int, int], None]] = None,
    delay_between_calls_s: float = 0.25,
) -> list[dict]:
    """Walk Fusion's pagination up to either max_results or the hard
    240-cap. Returns accumulated `businesses` list (raw Fusion shape).
    `on_page(seen, total_cap)` fires after each successful call so the
    plugin can emit PROGRESS lines."""
    if not yelp_fusion_enabled():
        return []

    cap = min(max(max_results, 1), FUSION_HARD_CAP_PER_QUERY)
    collected: list[dict] = []
    offset = 0
    total_seen: Optional[int] = None

    while offset < cap:
        limit = min(page_size, cap - offset)
        result = search_businesses(
            location=location,
            categories=categories,
            limit=limit,
            offset=offset,
        )
        if result is None:
            break

        businesses = result.get('businesses') or []
        if not businesses:
            break

        collected.extend(businesses)
        total_seen = result.get('total', total_seen)
        if on_page is not None:
            try:
                on_page(offset + len(businesses), min(total_seen or 0, cap))
            except Exception:
                pass

        offset += len(businesses)
        if len(businesses) < limit:
            # Fusion has nothing left for this query.
            break

        if delay_between_calls_s > 0:
            time.sleep(delay_between_calls_s)

    return collected


def list_categories(*, locale: str = 'en_US') -> Optional[list[dict]]:
    """GET /v3/categories. Returns the full Yelp category tree (one call)
    or None on error. Each entry has {alias, title, parent_aliases,
    country_whitelist}."""
    try:
        resp = requests.get(
            f'{FUSION_BASE}/categories',
            headers=_auth_headers(),
            params={'locale': locale},
            timeout=FUSION_TIMEOUT_S,
        )
    except requests.exceptions.RequestException as e:
        print(f"[yelp_fusion:categories] transport error: {e}")
        return None
    if resp.status_code >= 400:
        print(f"[yelp_fusion:categories] non-2xx {resp.status_code}: {resp.text[:300]}")
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    return data.get('categories') or []
