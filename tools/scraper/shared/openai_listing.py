"""OpenAI web-search listing — a platform-agnostic two-pass discovery path.

WHY THIS EXISTS

  TripAdvisor is fronted by Cloudflare and Yelp by PerimeterX, so neither
  listing page can be fetched directly. Until now that meant ScrapingBee at 75
  credits a page, a Yelp Fusion subscription, or an Apify actor. This is the
  route that needs none of them: OpenAI's hosted web search reads the pages
  from its own infrastructure and returns what it found.

HOW IT WORKS, AND WHY IT IS TWO PASSES

  Pass 1 asks for a whole city's worth of low-rated businesses in ONE call, so
  the per-call search fee is divided across every business it returns.
  Measured 2026-09-24: 27 hotels for $0.088, i.e. $0.0032 each, with 4 of 5
  ratings exactly matching the live page.

  Pass 2 opens each candidate's own profile. It exists for one reason: pass 1
  CANNOT be trusted to give the profile URL. Asked for it directly, the model
  invented 9 of 11 as the literal placeholder
  ".../Hotel_Review-g187371-dXXXXX-Reviews-...". That URL is our dedupe key
  (lead_platform_presences(platform, profile_url)), so a fabricated one would
  create a brand-new duplicate lead on every re-scrape. Pass 2 costs $0.061 a
  business, which is most of the price, and it is not optional.

WHAT MUST BE SCOPED

  Always fan out per CITY. A country-wide ask returns real businesses with the
  wrong city attached — hotels in Kuhfelde and Kuesten both came back labelled
  "Bergen an der". City drives campaign segmentation and outreach language, so
  that is not a cosmetic error.

WHAT IS NEVER TRUSTED

  The rating ceiling is re-applied locally: asked for <= 3.5, the model
  returned 3.8 and 3.6. gpt-4.1-mini ignored the ceiling entirely and is not
  usable for this.

COST

  $0.070 per confirmed lead, measured end to end. That is 4.7x TripAdvisor's
  Terra API and 25x Apify, and it is the price of depending on no scraping
  vendor at all. Every job carries a hard budget (OPENAI_MAX_SPEND_PER_JOB)
  and reports what it spent as it goes.

ENV
    OPENAI_API_KEY            required
    OPENAI_LISTING_MODEL      default gpt-4.1 (mini does NOT obey the filter)
    OPENAI_MAX_SPEND_PER_JOB  default 2.00 USD; <= 0 means unlimited
    OPENAI_LISTING_BATCH      candidates requested per pass-1 call, default 15
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Iterable, Optional

RESPONSES_URL = 'https://api.openai.com/v1/responses'
DEFAULT_MODEL = 'gpt-4.1'
TIMEOUT_S = 300

# USD per token, plus the flat fee for one hosted web_search call. The search
# fee dominates a small call, which is exactly why pass 1 batches.
_PRICES: dict[str, tuple[float, float]] = {
    'gpt-4.1':      (2.00 / 1e6, 8.00 / 1e6),
    'gpt-4.1-mini': (0.40 / 1e6, 1.60 / 1e6),
    'gpt-4o':       (2.50 / 1e6, 10.00 / 1e6),
    'gpt-5':        (1.25 / 1e6, 10.00 / 1e6),
}
_SEARCH_CALL_USD = 0.010
# An unknown model is priced at the dearest known rate. Guessing low would
# under-report spend and walk straight through the budget.
_DEAREST = max(_PRICES.values(), key=lambda p: p[0] + p[1])


class SpendExhausted(RuntimeError):
    """The job has spent its whole budget. Keep what was gathered and stop."""


class PlatformUnreadable(RuntimeError):
    """The site refuses OpenAI's crawler, so no city will ever confirm.

    Raised out of the city loop rather than handled inside it: a platform that
    cannot be read in New York cannot be read in Chicago either, and retrying
    each city in turn just spends the whole budget proving the same thing
    (measured: $1.04 across 15 calls, 0 leads, before this existed).
    """


class SpendGuard:
    """A running total with a ceiling.

    Mirrors the Apify guards (YELP_APIFY_MAX_ITEMS_PER_JOB and friends): the
    only thing standing between a fan-out bug and an unbounded bill.
    """

    def __init__(self, budget_usd: float) -> None:
        self.budget = float(budget_usd or 0.0)
        self.spent = 0.0
        self.calls = 0

    def charge(self, usd: float) -> None:
        self.spent += max(0.0, float(usd or 0.0))
        self.calls += 1

    def check(self) -> None:
        if self.budget > 0 and self.spent >= self.budget:
            raise SpendExhausted(self.summary())

    def would_exceed(self, usd: float) -> bool:
        return self.budget > 0 and (self.spent + usd) > self.budget

    def summary(self) -> str:
        cap = f"{self.budget:.2f}" if self.budget > 0 else 'unlimited'
        return f"spent ${self.spent:.2f} of ${cap} across {self.calls} calls"


def openai_enabled() -> bool:
    return bool(os.environ.get('OPENAI_API_KEY', '').strip())


def call_cost_usd(usage: Optional[dict], model: str) -> float:
    """What one call cost, from the usage the API reports back."""
    pin, pout = _PRICES.get(model, _DEAREST)
    u = usage or {}
    return (
        float(u.get('input_tokens') or 0) * pin
        + float(u.get('output_tokens') or 0) * pout
        # Charged even when usage is missing: a call happened, so it cost
        # something, and charging zero is how a budget silently never trips.
        + _SEARCH_CALL_USD
    )


# ── profile-URL validation — the fabrication guard ──────────────────────────
#
# Every placeholder the model produced had a non-numeric or obviously-fake id.
# Requiring real digits in both the geo and the location id is what separates
# a URL it copied from one it composed.
_TA_PROFILE = re.compile(
    r'^https?://(?:[a-z0-9-]+\.)?tripadvisor\.[a-z.]{2,6}/'
    r'(?:Hotel|Restaurant|Attraction|VacationRental)_Review'
    r'-g(\d+)-d(\d+)-',
    re.I,
)
_YELP_PROFILE = re.compile(
    r'^https?://(?:[a-z0-9-]+\.)?yelp\.[a-z.]{2,6}/biz/([a-z0-9][a-z0-9-]{2,})/?(?:\?|$)',
    re.I,
)
# Slugs and ids a model reaches for when it does not know the real one.
_PLACEHOLDER_SLUG = re.compile(
    r'^(?:example|sample|your|business|slug|name|placeholder|test)[-a-z0-9]*$', re.I,
)


def valid_profile_url(url: Any, platform: str) -> bool:
    """Is this a real profile URL, or one the model composed?"""
    if not isinstance(url, str) or not url.strip():
        return False
    u = url.strip()
    # Any angle bracket or run of X's is a template, never a real URL.
    if '<' in u or '>' in u or re.search(r'[xX]{3,}', u):
        return False

    if platform == 'tripadvisor':
        m = _TA_PROFILE.match(u)
        if not m:
            return False
        # d0, d00000 and friends are not real location ids.
        return int(m.group(1)) > 0 and int(m.group(2)) > 0

    if platform == 'yelp':
        m = _YELP_PROFILE.match(u)
        if not m:
            return False
        return not _PLACEHOLDER_SLUG.match(m.group(1))

    return False


# ── candidate parsing ───────────────────────────────────────────────────────
_LIST_KEYS = ('businesses', 'hotels', 'restaurants', 'results', 'items', 'places', 'data')


def _as_rows(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for key in _LIST_KEYS:
            got = payload.get(key)
            if isinstance(got, list):
                return [r for r in got if isinstance(r, dict)]
    return []


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


def parse_candidates(
    payload: Any,
    max_rating: float,
    min_rating: float,
    *,
    include_unrated: bool = False,
) -> list[dict]:
    """Rows worth confirming, with the rating ceiling re-applied locally.

    The ceiling is never left to the model: asked for <= 3.5 it returned 3.8
    and 3.6, and gpt-4.1-mini ignored the instruction completely.
    """
    out: list[dict] = []
    seen: set[str] = set()

    for row in _as_rows(payload):
        name = str(row.get('name') or row.get('business_name') or '').strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue

        rating = _as_float(row.get('rating') if row.get('rating') is not None
                           else row.get('approx_rating'))
        if rating is None:
            if not include_unrated:
                continue
        elif not (min_rating <= rating <= max_rating):
            continue

        seen.add(key)
        out.append({
            'name': name,
            'rating': rating,
            'city': (str(row.get('city')).strip() if row.get('city') else None),
            'review_count': int(_as_float(row.get('review_count')) or 0) or None,
        })

    return out


# ── the API call ────────────────────────────────────────────────────────────
def _post(body: dict, api_key: str) -> dict:
    req = urllib.request.Request(
        RESPONSES_URL, method='POST',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        data=json.dumps(body).encode('utf-8'),
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _extract_json(text: str) -> Any:
    """The model wraps its JSON in prose often enough to be worth handling."""
    if not text:
        return None
    m = re.search(r'\{.*\}|\[.*\]', text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def search_json(
    prompt: str,
    *,
    guard: SpendGuard,
    model: Optional[str] = None,
    retries: int = 2,
) -> tuple[Any, float, Optional[str]]:
    """One web-search call, returning (parsed_json, cost_usd, error).

    Charges the guard whatever the call cost even when the answer is
    unparseable — the money left regardless.
    """
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        return None, 0.0, 'missing_key'
    model = model or os.environ.get('OPENAI_LISTING_MODEL', DEFAULT_MODEL).strip()

    body = {'model': model, 'tools': [{'type': 'web_search'}], 'input': prompt}
    last_err: Optional[str] = None

    for attempt in range(retries + 1):
        try:
            data = _post(body, api_key)
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')[:200]
            last_err = f'http_{e.code}:{detail}'
            # 429 and 5xx are worth another go; a 400 never is.
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                return None, 0.0, last_err
            time.sleep(2 * (attempt + 1))
            continue
        except Exception as e:  # network, timeout, malformed JSON
            last_err = f'{type(e).__name__}:{str(e)[:150]}'
            if attempt == retries:
                return None, 0.0, last_err
            time.sleep(2 * (attempt + 1))
            continue

        cost = call_cost_usd(data.get('usage'), model)
        guard.charge(cost)

        text = ''.join(
            c.get('text', '')
            for item in data.get('output', []) or []
            for c in (item.get('content') or [])
            if c.get('type') == 'output_text'
        )
        return _extract_json(text), cost, None

    return None, 0.0, last_err


# ── the two passes ──────────────────────────────────────────────────────────
_PASS1_SCHEMA = (
    'Reply ONLY with JSON: {"businesses":[{"name":<string>,"rating":<number>,'
    '"review_count":<integer or null>}]}. '
    'Do not include a profile URL — it is not wanted here.'
)

_PASS2_SCHEMA = (
    'Reply ONLY with JSON: {"profile_url":<string or null>,"rating":<number or null>,'
    '"review_count":<integer or null>,"city":<string or null>,"phone":<string or null>,'
    '"website":<string or null>,"email":<string or null>}. '
    'The profile_url must be copied exactly from the page you opened. '
    'If you could not open the real profile page, set profile_url to null — '
    'never construct, guess or template a URL.'
)

_SITE = {'tripadvisor': 'Tripadvisor', 'yelp': 'Yelp'}


def discover_city(
    platform: str,
    city: str,
    category: str,
    *,
    guard: SpendGuard,
    max_rating: float,
    min_rating: float = 1.0,
    limit: int = 15,
    include_unrated: bool = False,
) -> tuple[list[dict], float, Optional[str]]:
    """Pass 1 — a whole city in one call, so the search fee is shared."""
    site = _SITE.get(platform, platform)
    prompt = (
        f'List {category} businesses in {city} whose {site} rating is '
        f'{max_rating} or LOWER. These are POORLY-rated businesses, not good ones. '
        f'Return up to {limit}.\n{_PASS1_SCHEMA}'
    )
    payload, cost, err = search_json(prompt, guard=guard)
    if err:
        return [], cost, err
    rows = parse_candidates(payload, max_rating, min_rating, include_unrated=include_unrated)
    for r in rows:
        r.setdefault('city', city)
        r['city'] = r.get('city') or city
    return rows, cost, None


def confirm_candidate(
    platform: str,
    name: str,
    city: str,
    *,
    guard: SpendGuard,
    max_rating: float,
    min_rating: float = 1.0,
    include_unrated: bool = False,
) -> tuple[Optional[dict], float, Optional[str]]:
    """Pass 2 — open the real profile for the URL, rating and contact details.

    Returns None when the profile could not be confirmed. That is the normal,
    correct outcome for a business the model cannot actually find: writing an
    unconfirmed row would put a fabricated dedupe key in the database.
    """
    site = _SITE.get(platform, platform)
    prompt = (
        f'Find the {site} profile page for "{name}" in {city}, open it, and report '
        f'what that page shows.\n{_PASS2_SCHEMA}'
    )
    payload, cost, err = search_json(prompt, guard=guard)
    if err:
        return None, cost, err
    if not isinstance(payload, dict):
        return None, cost, 'unparseable'

    url = payload.get('profile_url')
    if not valid_profile_url(url, platform):
        return None, cost, 'unverified_url'

    rating = _as_float(payload.get('rating'))
    if rating is None:
        if not include_unrated:
            return None, cost, 'no_rating'
    elif not (min_rating <= rating <= max_rating):
        # Pass 1's figure was approximate; the profile page is authoritative,
        # and this is where an over-cap business gets dropped.
        return None, cost, 'over_rating_cap'

    return {
        'name': name,
        'profile_url': str(url).strip(),
        'rating': rating,
        'review_count': int(_as_float(payload.get('review_count')) or 0) or None,
        'city': (str(payload.get('city')).strip() if payload.get('city') else city),
        'phone': (str(payload.get('phone')).strip() if payload.get('phone') else None),
        'website_url': (str(payload.get('website')).strip() if payload.get('website') else None),
        'platform_email': (str(payload.get('email')).strip() if payload.get('email') else None),
    }, cost, None


# How many consecutive unconfirmed candidates mean the platform itself is
# unreadable rather than those particular businesses being hard to find.
BLOCKED_AFTER = 3


def should_abort_blocked(attempted: int, confirmed: int) -> bool:
    """Has this platform proved unreadable?

    One confirmation proves the model can open the site, after which a failure
    is just a business it could not find. Zero confirmations after several
    tries means the site is refusing it - Yelp does exactly this, and without
    this check a run spends its whole budget discovering names it can never
    confirm.
    """
    return confirmed == 0 and attempted >= BLOCKED_AFTER


def two_pass_city(
    platform: str,
    city: str,
    category: str,
    *,
    guard: SpendGuard,
    max_rating: float,
    min_rating: float = 1.0,
    limit: int = 15,
    include_unrated: bool = False,
    on_progress: Optional[Callable[[dict], None]] = None,
    job_stats: Optional[dict] = None,
) -> list[dict]:
    """Both passes for one city. Raises SpendExhausted when the budget is gone.

    Whatever was confirmed before the budget ran out is preserved by the
    caller — same contract as the Apify paths.
    """
    emit = on_progress or (lambda _e: None)

    candidates, cost, err = discover_city(
        platform, city, category, guard=guard, max_rating=max_rating,
        min_rating=min_rating, limit=limit, include_unrated=include_unrated,
    )
    emit({
        'stage': 'listing', 'city': city, 'pass': 1,
        'candidates': len(candidates), 'call_cost_usd': round(cost, 4),
        'spent_usd': round(guard.spent, 4), 'error': err,
    })
    if err:
        return []
    guard.check()

    # Evidence of a wall is counted across the WHOLE job, not per city: a
    # city that happens to return two candidates can never reach the
    # threshold on its own, so a blocked platform would be re-proved city
    # after city at full price.
    stats = job_stats if job_stats is not None else {}
    stats.setdefault('attempted', 0)
    stats.setdefault('confirmed', 0)

    confirmed: list[dict] = []
    for cand in candidates:
        # Stop before spending rather than after: the next confirmation is the
        # one that would breach the budget.
        if guard.would_exceed(0.07):
            guard.check()
        row, cost, err = confirm_candidate(
            platform, cand['name'], cand.get('city') or city, guard=guard,
            max_rating=max_rating, min_rating=min_rating, include_unrated=include_unrated,
        )
        stats['attempted'] += 1
        if row:
            stats['confirmed'] += 1
            row.update({
                'platform': platform,
                'category': category,
                'listing_source': 'openai',
            })
            confirmed.append(row)
        emit({
            'stage': 'listing', 'city': city, 'pass': 2,
            'business': cand['name'], 'confirmed': bool(row), 'reason': err,
            'found': len(confirmed), 'call_cost_usd': round(cost, 4),
            'spent_usd': round(guard.spent, 4),
        })
        guard.check()

        if should_abort_blocked(stats['attempted'], stats['confirmed']):
            raise PlatformUnreadable(
                f"{stats['attempted']} candidates tried and not one profile could be "
                f"opened (latest city: {city}). The site is refusing OpenAI's "
                f"crawler, so this source cannot work for {platform} - discovery "
                f"keeps naming businesses it can never confirm. Stopped after "
                f"{guard.summary()}."
            )

    return confirmed


def run_listing(
    platform: str,
    cities: Iterable[str],
    category: str,
    *,
    country: str = '',
    max_rating: float = 3.5,
    min_rating: float = 1.0,
    min_review_count: int = 0,
    include_unrated: bool = False,
    max_results: Optional[int] = None,
    per_city_limit: Optional[int] = None,
    on_progress: Optional[Callable[[dict], None]] = None,
) -> list[dict]:
    """The whole listing run for one platform, fanned out city by city.

    Shared by every platform on this path, because the two passes are
    identical everywhere — only the prompt's site name and the URL shape
    differ, and both of those are already parameterised.

    On budget exhaustion the leads gathered so far are KEPT and returned, the
    same contract the Apify paths use: a spend guard must never throw away
    work that has already been paid for.
    """
    emit = on_progress or (lambda _e: None)

    if not openai_enabled():
        print(
            f"FAILED:listing|{platform}|missing_key|OPENAI_API_KEY is not set; "
            f"the openai listing source cannot run without it.",
            flush=True,
        )
        return []

    budget = float(os.environ.get('OPENAI_MAX_SPEND_PER_JOB', '2.00') or 2.00)
    batch = int(os.environ.get('OPENAI_LISTING_BATCH', '15') or 15)
    guard = SpendGuard(budget)
    limit = per_city_limit or batch

    results: list[dict] = []
    seen: set[str] = set()
    job_stats: dict = {'attempted': 0, 'confirmed': 0}

    for city in cities:
        if max_results and len(results) >= max_results:
            break
        try:
            rows = two_pass_city(
                platform, city, category, guard=guard, max_rating=max_rating,
                min_rating=min_rating, limit=limit, include_unrated=include_unrated,
                on_progress=emit, job_stats=job_stats,
            )
        except PlatformUnreadable as e:
            # Whole-job stop, not a per-city one: another city would only buy
            # the same answer at the same price.
            print(f"FAILED:listing|{platform}|openai_platform_unreadable|{e}", flush=True)
            break
        except SpendExhausted:
            # Deliberately not an error: the job did what it was funded to do.
            print(
                f"FAILED:listing|{platform}|openai_budget_exhausted|{guard.summary()}|"
                f"Raise OPENAI_MAX_SPEND_PER_JOB to go further. "
                f"{len(results)} businesses gathered before the budget ran out "
                f"have been kept.",
                flush=True,
            )
            break

        for row in rows:
            url = row.get('profile_url')
            if not url or url in seen:
                continue
            if min_review_count and (row.get('review_count') or 0) < min_review_count:
                continue
            seen.add(url)
            row['country'] = country or row.get('country')
            results.append(row)
            if max_results and len(results) >= max_results:
                break

        emit({
            'stage': 'listing', 'city': city, 'found': len(results),
            'spent_usd': round(guard.spent, 4), 'budget_usd': guard.budget,
            'cost_per_lead_usd': round(guard.spent / len(results), 4) if results else None,
        })

    # The operator sees what the run cost, whether or not it succeeded.
    print(
        f"COST:listing|{platform}|openai|{guard.summary()}|"
        f"{len(results)} leads|"
        f"${(guard.spent / len(results)) if results else 0:.4f} per lead",
        flush=True,
    )
    return results
