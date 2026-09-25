"""TripAdvisor listings via Apify's `maxcopell/tripadvisor` actor.

WHY THIS REPLACED THE OPENAI PATH

  The OpenAI two-pass source works, but it is expensive in a way that does not
  improve with scale: pass 2 opens each candidate's profile at roughly $0.06,
  paid whether or not the business survives the rating filter. Measured
  2026-09-25 on a live German run: $5.09 for 25 saved leads, $0.204 each, and
  every one of them reached the CRM without an email on the lead row.

  This actor answers the same question in one call and returns what pass 2 was
  being paid to guess at — including the canonical `webUrl`, which the model
  could not be trusted with at all (asked for it directly it fabricated 9 of
  11 as the literal placeholder `dXXXXX`).

  Measured on Cologne, 2026-09-25 — the whole city, 104 hotels, $0.30:

      rated                104/104
      at or under 3.5       15  (14%)
      of those, with email  13  (87%)
      -> $0.020 per usable lead, against $0.204

  A 40-result sample first suggested only 2% qualified. That was the top of
  the ranking, which is by definition the best-rated hotels; the low-rated
  ones sit deeper. Sampling the head of a ranked list to estimate a tail is
  the mistake to avoid here.

WHAT IT RETURNS (verified live)

  name, rating, numberOfReviews, webUrl (TripAdvisor profile), website, email,
  phone, address, category, rankingString, photos.

RATING IS FILTERED LOCALLY

  The actor exposes no rating filter and returns best-ranked first, so the only
  way to reach low-rated businesses is to pull the city and filter here. That
  is the same arrangement the Yelp Apify path uses, for the same reason, and
  it is why the per-lead cost is ~7x the per-result cost.

ENV
    APIFY_API_TOKEN                      required
    TRIPADVISOR_APIFY_ACTOR              default maxcopell~tripadvisor
    TRIPADVISOR_APIFY_MAX_ITEMS          per-city ceiling, default 150
    TRIPADVISOR_APIFY_MAX_ITEMS_PER_JOB  whole-job spend guard, default 600
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Iterable, Optional

from tools.scraper.shared.cost_report import report_apify

ACTOR = os.environ.get('TRIPADVISOR_APIFY_ACTOR', 'maxcopell~tripadvisor')
# Measured on the BRONZE tier that the STARTER plan bills at. The actor's
# `result-scraped` event is tiered, so this is right for this account and
# would need revisiting on a different plan.
USD_PER_ITEM = 0.0029
RUN_SYNC = 'https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?timeout={t}'


class TripAdvisorApifyError(RuntimeError):
    """The actor run failed. Distinct from 'the city has no low-rated hotels'."""


class TripAdvisorApifyCreditError(TripAdvisorApifyError):
    """Out of Apify credit — never report this as an empty market."""


def apify_enabled() -> bool:
    return bool(os.environ.get('APIFY_API_TOKEN', '').strip())


def per_city_cap() -> int:
    return max(1, int(os.environ.get('TRIPADVISOR_APIFY_MAX_ITEMS', '150') or 150))


def job_item_budget() -> int:
    """Billable items one scrape may fetch across every city.

    The per-city cap bounds one call; this bounds the fan-out, and it is the
    only thing standing between a ten-city run and an unbounded bill.
    """
    return max(0, int(os.environ.get('TRIPADVISOR_APIFY_MAX_ITEMS_PER_JOB', '600') or 600))


_LISTING_FLAGS = {
    'hotels': {'includeHotels': True, 'includeRestaurants': False, 'includeAttractions': False},
    'restaurants': {'includeHotels': False, 'includeRestaurants': True, 'includeAttractions': False},
    'attractions': {'includeHotels': False, 'includeRestaurants': False, 'includeAttractions': True},
}


def build_actor_input(city: str, listing_type: str, max_items: int) -> dict:
    flags = _LISTING_FLAGS.get((listing_type or 'hotels').lower(), _LISTING_FLAGS['hotels'])
    return {
        'query': city,
        'maxItemsPerQuery': max_items,
        # Review tags and photos are billed as add-ons and we display neither.
        'includeTags': False,
        'language': 'en',
        'currency': 'EUR',
        **flags,
    }


def _as_float(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = re.search(r'\d+(?:[.,]\d+)?', v)
        if m:
            try:
                return float(m.group(0).replace(',', '.'))
            except ValueError:
                return None
    return None


_TA_PROFILE = re.compile(
    r'^https?://(?:[a-z0-9-]+\.)?tripadvisor\.[a-z.]{2,6}/'
    r'(?:Hotel|Restaurant|Attraction|VacationRental)_Review-g\d+-d\d+-', re.I)


def _clean_phone(raw: Any) -> Optional[str]:
    """A phone number, or None.

    The actor sometimes returns a placeholder where a number should be —
    "OTHER" arrived on a live Cologne row. Written through, that reaches the
    CRM as a callable number and wastes someone's time on the phone.
    """
    if not isinstance(raw, str):
        return None
    v = raw.strip()
    if not v or not sum(c.isdigit() for c in v) >= 6:
        return None
    return v


def map_business(raw: dict, *, city: str, country: str, category: str) -> Optional[dict]:
    """One actor row as a listing stub, or None if it cannot be identified.

    `webUrl` is the dedupe key (`lead_platform_presences(platform, profile_url)`)
    and the one field nothing else can supply, so a row without a usable one is
    dropped rather than given a synthesised URL.
    """
    if not isinstance(raw, dict):
        return None
    url = (raw.get('webUrl') or '').strip()
    name = (raw.get('name') or raw.get('localName') or '').strip()
    if not name or not _TA_PROFILE.match(url):
        return None

    return {
        'name': name,
        'profile_url': url,
        'rating': _as_float(raw.get('rating')),
        'review_count': int(_as_float(raw.get('numberOfReviews')) or 0) or None,
        'website_url': (raw.get('website') or '').strip() or None,
        'platform_email': (raw.get('email') or '').strip() or None,
        'phone': _clean_phone(raw.get('phone')),
        'address': (raw.get('address') or raw.get('localAddress') or '').strip() or None,
        'city': city,
        'country': country,
        'category': category,
        'platform': 'tripadvisor',
        'listing_source': 'apify',
    }


def keep_business(
    stub: dict,
    *,
    max_rating: float,
    min_rating: float,
    min_review_count: int = 0,
    include_unrated: bool = False,
) -> bool:
    """The rating filter, applied here because the actor has none.

    An unrated listing is kept only when asked for: outside the big markets a
    great many carry no rating at all, and silently dropping them is how a
    working market reports zero (the exact failure the Yelp path hit).
    """
    rating = stub.get('rating')
    if rating is None:
        return include_unrated
    if not (min_rating <= rating <= max_rating):
        return False
    if min_review_count and (stub.get('review_count') or 0) < min_review_count:
        return False
    return True


# The runner kills any Python process that prints nothing for 300s ("Watchdog:
# Python process hung ... likely OOM or Playwright freeze"). One actor call is
# a single blocking request that prints nothing at all while it waits, and a
# big city takes longer than that: measured 2026-09-25, Cologne 254s, and a
# live German run lost Hamburg and Munich outright. So say something while
# waiting — the call is not hung, it is working.
_HEARTBEAT_S = 45


def _heartbeat(city: str, stop: threading.Event) -> None:
    waited = 0
    while not stop.wait(_HEARTBEAT_S):
        waited += _HEARTBEAT_S
        print(f"PROGRESS:listing_wait:{city}|{waited}s waiting for the actor", flush=True)


def run_actor(actor_input: dict, *, timeout_s: int = 600) -> list[dict]:
    token = os.environ.get('APIFY_API_TOKEN', '').strip()
    if not token:
        raise TripAdvisorApifyError('APIFY_API_TOKEN is not set')

    req = urllib.request.Request(
        RUN_SYNC.format(actor=ACTOR, t=timeout_s),
        method='POST',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        data=json.dumps(actor_input).encode('utf-8'),
    )
    stop = threading.Event()
    beat = threading.Thread(
        target=_heartbeat, args=(str(actor_input.get('query') or '?'), stop), daemon=True)
    beat.start()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s + 60) as resp:
            body = resp.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        # Out of credit must never look like an empty market — that is the
        # ScrapingBee "completed, 0 found" failure in a different coat.
        if e.code in (402, 403) or 'usage' in detail.lower() or 'credit' in detail.lower():
            raise TripAdvisorApifyCreditError(f'{e.code}: {detail}') from e
        raise TripAdvisorApifyError(f'{e.code}: {detail}') from e
    except Exception as e:
        raise TripAdvisorApifyError(f'{type(e).__name__}: {str(e)[:200]}') from e
    finally:
        stop.set()

    try:
        items = json.loads(body)
    except json.JSONDecodeError as e:
        raise TripAdvisorApifyError(f'unparseable dataset: {str(e)[:120]}') from e
    return [i for i in items if isinstance(i, dict)]


def search_city(
    city: str,
    listing_type: str,
    *,
    country: str,
    max_rating: float,
    min_rating: float = 1.0,
    min_review_count: int = 0,
    include_unrated: bool = False,
    item_budget: Optional[int] = None,
) -> tuple[list[dict], int]:
    """One city. Returns (kept stubs, items actually billed).

    The billed count is returned separately from the kept count because they
    differ by roughly 7x — that gap IS the cost model, and reporting only the
    kept count would understate spend by the same factor.
    """
    cap = per_city_cap()
    if item_budget is not None:
        cap = min(cap, max(0, item_budget))
    if cap <= 0:
        return [], 0

    items = run_actor(build_actor_input(city, listing_type, cap))
    report_apify('tripadvisor', len(items), USD_PER_ITEM)

    kept: list[dict] = []
    for raw in items:
        stub = map_business(raw, city=city, country=country, category=listing_type)
        if stub and keep_business(stub, max_rating=max_rating, min_rating=min_rating,
                                  min_review_count=min_review_count,
                                  include_unrated=include_unrated):
            kept.append(stub)
    return kept, len(items)
