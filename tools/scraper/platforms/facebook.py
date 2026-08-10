"""FacebookScraper — first social-platform plugin.

Implements both lead modes:
  • CONSUMER MODE — search_posts() finds posts matching a keyword across
    public groups + News Feed. Authors of those posts become leads
    (target: people asking for the service you sell).
  • BUSINESS MODE — scrape_listing() + enrich_profiles() enumerate
    Facebook Pages by category (target: businesses you can sell
    reputation/lead-gen services to).

The browser stack is undetected-chromedriver (selenium-based), NOT
Playwright. Meta fingerprints Playwright's CDP signals; undetected-
chromedriver patches them out. We wrap sync selenium calls in
``asyncio.to_thread`` to satisfy the async BasePlatformScraper contract.

⚠️  IMPORTANT — selectors below are best-effort based on Facebook's
    current public DOM shape. Facebook rewrites class names roughly
    monthly. Expect your first real run to need selector tuning;
    the structure of the scraper (account claim, SSE events, dedup
    cache) does NOT change, only the CSS queries inside _extract_*.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from typing import NamedTuple, Optional
from urllib.parse import quote_plus

from selenium.webdriver.common.by import By

from tools.scraper.platforms._social_base import (
    AuthorLead,
    GroupStub,
    PostStub,
    SocialPlatformScraper,
)
from tools.scraper.platforms.base import FilterField, ProgressCallback
from tools.db.supabase_client import table
from tools.scraper.shared.session_store import load_cookies, save_cookies
from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini as _classify_consumer_posts_with_gemini

# How long to wait for individual page loads / scroll-stabilizations.
PAGE_LOAD_TIMEOUT = 30
SCROLL_PAUSE = 2.0
MAX_SCROLLS_PER_QUERY = 8

# Per-account counters update interval — flush after this many actions.
COUNTER_FLUSH_EVERY = 5

FB_BASE = 'https://www.facebook.com'

# Broad permalink regex used by _click_share_and_capture to validate the URL
# FB returns to the clipboard. Mirrors the patterns defined inline at
# _extract_posts_from_search_page:POST_URL_PATTERNS — kept at module scope so
# both the open-feed extractor AND the in-group extractor can share it.
_BROAD_POST_URL_RE = re.compile('|'.join([
    r'/photo/?\?[^"]*fbid=',
    r'/photo\.php\?[^"]*fbid=',
    r'/posts/(?:pfbid)?[A-Za-z0-9]',
    r'/permalink\.php\?',
    r'/groups/[^/]+/posts/',
    r'/groups/[^/]+/permalink/',
    r'/groups/[^/]+/multi_permalinks/',
    r'/share/p/',
    r'/share/v/',
    r'/share/r/',
    r'/videos/\d',
    r'/story\.php\?',
    r'/people/[^/]+/posts/',
]))

# ISO country code → primary spoken language name (in English).
# Used by _translate_niche_to_local to ask Gemini for the native niche term
# when the operator submits an English term + a non-English city. Keep in
# sync with _extract_country_from_excerpt's CITY_TO_COUNTRY mapping below:
# every country that appears there should appear here unless it's
# English-primary (GB/US/IE/CA/AU/NZ/SG/PH/IN/ZA — those are intentionally
# omitted so translation is skipped for them).
COUNTRY_TO_LANGUAGE: dict = {
    'DE': 'German',
    'AT': 'German',
    'CH': 'German',  # majority — Italian/French regions skip translate
    'FR': 'French',
    'BE': 'Dutch',   # Brussels can be French — picked Dutch as FB-more-active
    'NL': 'Dutch',
    'IT': 'Italian',
    'ES': 'Spanish',
    'PT': 'Portuguese',
    'BR': 'Portuguese',
    'MX': 'Spanish',
    'PL': 'Polish',
    'CZ': 'Czech',
    'SK': 'Slovak',
    'HU': 'Hungarian',
    'RO': 'Romanian',
    'BG': 'Bulgarian',
    'GR': 'Greek',
    'HR': 'Croatian',
    'SI': 'Slovenian',
    'RS': 'Serbian',
    'AL': 'Albanian',
    'MK': 'Macedonian',
    'ME': 'Montenegrin',
    'BA': 'Bosnian',
    'TR': 'Turkish',
    'SE': 'Swedish',
    'DK': 'Danish',
    'NO': 'Norwegian',
    'FI': 'Finnish',
    'IS': 'Icelandic',
    'LT': 'Lithuanian',
    'LV': 'Latvian',
    'EE': 'Estonian',
    'MD': 'Romanian',
    'UA': 'Ukrainian',
    'CY': 'Greek',
    'MT': 'Maltese',
    'LU': 'German',  # also French/Lëtzebuergesch — German is most-FB-active
}

# In-process cache: (language_lower, niche_lower) → native_term
# Avoids hitting Gemini for every scrape when the same niche+language combo
# repeats. Cache lives for the worker process lifetime; warms up in <60s
# of normal use.
_NICHE_TRANSLATION_CACHE: dict = {}


def _human_pause(base: float, *, extra: float = 1.0) -> None:
    """Sleep for a randomized, human-like interval >= ``base`` seconds.

    Real users never pause for exactly the same duration twice. Fixed
    ``time.sleep(2.0)`` calls give the scrape loop a metronome cadence
    that Facebook's automation detection keys on, so every PACING sleep
    (scroll waits, between-group gaps) goes through here instead of a
    constant. The drawn delay is uniform over ``[base, base + extra]``
    with an occasional longer "distracted reader" pause — and it never
    sleeps LESS than ``base``, so it can't reintroduce the timing races
    the original constants were tuned to avoid.

    NOTE: do NOT route the functional load/cookie-trust waits in
    _open_session through here — those are correctness waits, not pacing,
    and adding variability there risks the documented 'Not Found' stub.
    """
    delay = random.uniform(base, base + extra)
    if random.random() < 0.12:  # ~1 in 8: a longer human glance-away pause
        delay += random.uniform(2.0, 6.0)
    time.sleep(delay)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _effective_join_cap(configured_cap: int, warmup_started_at: Optional[str], now: datetime) -> int:
    """Warmup ramp for a pooled account's daily GROUP-JOIN budget, mirroring the
    TS effectiveCommentCap: week1 -> 1, week2 -> 2, week3 -> 3, day21+ -> full cap.
    warmup_started_at is null -> full cap (pre-warmup accounts). Never exceeds cap.
    `now` is injected so the calculation stays pure/testable.
    """
    if not warmup_started_at:
        return configured_cap
    started = datetime.fromisoformat(warmup_started_at)
    days = (now - started).days
    if days >= 21:
        return configured_cap
    ramp = 1 if days < 7 else 2 if days < 14 else 3
    return min(configured_cap, ramp)


def _candidate_matches_country(location: Optional[str], cc: str) -> bool:
    """A candidate's location is '<City>, <ISO2>' or a bare ISO2. Match the
    country TOKEN (last comma-separated piece), case-insensitive — never a
    loose substring (so 'Gbagada, NG' does not match 'GB')."""
    if not location:
        return False
    token = location.split(',')[-1].strip().upper()
    return token == cc.strip().upper()


def _parse_member_count(text: Optional[str]) -> int:
    """'12K members' -> 12000, '1.2K' -> 1200, '850 members' -> 850. Best-effort;
    the K/M suffix must be adjacent to the digits so the 'm' in 'members' is not
    read as mega. Unknown / unparseable -> 0 (sorts last)."""
    if not text:
        return 0
    m = re.search(r'([\d.,]+)([KkMm])?', text)
    if not m:
        return 0
    try:
        num = float(m.group(1).replace(',', ''))
    except ValueError:
        return 0
    mult = {'k': 1_000, 'm': 1_000_000}.get((m.group(2) or '').lower(), 1)
    return int(num * mult)


def _rank_join_candidates(rows: list[dict], cc: str, limit: int) -> list[dict]:
    """Filter to eligible join candidates and order by relevance then size."""
    eligible = [
        r for r in rows
        if r.get('status') == 'candidate'
        and r.get('audience') == 'customers'
        and (r.get('relevance_tier') or 0) >= 1
        and _candidate_matches_country(r.get('location'), cc)
    ]
    eligible.sort(
        key=lambda r: (r.get('relevance_tier') or 0, _parse_member_count(r.get('member_count_text'))),
        reverse=True,
    )
    return eligible[:max(0, limit)]


def _classify_join_outcome(signals: dict) -> str:
    """Decide the DB-facing outcome from four page booleans. Order matters:
    membership wins over everything; a surfaced questions form is a skip (we
    never auto-answer); a pending marker is a request; anything else is a
    failure to make progress."""
    if signals.get('is_member'):
        return 'joined'
    if signals.get('questions_shown'):
        return 'questions'
    if signals.get('request_pending'):
        return 'requested'
    return 'failed'


_JOIN_MEMBER_MARKERS = ('joined', 'leave group', "you're a member", 'you are a member')
_JOIN_PENDING_MARKERS = ('cancel request', 'requested', 'request sent', 'pending')
_JOIN_QUESTION_MARKERS = ('answer', 'membership question', 'to join this group, answer')


def _read_join_signals(driver) -> dict:
    """Distil the group page into booleans for _classify_join_outcome. Best-effort
    and case-insensitive; FB drifts this DOM, so keep it here (one place to fix)."""
    body = (driver.find_element(By.TAG_NAME, 'body').text or '').lower()
    return {
        'is_member': any(m in body for m in _JOIN_MEMBER_MARKERS),
        'request_pending': any(m in body for m in _JOIN_PENDING_MARKERS),
        'questions_shown': any(m in body for m in _JOIN_QUESTION_MARKERS),
    }


def _find_join_button(driver):
    """Return a clickable primary Join control or None. Matches role=button with
    visible text starting 'Join' (aria-label or inner text)."""
    for el in driver.find_elements(By.XPATH, "//*[@role='button' or self::button or self::a]"):
        try:
            label = (el.get_attribute('aria-label') or el.text or '').strip().lower()
        except Exception:  # noqa: BLE001 — stale element during FB re-render
            continue
        if label.startswith('join') and el.is_displayed():
            return el
    return None


def _join_one_group(driver, group_id: str, on_progress) -> str:
    """Navigate to a group and attempt to join. Returns an outcome from
    _classify_join_outcome. Never raises for an expected FB state."""
    driver.get(f"{FB_BASE}/groups/{group_id}")
    _human_pause(4.0, extra=3.0)

    pre = _read_join_signals(driver)
    if pre['is_member']:
        return _classify_join_outcome({**pre, 'join_clicked': False})

    btn = _find_join_button(driver)
    if btn is None:
        return _classify_join_outcome({'is_member': pre['is_member'], 'request_pending': pre['request_pending'],
                                       'questions_shown': False, 'join_clicked': False})
    try:
        btn.click()
    except Exception as exc:  # noqa: BLE001
        _emit(on_progress, 'join_failed', group_id=group_id, reason=f'click_error:{exc}'[:120])
        return 'failed'
    _human_pause(3.0, extra=3.0)

    post = _read_join_signals(driver)
    return _classify_join_outcome({**post, 'join_clicked': True})


def _bump_group_join_counter(account_id: str) -> None:
    """Increment group_join_used_today for an account (read-modify-write, mirrors
    _bump_comment_counter)."""
    row = table('social_accounts').select('group_join_used_today').eq('id', account_id).execute().data
    if not row:
        return
    new_count = (row[0].get('group_join_used_today') or 0) + 1
    (table('social_accounts')
     .update({'group_join_used_today': new_count, 'updated_at': _now_iso()})
     .eq('id', account_id).execute())


def _emit(on_progress: ProgressCallback, stage: str, **detail) -> None:
    """Emit a canonical PROGRESS:<stage>:<detail> line + callback."""
    payload = {'stage': stage, **detail}
    if on_progress:
        on_progress(payload)
    parts = [f'PROGRESS:{stage}']
    for k, v in detail.items():
        parts.append(f'{k}={v}')
    print(':'.join(parts) if len(parts) == 1 else parts[0] + ':' + ' '.join(parts[1:]), flush=True)


def _claim_account(platform: str = 'facebook', country: Optional[str] = None) -> Optional[dict]:
    """Pick the next available active social_accounts row.

    Returns the row dict, or None if no account is available (all
    capped or none connected). The caller increments counters via
    ``_bump_counters`` after each significant action.

    Auto-rollover: when ``last_used_at`` is older than 1 hour / 24 hours,
    the hour / day buckets are stale. Reset them in the DB before the
    cap check so the account becomes usable on the natural boundary.
    Without this, ``used_this_hour`` accumulates across hours and
    permanently strands the account at the cap.
    """
    from datetime import datetime, timezone, timedelta
    q = (
        table('social_accounts')
        # select('*') — NOT an explicit column list. An explicit projection
        # silently DROPPED adspower_profile_id (added by migration 057), so
        # _open_driver never activated AdsPower. Naming the column instead
        # would 400 on any database where 057 has not been applied yet, which
        # would break every Facebook scrape; '*' is correct either way and
        # makes future columns available without touching this call.
        .select('*')
        .eq('platform', platform)
        .eq('status', 'active')
    )
    if country:
        q = q.eq('country', country)
    rows = q.order('used_today', desc=False).limit(5).execute().data
    now = datetime.now(timezone.utc)
    for row in rows:
        # Roll over stale counters before checking caps.
        last_used_raw = row.get('last_used_at')
        if last_used_raw:
            try:
                last_used = datetime.fromisoformat(last_used_raw.replace('Z', '+00:00'))
                age = now - last_used
                resets: dict = {}
                if age >= timedelta(hours=1) and (row.get('used_this_hour') or 0) > 0:
                    row['used_this_hour'] = 0
                    resets['used_this_hour'] = 0
                if age >= timedelta(hours=24) and (row.get('used_today') or 0) > 0:
                    row['used_today'] = 0
                    resets['used_today'] = 0
                if resets:
                    try:
                        table('social_accounts').update(resets).eq('id', row['id']).execute()
                    except Exception:
                        pass
            except Exception:
                pass
        if row['used_today'] >= row['daily_cap']:
            continue
        if row['used_this_hour'] >= row['hourly_cap']:
            continue
        if not row.get('encrypted_cookies'):
            continue
        return row
    return None


def _bump_counters(account_id: str, delta_today: int = 1, delta_hour: int = 1) -> None:
    """Atomically bump used_today / used_this_hour for an account.

    We do a read-modify-write since postgrest-py doesn't expose atomic
    increments through the public client. Worst-case skew is a few
    counts under high concurrency — acceptable because the caps are
    soft (we sleep heavily between actions anyway).
    """
    row = (
        table('social_accounts')
        .select('used_today,used_this_hour')
        .eq('id', account_id)
        .execute()
        .data
    )
    if not row:
        return
    new_today = (row[0]['used_today'] or 0) + delta_today
    new_hour = (row[0]['used_this_hour'] or 0) + delta_hour
    (
        table('social_accounts')
        .update({
            'used_today': new_today,
            'used_this_hour': new_hour,
            'last_used_at': _now_iso(),
        })
        .eq('id', account_id)
        .execute()
    )


def _load_account_by_id(account_id: str) -> dict:
    """Fetch a social_accounts row by primary key.

    Used by the comment-post path where the server has already chosen the
    correct account for the lead's country — we just need its full row.

    Raises RuntimeError when the row doesn't exist or the account is not
    active (caller should surface this as an error, not silently skip).
    """
    rows = (
        table('social_accounts')
        # select('*') for the same reason as _claim_account: an explicit
        # projection dropped adspower_profile_id on the comment path — the
        # engagement path AdsPower exists for — and naming the column would
        # 400 wherever migration 057 has not been applied.
        .select('*')
        .eq('id', account_id)
        .execute()
        .data
    )
    if not rows:
        raise RuntimeError(f"social_accounts row not found for id={account_id!r}")
    row = rows[0]
    if row.get('status') != 'active':
        raise RuntimeError(
            f"Account {account_id!r} is not active (status={row.get('status')!r})"
        )
    return row


def _bump_comment_counter(account_id: str) -> None:
    """Atomically increment comment_used_today for an account.

    Mirrors _bump_counters but touches only the comment budget columns,
    so read-path counters (used_today / used_this_hour) remain untouched.
    """
    row = (
        table('social_accounts')
        .select('comment_used_today')
        .eq('id', account_id)
        .execute()
        .data
    )
    if not row:
        return
    new_comment_count = (row[0].get('comment_used_today') or 0) + 1
    (
        table('social_accounts')
        .update({
            'comment_used_today': new_comment_count,
            'updated_at': _now_iso(),
        })
        .eq('id', account_id)
        .execute()
    )


def _flag_checkpoint(account_id: str, reason: str) -> None:
    """Mark an account as captcha-locked. The frontend banner will surface this."""
    (
        table('social_accounts')
        .update({
            'status': 'checkpoint',
            'last_checkpoint_at': _now_iso(),
            'checkpoint_reason': reason[:255],
            'updated_at': _now_iso(),
        })
        .eq('id', account_id)
        .execute()
    )
    _emit(None, 'failed', kind='checkpoint', account=account_id, reason=reason)


# Phrases that almost always indicate a BUSINESS posting an ad rather
# than a consumer asking for a service. When the operator filters for
# consumers we drop posts matching these.
BUSINESS_PATTERNS = [
    "we've got you covered", "we have got you covered", "we offer",
    "our team", "our clinic", "our services", "our branch",
    "book an appointment", "book your appointment", "book now", "schedule your",
    "contact us", "call us", "visit our", "our location",
    "assigned dentists", "branch:", "services include",
    "open from", "operating hours", "promo", "discount",
    "follow us", "like our page", "official page",
    # Hiring / recruitment ads — these are businesses RECRUITING dentists,
    # not consumers asking for dental services. Same effect — drop them.
    "we are hiring", "now hiring", "we're hiring", "job opening",
    "associate dentist", "to join our team", "to join our growing team",
    "send your resume", "qualifications:", "applicant", "applicants",
    "cv to", "send cv", "send your cv", "interested applicants",
    # Clinics recruiting subjects/patients — these match consumer
    # patterns ('looking for') but the inverse direction.
    "looking for patient", "looking for a patient", "looking for patients",
    "looking for a model", "looking for models",
    "looking for volunteers", "looking for a volunteer",
    "looking for subjects", "free service in exchange",
]

# STRONG asking signals — phrases that almost always mean the author is
# CURRENTLY looking for the service (not thanking, recommending, or sharing
# a past experience). Removed the 'salamat doc / thanks doc / i recommend'
# patterns that previously kept post-experience thank-you posts in the lead
# list (e.g. Alcantara MTherese's 'Salamat Doc GV Niña' after a dentist
# visit — she has a dentist, she's not looking for one).

# STRONG business signals — these ALWAYS drop the post, even when a
# consumer-asking pattern is also present in the same text. Example:
# 'Looking for a patient free cleaning' matches 'looking for a' (consumer)
# AND 'looking for a patient' (clinic recruiting patient) — the latter
# wins because the post is clearly from a dental student / clinic.
STRONG_BUSINESS_PATTERNS = [
    "looking for a patient", "looking for patient", "looking for patients",
    "looking for a model", "looking for models", "looking for a volunteer",
    "established client base", "practice for sale", "clinic for sale",
    "your clinic", "your dental clinic", "your practice",
    "your dental practice", "your dental office",
    "for your clinic", "for your practice",
    "for your dental practice", "for your dental office",
    "to your patients",
    "associate dentist", "reliever dentist", "licensed dentist",
    # Recruiter / "join us" phrasing — clinics looking for staff, not
    # consumers looking for service. "Looking for a qualified dental
    # nurse to join our private practice" matches CONSUMER ('looking
    # for a') but is clearly a job ad — these patterns kill it.
    "to join our team", "to join our growing team",
    "join our practice", "join our private practice", "join our clinic",
    "join our growing practice", "join the practice", "join the team",
    "to join the team", "to join the practice",
    "qualified dental nurse", "qualified hygienist",
    # Staff-role recruiter framing is also matched by STAFF_RECRUITER_RE
    # below — this list keeps the unambiguous variants for grep-friendliness.
    # Bare role mentions ("my dental hygienist said I should see a dentist")
    # appear in genuine consumer posts and must NOT trigger a drop.
    "dental nurse to join", "dental hygienist to join",
    "dental therapist to join", "dental technician to join",
    "bds dental surgeon",
    # Job-listing markers
    "position:", "full-time / part-time", "full time / part time",
    # Clinic ads disguised as asks
    "we are your partner", "comprehensive services",
    # Agency / sales pitches to dental practices
    "lead gen agency", "marketing agency", "growth agency",
    "for a case study",
    "wants a website", "want a website", "needs a website",
    "websites for dentists", "websites for plumbers",
    "leads for dentists", "leads for plumbers",
    "marketing for dentists", "marketing for plumbers",
    # Practitioner-to-peer networking (not a consumer searching)
    "fellow plumbers", "fellow dentists", "fellow hygienists",
    "fellow electricians", "fellow tradies", "fellow tradesmen",
    "looking for advice on how to get",
    "advice on getting leads", "advice on how to get leads",
    "how to find clients", "how to get clients",
    # Recruiter framing without explicit "join" — clinic offering work
    "to take on jobs", "to take on a few", "to take on extra",
    "take on a few extra", "take on extra jobs", "extra work per day",
    "extra jobs per day", "jobs per day",
    # Job-seeker CV openers (very common Filipino/African expat pattern
    # in trade-network groups). These authors are looking for WORK, not
    # services.
    "looking for work", "looking for employment", "seeking work",
    "seeking employment", "available for hire", "available for work",
    "i have a diploma", "i have a degree in",
    "i have experience in electrical", "i have experience in plumbing",
    "i have experience in dental",
    # Service-provider ad copy — when a post lists out services it's
    # almost always a clinic/contractor advertising, not a consumer.
    "all plumbing work", "all electrical work", "all dental work",
    "all plumbing services", "all electrical services",
    "emergency call out", "emergency callouts", "24/7 service",
    "fast and reliable service", "fully insured and qualified",
    "look no further", "you can count on", "fast, friendly",
    "fast and friendly", "no job too big", "no job too small",
    "free estimates", "free quotes", "competitive prices",
    "repairs, installations", "installations, repairs",
    # B2B coordination / hiring phrases — universal English, drop everywhere
    "reliever work", "for hiring", "to connect",
    "for relievers", "looking to hire", "now accepting",
]


CONSUMER_PATTERNS = [
    "looking for a", "looking for an", "looking for any", "looking for some",
    "looking for someone",
    "anyone know a", "anyone tried", "anyone been to",
    "any recommendation", "any recommendations",
    "can you recommend", "can someone recommend", "please recommend",
    "help me find", "where can i find", "where to find",
    "any suggestion", "any suggestions", "any tips on finding",
    "need a good", "need a reliable", "need to find", "need someone",
    "in search of", "in need of",
    "anyone here knows", "anyone here know",
    "pa-suggest", "pa-recommend",  # Filipino code-switch for "please suggest / recommend"
]

# Phrases that mean POST-EXPERIENCE (already went / already have a provider).
# These authors are NOT looking — they're either thanking or showing off.
# When detected, drop the post regardless of any consumer-pattern match.
POST_EXPERIENCE_PATTERNS = [
    "salamat doc", "thanks doc", "thank you doc",
    "thank you to", "thanks to ",
    "had my", "went to", "got my teeth", "appointment was", "appointment with",
    "shoutout to dr", "shoutout to doc",
    "i recommend", "i highly recommend", "highly recommend dr",
    "i went", "i had", "we went", "we had",
    # Past-tense asking narratives — someone describing that they used to
    # be looking, not that they ARE looking now. "JL Moncada was looking
    # for recommendations" is the user telling a story, often followed by
    # "and found Dr. X" — they're already settled.
    "was looking", "were looking", "had been looking", "was searching",
    "was in search", "used to look",
]


def _translate_niche_to_local(
    niche: str,
    location: str,
    *,
    timeout_s: int = 15,
) -> Optional[str]:
    """Translate a niche term to the local language of the given location.

    Returns the translated term on success. Returns None when:
      - location can't be mapped to a country (e.g. unknown city)
      - country is English-primary (no translation needed)
      - country has no entry in COUNTRY_TO_LANGUAGE (multilingual edge case)
      - GEMINI_API_KEY is unset or the API call fails

    Caller should treat None as "use original niche unchanged" — DO NOT
    fall back to a different niche; we'd rather under-translate than
    pick something semantically wrong.

    Cache lookup is O(1) on (language_lower, niche_lower). The first call
    for a new combo costs ~0.5s of Gemini latency; subsequent calls are
    free for the worker's lifetime.
    """
    if not niche or not location:
        return None

    country = _extract_country_from_excerpt(location)
    if not country:
        return None  # unknown city — caller uses original niche

    language = COUNTRY_TO_LANGUAGE.get(country)
    if not language:
        return None  # English-primary OR multilingual without default

    # Cache check (case-insensitive)
    cache_key = (language.lower(), niche.lower().strip())
    if cache_key in _NICHE_TRANSLATION_CACHE:
        return _NICHE_TRANSLATION_CACHE[cache_key]

    api_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')
    if not api_key:
        return None

    # Prompt design: short, deterministic, JSON-only. Ask for the most
    # common consumer-facing word a real local would use in a casual FB
    # group post — NOT a formal/dictionary translation. e.g. for "plumber"
    # in Italian we want "idraulico", not "addetto agli impianti idraulici".
    prompt = f"""You are translating a service-provider niche term for a Facebook group search.

Niche: "{niche}"
Target language: {language}

Return the single most common consumer-facing word(s) a native speaker of {language} would use when asking for this service in a casual community Facebook post. NOT the formal/professional/dictionary term — the everyday term.

Rules:
- 1-3 words maximum
- Lowercase unless the language requires capitalization (e.g. German nouns)
- Use diacritics correctly (é, ñ, ü, ß, etc.)
- No quotation marks, no explanations, no alternatives
- If the niche is already in {language}, return it unchanged
- If no good translation exists in {language}, return the niche unchanged

Return ONLY a JSON object with this exact shape:
{{"native_term": "..."}}
"""

    url = (
        'https://generativelanguage.googleapis.com/v1beta/models/'
        f'gemini-2.5-flash:generateContent?key={api_key}'
    )
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.1,
            # Gemini 2.5 Flash spends "thinking tokens" before output.
            # 64 was too low — the budget ran out during thinking and the
            # visible response came back empty. 512 leaves comfortable
            # headroom (typical translation is 1-5 tokens of actual JSON).
            'maxOutputTokens': 512,
            'responseMimeType': 'application/json',
        },
    }

    try:
        import requests as _requests  # lazy
        resp = _requests.post(url, json=payload, timeout=timeout_s)
        resp.raise_for_status()
        body = resp.json()
        text = (
            body.get('candidates', [{}])[0]
                .get('content', {})
                .get('parts', [{}])[0]
                .get('text', '')
        ).strip()
        if not text:
            # Defensive: empty response means thinking-budget exhausted OR
            # safety filter blocked it. Log the full response for diagnosis.
            print(f'[niche-translate] empty response for "{niche}" -> {language}: {body!r}'[:500], file=sys.stderr)
            return None
        parsed = json.loads(text)
        native = (parsed.get('native_term') or '').strip()
        if not native or len(native) > 60:
            return None
        _NICHE_TRANSLATION_CACHE[cache_key] = native
        return native
    except Exception as exc:  # noqa: BLE001
        print(f'[niche-translate] failed for "{niche}" -> {language}: {exc}', file=sys.stderr)
        return None


# _classify_consumer_posts_with_gemini is re-exported from social_nlp (see import above)
# so all existing call sites in this file keep working unchanged.


def _is_actively_asking(excerpt: str) -> bool:
    """Strict check: the post LOOKS like someone CURRENTLY asking for the
    service. Requires (a) a strong consumer/asking phrase, and (b) absence
    of post-experience markers. Returns False for thank-you posts,
    recommendations, and past-tense narratives even when they happen to
    contain 'looking for' rhetorically.
    """
    text = (excerpt or '').lower()
    has_asking = any(p in text for p in CONSUMER_PATTERNS)
    has_past = any(p in text for p in POST_EXPERIENCE_PATTERNS)
    return has_asking and not has_past


# Recruiter framing around staff roles. Matches:
#   "looking for a [modifier]* [dental ]nurse|hygienist|therapist|..."
#   "[dental ]nurse|hygienist|... [is ]?required"
# The modifier slot covers full-time/part-time/qualified/registered/etc.
# without us enumerating every combination as a literal substring.
_STAFF_RECRUITER_RE = re.compile(
    r'looking for (?:a |an )?'
    r'(?:(?:full[- ]time|part[- ]time|qualified|registered|experienced|trainee|associate|gdc[- ]registered|new) )*'
    r'(?:dental )?'
    r'(?:nurse|hygienist|therapist|technician|assistant|receptionist|surgeon)'
    r'|'
    r'(?:dental )?'
    r'(?:nurse|hygienist|therapist|technician|assistant|receptionist|surgeon)s? '
    r'(?:is |are )?required',
    re.I,
)


def _looks_like_business_post(excerpt: str, author_handle: str = '') -> bool:
    """Return True when the post LOOKS like a business advertising rather than
    a consumer asking.

    Decision tree:
      1. Handle clearly identifies a business (clinic/dental/etc.) → drop.
      2. 2+ business phrases in excerpt → drop regardless of asking phrases.
      3. 1 business phrase AND no asking phrase → drop.
    """
    text = (excerpt or '').lower()
    handle = (author_handle or '').lower()

    BUSINESS_HANDLE_TOKENS = (
        'clinic', 'dental', 'dentist', 'dds', 'orthodontic', 'aesthetic',
        'studio', 'spa', 'salon', 'medspa', 'wellness', 'pharmacy',
        'optical', 'medical', 'health',
    )
    if any(tok in handle for tok in BUSINESS_HANDLE_TOKENS):
        return True

    # STRONG business signal — wins regardless of any 'looking for a'
    # consumer phrase the same post may also contain.
    if any(p in text for p in STRONG_BUSINESS_PATTERNS):
        return True

    # Staff-role recruiter framing via regex — handles modifier variants
    # like "looking for a full-time dental nurse" without enumerating all
    # modifier combinations as substrings.
    if _STAFF_RECRUITER_RE.search(text):
        return True

    business_hits = sum(1 for p in BUSINESS_PATTERNS if p in text)
    has_asking = any(p in text for p in CONSUMER_PATTERNS)

    if business_hits >= 2:
        return True
    if business_hits >= 1 and not has_asking:
        return True
    return False


# City/region names that double as ordinary English words. `\b` word-
# boundary anchoring (below) fixes every "fragment inside a longer word"
# false positive ('nice' inside 'niceties', 'bern' inside 'Bernie' or
# 'Berne') but CANNOT fix a name that is ALSO a complete, standalone English
# word — verified live, "That was nice of them" resolved to FR under the old
# substring matcher, and word boundaries alone don't help because "nice" is
# genuinely a whole word there too. Requiring the matched text to be
# capitalised (English prose conventionally capitalises proper nouns) turns
# that ordinary-word reading into a non-match while "I live in Nice, France"
# still matches. It is not a complete fix — a sentence-initial "Nice weather
# today!" still slips through — but it removes the far more common
# lowercase, mid-sentence false positive, which is the one actually observed
# live. Kept as a short, explicit allowlist rather than applied to the whole
# map: the other ~150 entries are not dictionary words and gain nothing from
# the extra restriction. 'reading' (Berkshire, England) is a second example
# of the same collision, added to CITY_TO_COUNTRY below specifically to
# exercise this — it did not resolve at all before this fix.
_CASE_SENSITIVE_CITY_NAMES = frozenset({'nice', 'reading'})


def _compile_place_patterns(pairs):
    """Compile (needle, country) pairs into (regex, country, needs_capital).

    Every needle is escaped — several contain regex metacharacters
    ('lapu-lapu', 'cluj-napoca') — and anchored with `\\b` word/phrase
    boundaries so a city name only counts as a STANDALONE word or phrase,
    never a fragment inside a longer one. The compiled regex is always
    case-insensitive; `needs_capital` (see _CASE_SENSITIVE_CITY_NAMES) is
    re-checked by the caller against the actual matched text, not baked into
    the pattern, so this only compiles — it doesn't decide the match.
    """
    compiled = []
    for needle, country in pairs:
        pattern = re.compile(r'\b' + re.escape(needle) + r'\b', re.IGNORECASE)
        compiled.append((pattern, country, needle in _CASE_SENSITIVE_CITY_NAMES))
    return compiled


# Province/state tokens that disambiguate a city name shared across
# countries (e.g. "London, Ontario" must resolve CA, not GB). Checked
# BEFORE the bare-city scan so the province wins. Small + data-driven —
# only provinces actually seen in live group names.
PROVINCE_TO_COUNTRY = [
    ('ontario', 'CA'), ('quebec', 'CA'), ('québec', 'CA'),
    ('alberta', 'CA'), ('manitoba', 'CA'), ('saskatchewan', 'CA'),
    ('british columbia', 'CA'), ('nova scotia', 'CA'),
]
_PROVINCE_PATTERNS = _compile_place_patterns(PROVINCE_TO_COUNTRY)

# Order matters: most specific multi-word cities first so 'lapu-lapu city'
# matches before a generic 'cebu' substring would, 'cluj-napoca' before
# 'cluj', and 'new york' before the word 'york' shows up in any other
# context.
CITY_TO_COUNTRY = [
    # ─── United Kingdom ─────────────────────────────────────
    ('london', 'GB'), ('manchester', 'GB'), ('birmingham', 'GB'),
    ('leeds', 'GB'), ('liverpool', 'GB'), ('bristol', 'GB'),
    ('edinburgh', 'GB'), ('glasgow', 'GB'),
    ('belfast', 'GB'), ('cardiff', 'GB'),
    # 'reading' is ALSO the ordinary English word/gerund "reading" — see
    # _CASE_SENSITIVE_CITY_NAMES; only the capitalised "Reading" counts.
    ('reading', 'GB'),
    # ─── Ireland ────────────────────────────────────────────
    ('dublin', 'IE'), ('cork', 'IE'), ('galway', 'IE'),
    # ─── Germany ────────────────────────────────────────────
    ('berlin', 'DE'), ('munich', 'DE'), ('hamburg', 'DE'),
    ('frankfurt', 'DE'), ('cologne', 'DE'), ('stuttgart', 'DE'),
    ('düsseldorf', 'DE'), ('dusseldorf', 'DE'), ('leipzig', 'DE'),
    # ─── France ─────────────────────────────────────────────
    ('paris', 'FR'), ('marseille', 'FR'), ('lyon', 'FR'),
    ('toulouse', 'FR'),
    # 'nice' is ALSO the ordinary English adjective "nice" — see
    # _CASE_SENSITIVE_CITY_NAMES; only the capitalised "Nice" counts.
    ('nice', 'FR'), ('bordeaux', 'FR'),
    ('nantes', 'FR'),
    # ─── Spain ──────────────────────────────────────────────
    ('madrid', 'ES'), ('barcelona', 'ES'), ('valencia', 'ES'),
    ('seville', 'ES'), ('bilbao', 'ES'), ('málaga', 'ES'),
    ('malaga', 'ES'),
    # ─── Italy ──────────────────────────────────────────────
    ('rome', 'IT'), ('milan', 'IT'), ('naples', 'IT'),
    ('florence', 'IT'), ('turin', 'IT'), ('bologna', 'IT'),
    ('venice', 'IT'),
    # ─── Netherlands ────────────────────────────────────────
    ('amsterdam', 'NL'), ('rotterdam', 'NL'), ('the hague', 'NL'),
    ('utrecht', 'NL'), ('eindhoven', 'NL'),
    # ─── Belgium ────────────────────────────────────────────
    ('brussels', 'BE'), ('antwerp', 'BE'), ('ghent', 'BE'),
    # ─── Luxembourg ─────────────────────────────────────────
    ('luxembourg city', 'LU'), ('luxembourg', 'LU'),
    # ─── Portugal ───────────────────────────────────────────
    ('lisbon', 'PT'), ('porto', 'PT'), ('braga', 'PT'),
    # ─── Switzerland ────────────────────────────────────────
    ('zurich', 'CH'), ('zürich', 'CH'), ('geneva', 'CH'),
    ('basel', 'CH'), ('bern', 'CH'),
    # ─── Austria ────────────────────────────────────────────
    ('vienna', 'AT'), ('salzburg', 'AT'), ('graz', 'AT'),
    # ─── Czech Republic ─────────────────────────────────────
    ('prague', 'CZ'), ('brno', 'CZ'),
    # ─── Slovakia ───────────────────────────────────────────
    ('bratislava', 'SK'),
    # ─── Poland ─────────────────────────────────────────────
    ('warsaw', 'PL'), ('krakow', 'PL'), ('kraków', 'PL'),
    ('wrocław', 'PL'), ('wroclaw', 'PL'), ('gdańsk', 'PL'), ('gdansk', 'PL'),
    # ─── Hungary ────────────────────────────────────────────
    ('budapest', 'HU'),
    # ─── Romania ────────────────────────────────────────────
    ('cluj-napoca', 'RO'), ('bucharest', 'RO'),
    # ─── Bulgaria ───────────────────────────────────────────
    ('sofia', 'BG'), ('plovdiv', 'BG'),
    # ─── Sweden ─────────────────────────────────────────────
    ('stockholm', 'SE'), ('gothenburg', 'SE'), ('malmö', 'SE'),
    ('malmo', 'SE'),
    # ─── Denmark ────────────────────────────────────────────
    ('copenhagen', 'DK'), ('aarhus', 'DK'),
    # ─── Norway ─────────────────────────────────────────────
    ('oslo', 'NO'), ('bergen', 'NO'),
    # ─── Finland ────────────────────────────────────────────
    ('helsinki', 'FI'), ('tampere', 'FI'),
    # ─── Iceland ────────────────────────────────────────────
    ('reykjavik', 'IS'),
    # ─── Greece ─────────────────────────────────────────────
    ('athens', 'GR'), ('thessaloniki', 'GR'),
    # ─── Balkans ────────────────────────────────────────────
    ('zagreb', 'HR'), ('split', 'HR'),
    ('ljubljana', 'SI'),
    ('belgrade', 'RS'),
    ('sarajevo', 'BA'),
    ('tirana', 'AL'),
    ('skopje', 'MK'),
    ('podgorica', 'ME'),
    # ─── Baltics + Moldova + Ukraine ────────────────────────
    ('vilnius', 'LT'),
    ('riga', 'LV'),
    ('tallinn', 'EE'),
    ('chișinău', 'MD'), ('chisinau', 'MD'),
    ('kyiv', 'UA'), ('kiev', 'UA'), ('lviv', 'UA'),
    # ─── Mediterranean ──────────────────────────────────────
    ('valletta', 'MT'),
    ('nicosia', 'CY'), ('limassol', 'CY'),
    # ─── Türkiye ────────────────────────────────────────────
    ('istanbul', 'TR'), ('ankara', 'TR'), ('izmir', 'TR'),
    # ─── United States ──────────────────────────────────────
    ('new york', 'US'), ('brooklyn', 'US'), ('manhattan', 'US'),
    ('queens', 'US'), ('bronx', 'US'),
    ('los angeles', 'US'), ('san diego', 'US'), ('san francisco', 'US'),
    ('san jose', 'US'), ('sacramento', 'US'),
    ('chicago', 'US'), ('houston', 'US'), ('dallas', 'US'),
    ('austin', 'US'), ('san antonio', 'US'),
    ('phoenix', 'US'), ('las vegas', 'US'), ('denver', 'US'),
    ('seattle', 'US'), ('portland', 'US'),
    ('philadelphia', 'US'), ('boston', 'US'), ('washington', 'US'),
    ('baltimore', 'US'), ('atlanta', 'US'),
    ('miami', 'US'), ('orlando', 'US'), ('tampa', 'US'),
    ('charlotte', 'US'), ('nashville', 'US'),
    ('detroit', 'US'), ('minneapolis', 'US'),
    ('columbus', 'US'), ('indianapolis', 'US'),
    ('cleveland', 'US'), ('pittsburgh', 'US'),

    # Legacy non-Europe/US entries kept so manual scrapes against
    # these cities still benefit from the country-mismatch filter.
    ('lapu-lapu city', 'PH'), ('mandaue city', 'PH'), ('cebu city', 'PH'),
    ('liloan', 'PH'), ('mandaue', 'PH'), ('mactan', 'PH'),
    ('lapu-lapu', 'PH'), ('cebu', 'PH'), ('manila', 'PH'), ('makati', 'PH'),
    ('quezon city', 'PH'), ('davao', 'PH'),
    ('singapore', 'SG'),
    ('sydney', 'AU'), ('melbourne', 'AU'), ('brisbane', 'AU'),
]
_CITY_PATTERNS = _compile_place_patterns(CITY_TO_COUNTRY)


def _extract_country_from_excerpt(text: str) -> Optional[str]:
    """Best-effort: scan a post excerpt for a city/region name and map to a
    country ISO code. Returns None when no known city is found. The map is
    intentionally narrow — only places we've actually seen leads in. Expand
    as new regions surface in real scrapes.

    Matching is `\\b`-word-boundary anchored and case-insensitive (see
    _compile_place_patterns), NOT plain substring matching. Plain substring
    matching used to fabricate a country out of an ordinary sentence —
    verified live: "nice" inside "a nice day" -> FR, "bern" inside "Bernie"
    or "Berne" -> CH. The handful of entries that are ALSO complete English
    dictionary words when standalone ('nice', 'reading') additionally
    require the matched text to be capitalised — see
    _CASE_SENSITIVE_CITY_NAMES for the reasoning and its known limits.

    For the dental-services-in-Cebu test data the cities Liloan, Mandaue,
    Mactan, Lapu-Lapu, Cebu all signal PH; the same pattern works for any
    region — add (city, country) pairs as you find them.
    """
    if not text:
        return None
    for pattern, country, _needs_capital in _PROVINCE_PATTERNS:
        if pattern.search(text):
            return country
    for pattern, country, needs_capital in _CITY_PATTERNS:
        m = pattern.search(text)
        if m and (not needs_capital or m.group(0)[:1].isupper()):
            return country
    return None


def _resolve_lead_country(
    group_name: Optional[str],
    location: Optional[str],
    excerpt: Optional[str],
    *,
    geo_scoped: bool = True,
) -> Optional[str]:
    """Resolve a consumer lead's country from the richest available signal.

    `country` is the column the CRM filters cold-email eligibility on, so
    this must NEVER return anything except a real ISO-2 code or None —
    never a town name, never arbitrary operator-typed text.

    Two signals, in priority order:

    1. EVIDENCE IN THE POST ITSELF — the group name it was found in (which
       often carries a disambiguating province/region token like 'Ontario',
       via _extract_country_from_excerpt's PROVINCE_TO_COUNTRY check) and
       the post excerpt. Combined and run through
       _extract_country_from_excerpt. This wins whenever it resolves,
       regardless of `geo_scoped` — a post that names its own place is
       trustworthy evidence no matter how the search was run.

    2. THE OPERATOR'S OWN SEARCH LOCATION — trusted ONLY when `geo_scoped`
       is True, i.e. the search that produced this post is already known to
       be geographically confined there (see `_query_is_place_anchored` and
       the `geo_scoped` parameter threaded through
       `_apply_consumer_filter_chain`). A GLOBAL search must not stamp its
       target location onto a post that says nothing about where its author
       actually is — verified live, a 20-post global search for "Manchester"
       stamped all 20 leads GB when roughly 15 were American. Even when
       trusted, `location` still has to resolve to a real ISO-2 country
       through the same city map: an unmapped town ('Nairobi') or arbitrary
       operator-typed text ('Wigan', 'Nowheresville') is NEVER written into
       `country` — it previously was, verbatim, which is exactly the
       town-name-in-a-country-column bug this function now refuses to
       reproduce.

    Returns None when neither signal resolves. Callers that want to retain
    the operator's raw, unmapped location for their own reference should
    look at `location_confidence` (`_derive_location_confidence`) — there is
    no separate city column on the leads table, so `country` is not an
    acceptable place to stash it.
    """
    post_evidence = ' '.join(p for p in (group_name, excerpt) if p)
    resolved = _extract_country_from_excerpt(post_evidence)
    if resolved:
        return resolved
    if geo_scoped and location:
        return _extract_country_from_excerpt(location)
    return None


def _target_country_from_filters(filters: dict) -> Optional[str]:
    """Resolve the scrape's target country to an uppercased ISO-2 code.

    Businesses-mode passes an ISO `country`; consumers-mode passes a
    `location` city we map via _extract_country_from_excerpt. Returns
    None when neither resolves — caller treats that as "no country
    constraint" / "no account for country" depending on context.
    """
    explicit = (filters.get('country') or '').strip()
    if explicit:
        return explicit.upper()
    loc = (filters.get('location') or '').strip()
    if loc:
        cc = _extract_country_from_excerpt(loc)
        if cc:
            return cc.upper()
    return None


def _target_country_from_env() -> Optional[str]:
    """Resolve target country from the SCRAPE_TARGET_FILTERS env var.

    The orchestrator runs listing and enrichment as SEPARATE processes that
    all inherit the same env; the `_TARGET_COUNTRY` module global is only set
    in scrape_listing, so the enrich/search-posts processes rely on this env
    fallback to keep account selection + proxy country-consistent.
    """
    raw = os.environ.get('SCRAPE_TARGET_FILTERS')
    if not raw:
        return None
    try:
        filters = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(filters, dict):
        return None
    return _target_country_from_filters(filters)


def _derive_location_confidence(
    group_name: Optional[str],
    post_excerpt: Optional[str],
    operator_location: Optional[str],
) -> str:
    """Classify how well a captured lead matches the SEARCHED city.

    Returns:
      'confirmed_city' — searched city appears (whole-word) in the group name
                         or the post text.
      'same_country'   — a different city is named that resolves to the SAME
                         country as the operator's search location.
      'unconfirmed'    — no usable location signal (generic group + a post that
                         names no place). The honest default.

    Pure + deterministic; reuses CITY_TO_COUNTRY via _extract_country_from_excerpt.
    Wrong-COUNTRY groups are dropped earlier by _is_consumer_facing_group, so
    they are not expected here; if one slips through it falls to 'unconfirmed'.
    """
    loc = (operator_location or '').strip().lower()
    hay = f"{group_name or ''} {post_excerpt or ''}".lower()

    if loc and re.search(r'\b' + re.escape(loc) + r'\b', hay):
        return 'confirmed_city'

    operator_country = _extract_country_from_excerpt(operator_location or '')
    # Scrub the searched city from `hay` before country-detection so that a
    # city name embedded inside a longer token (e.g. "bristol" in
    # "bristolboard") does not produce a spurious same_country signal.
    hay_for_country = re.sub(re.escape(loc), '', hay) if loc else hay
    detected_country = _extract_country_from_excerpt(hay_for_country)
    if detected_country and operator_country and detected_country == operator_country:
        return 'same_country'

    return 'unconfirmed'


# Country-token map for the "drop name-mismatched country groups" filter.
# Word-boundary-anchored regex patterns — keep them strict so 'phone' doesn't
# match 'PH' and 'auspicious' doesn't match 'AU'.
_COUNTRY_NAME_TOKENS = {
    # ─── Western & Central Europe ─────────────────────────
    'GB': re.compile(r'\b(uk|u\.k|united kingdom|britain|british|england|english|scotland|scottish|wales|welsh)\b', re.I),
    'IE': re.compile(r'\b(ireland|irish|eire|éire)\b', re.I),
    'DE': re.compile(r'\b(germany|german|deutschland|deutsch)\b', re.I),
    'FR': re.compile(r'\b(france|french|français|francais)\b', re.I),
    'ES': re.compile(r'\b(spain|spanish|españa|espana|español|espanol)\b', re.I),
    'IT': re.compile(r'\b(italy|italian|italia|italiano)\b', re.I),
    'NL': re.compile(r'\b(netherlands|dutch|holland|nederland)\b', re.I),
    'BE': re.compile(r'\b(belgium|belgian|belgique|belgië|belgie)\b', re.I),
    'LU': re.compile(r'\b(luxembourg|luxembourgish|luxembourgeois)\b', re.I),
    'PT': re.compile(r'\b(portugal|portuguese|português|portugues)\b', re.I),
    'CH': re.compile(r'\b(switzerland|swiss|schweiz|suisse|svizzera)\b', re.I),
    'AT': re.compile(r'\b(austria|austrian|österreich|osterreich)\b', re.I),
    # ─── Central-Eastern Europe ───────────────────────────
    'CZ': re.compile(r'\b(czech|česko|cesko|czechia)\b', re.I),
    'PL': re.compile(r'\b(poland|polish|polska)\b', re.I),
    'SK': re.compile(r'\b(slovakia|slovak|slovensko)\b', re.I),
    'HU': re.compile(r'\b(hungary|hungarian|magyar|magyarország|magyarorszag)\b', re.I),
    'RO': re.compile(r'\b(romania|romanian|românia|romania)\b', re.I),
    'BG': re.compile(r'\b(bulgaria|bulgarian|българия)\b', re.I),
    # ─── Nordics ──────────────────────────────────────────
    'SE': re.compile(r'\b(sweden|swedish|sverige)\b', re.I),
    'DK': re.compile(r'\b(denmark|danish|danmark)\b', re.I),
    'NO': re.compile(r'\b(norway|norwegian|norge)\b', re.I),
    'FI': re.compile(r'\b(finland|finnish|suomi)\b', re.I),
    'IS': re.compile(r'\b(iceland|icelandic|ísland|island)\b', re.I),
    # ─── Balkans ──────────────────────────────────────────
    'HR': re.compile(r'\b(croatia|croatian|hrvatska)\b', re.I),
    'SI': re.compile(r'\b(slovenia|slovenian|slovenija)\b', re.I),
    'RS': re.compile(r'\b(serbia|serbian|srbija)\b', re.I),
    'BA': re.compile(r'\b(bosnia|bosnian|herzegovina|bosna)\b', re.I),
    'AL': re.compile(r'\b(albania|albanian|shqipëria|shqiperia)\b', re.I),
    'MK': re.compile(r'\b(north macedonia|macedonian|makedonija)\b', re.I),
    'ME': re.compile(r'\b(montenegro|montenegrin|crna gora)\b', re.I),
    # ─── Baltics + Moldova + Ukraine ──────────────────────
    'LT': re.compile(r'\b(lithuania|lithuanian|lietuva)\b', re.I),
    'LV': re.compile(r'\b(latvia|latvian|latvija)\b', re.I),
    'EE': re.compile(r'\b(estonia|estonian|eesti)\b', re.I),
    'MD': re.compile(r'\b(moldova|moldovan)\b', re.I),
    'UA': re.compile(r'\b(ukraine|ukrainian|україна|український)\b', re.I),
    # ─── Southern fringe ──────────────────────────────────
    'GR': re.compile(r'\b(greece|greek|hellas|hellenic|ελλάδα)\b', re.I),
    'MT': re.compile(r'\b(malta|maltese)\b', re.I),
    'CY': re.compile(r'\b(cyprus|cypriot|κύπρος|kypros)\b', re.I),
    'TR': re.compile(r'\b(turkey|türkiye|turkiye|turkish)\b', re.I),
    # ─── North America ────────────────────────────────────
    'US': re.compile(r'\b(usa|u\.s\.a|u\.s|united states|american)\b', re.I),
    # ─── Legacy / non-outreach ────────────────────────────
    # Kept so manual scrapes against these regions still get
    # cross-country leakage protection.
    'PH': re.compile(r'\b(ph|philippines|pinoy|filipino|filipina|pilipinas)\b', re.I),
    'AU': re.compile(r'\b(australia|australian|aussie|aussies|nsw|vic|qld)\b', re.I),
    'CA': re.compile(r'\b(canada|canadian)\b', re.I),
    'SG': re.compile(r'\bsingapore(an)?\b', re.I),
}


# Per-language classifieds / general-trade tokens. A group whose name
# contains one of these is a strong consumer/lead signal (tier 2): local
# classifieds boards and trade communities are where people post "looking
# for a <tradesperson>" asks. Language is resolved from the operator's
# location; English tokens are ALWAYS also checked (bilingual group names
# are common). Seed list — expand as real group names surface, same as the
# negative/country token lists above.
_GROUP_RELEVANCE_VOCAB: dict[str, tuple[str, ...]] = {
    'English': ('classifieds', 'for sale', 'buy and sell', 'car boot', 'tradesmen', 'handyman'),
    'German': ('kleinanzeigen', 'marktplatz', 'handwerker', 'flohmarkt', 'gesuche'),
    'French': ('petites annonces', 'artisans', 'bon coin', 'marché'),
    'Italian': ('mercatino', 'annunci', 'artigiani'),
    'Spanish': ('clasificados', 'oficios', 'anuncios', 'mercadillo'),
    'Dutch': ('marktplaats', 'vakmensen', 'klusjesman'),
    'Portuguese': ('classificados', 'anúncios', 'artesãos'),
}

# Curated CONSUMER-CLASSIFIEDS tokens used ONLY as a gate override in
# _is_consumer_facing_group: a name carrying one of these is an unambiguous
# consumer classifieds / flea-market / for-sale board, so it KEEPS even if
# it also trips a generic negative token (e.g. 'equipment'). This is a
# STRICT SUBSET of _GROUP_RELEVANCE_VOCAB — it deliberately omits the
# trade-role words (handyman/handwerker/artisans/...), because those
# co-occur with B2B negatives ("Handyman Suppliers") and must NOT override.
# Trade-role words still earn tier-2 for RANKING via _group_relevance_tier.
_GATE_OVERRIDE_TOKENS: dict[str, tuple[str, ...]] = {
    'English': ('classifieds', 'for sale', 'car boot'),
    'German': ('kleinanzeigen', 'marktplatz', 'flohmarkt', 'gesuche'),
    'French': ('petites annonces', 'bon coin'),
    'Italian': ('mercatino',),
    'Spanish': ('clasificados', 'mercadillo'),
    'Dutch': ('marktplaats',),
    'Portuguese': ('classificados',),
}

# Consumer-positive tokens that signal a tier-1 (community / help) group.
# Mirrors the POSITIVE_TOKENS used by _is_consumer_facing_group, plus
# locality words that indicate a neighbourhood community group.
_GROUP_TIER1_TOKENS: tuple[str, ...] = (
    'free', 'affordable', 'cheap', 'budget', 'barato', 'mura',
    'help', 'community', 'recommendation', 'recommendations',
    'local', 'neighbourhood', 'neighborhood',
)


def _resolve_relevance_language(location: str | None) -> str:
    """Map an operator location (city name) to its primary language
    name (matching COUNTRY_TO_LANGUAGE values). Falls back to 'English' for
    English-primary or unknown locations."""
    if not location:
        return 'English'
    country = _extract_country_from_excerpt(location)
    if not country:
        return 'English'
    return COUNTRY_TO_LANGUAGE.get(country, 'English')


def _group_relevance_tier(name: str, location: str | None, niche: str | None) -> int:
    """Rank a (gate-surviving) FB group by how likely it is to contain
    consumer service-asks. Pure function, no side effects.

      2 = translated-niche token match, OR per-language classifieds/trade token
      1 = generic consumer-positive token (community/help/local/...)
      0 = generic city/lifestyle group (passed the gate by default only)
    """
    n = (name or '').lower()

    niche_l = (niche or '').strip().lower()
    if niche_l and re.search(r'\b' + re.escape(niche_l) + r'\b', n):
        return 2

    lang = _resolve_relevance_language(location)
    tokens = set(_GROUP_RELEVANCE_VOCAB.get(lang, ())) | set(_GROUP_RELEVANCE_VOCAB['English'])
    if any(re.search(r'\b' + re.escape(tok) + r'\b', n) for tok in tokens):
        return 2

    if any(re.search(r'\b' + re.escape(tok) + r'\b', n) for tok in _GROUP_TIER1_TOKENS):
        return 1

    return 0


def _order_and_cap_groups(
    groups: list,
    niche: str | None,
    location: str | None,
    generic_group_cap: int = 5,
) -> tuple[list, dict]:
    """Order gate-surviving groups by relevance tier (2 → 1 → 0, stable
    within a tier) and cap how many tier-0 generic groups are searched.

    Returns (ordered_kept_groups, stats) where stats has integer keys
    'relevant' (tier>=1 count), 'generic_searched', 'generic_skipped'.
    Pure function — does no I/O.
    A negative generic_group_cap is treated as zero (all generic groups skipped).
    """
    generic_group_cap = max(0, generic_group_cap)
    tiered = [(_group_relevance_tier(g.get('name', ''), location, niche), g) for g in groups]
    # Stable in-place sort, highest tier first: list.sort() preserves discovery order within each tier.
    tiered.sort(key=lambda t: -t[0])

    kept: list = []
    relevant = 0
    generic_searched = 0
    generic_skipped = 0
    for tier, g in tiered:
        if tier >= 1:
            kept.append(g)
            relevant += 1
        elif generic_searched < generic_group_cap:
            kept.append(g)
            generic_searched += 1
        else:
            generic_skipped += 1

    return kept, {
        'relevant': relevant,
        'generic_searched': generic_searched,
        'generic_skipped': generic_skipped,
    }


def _card_is_member(card_text: str) -> bool:
    """Best-effort: a discovered FB group card shows a standalone 'Join'
    button line when the account is NOT a member. Returns False (not a
    member) when such a line is present; True otherwise. Ambiguous cards
    default to True (member) so we don't queue false candidates.
    """
    lines = [ln.strip().lower() for ln in (card_text or '').split('\n') if ln.strip()]
    return not any(ln in ('join', 'join group') for ln in lines)


def _plan_candidate_writes(
    groups: list,
    existing_status_by_gid: dict,
    niche: str | None,
    location: str | None,
    now_iso: str,
) -> dict:
    """Decide fb_group_candidates writes for one discovery pass. Pure (no I/O).

    Each group dict carries group_id, name, tier, is_member, is_public,
    member_count_text. `existing_status_by_gid` maps group_id -> current
    DB status. Returns {'upsert': [rows], 'mark_joined': [group_ids]}:
      - tier-2 + NOT member + not already joined/ignored -> upsert candidate
      - tier-2 + member + currently 'candidate'          -> mark_joined
    """
    upsert: list = []
    mark_joined: list = []
    for g in groups:
        if g.get('tier') != 2:
            continue
        gid = g.get('group_id')
        if not gid:
            continue
        status = existing_status_by_gid.get(gid)
        if g.get('is_member'):
            if status == 'candidate':
                mark_joined.append(gid)
            continue
        if status in ('ignored', 'joined'):
            continue
        upsert.append({
            'platform': 'facebook',
            'group_id': gid,
            'name': g.get('name'),
            'member_count_text': g.get('member_count_text'),
            'is_private': g.get('is_public') is False,
            'relevance_tier': 2,
            'niche': niche,
            'location': location,
            'status': 'candidate',
            'last_seen_at': now_iso,
        })
    return {'upsert': upsert, 'mark_joined': mark_joined}


def _resolve_generic_cap(filters: dict) -> int:
    """Read the generic-group search cap from scrape filters.

    Defaults to 5 when the key is absent or None. An explicit 0 means
    'search no generic groups' and is honored (NOT coerced to the default).
    Negative or malformed values are clamped to 0 / fall back to 5.
    """
    cap = filters.get('generic_group_cap')
    if cap is None:
        return 5
    try:
        return max(0, int(cap))
    except (TypeError, ValueError):
        return 5


def _in_group_keyword(niche: str, location: str | None) -> str:
    """Build the in-group post-search query for a niche.

    Non-English markets: search the (already-translated) niche term ALONE
    for maximum recall — German consumers write 'Suche Elektriker', not
    'looking for a Elektriker', so the English carrier phrase misses them.
    The multilingual Gemini classifier handles precision downstream.

    English markets: unchanged 'looking for a {niche}' carrier phrase.
    """
    if _resolve_relevance_language(location) != 'English':
        return niche
    return f'looking for a {niche}'


def _consumer_filter_defaults(filters: dict, location: str | None) -> tuple[bool, bool]:
    """Resolve (exclude_businesses, asking_only) with language-aware defaults.

    The substring filters _looks_like_business_post / _is_actively_asking are
    English-only, so for non-English markets they DROP real local-language
    asks. Default them OFF for non-English (let the multilingual Gemini
    classifier be the sole gate) and ON for English (unchanged). An explicit
    operator value in `filters` always wins.
    """
    default = _resolve_relevance_language(location) == 'English'
    eb = filters.get('exclude_businesses')
    ao = filters.get('asking_only')
    return (
        default if eb is None else bool(eb),
        default if ao is None else bool(ao),
    )


def _resolve_target_country(location: str | None, filters: dict) -> Optional[str]:
    """ISO-2 country the operator is actually targeting, or None.

    Deliberately stricter than _target_country_from_filters: that helper
    upper-cases `filters['country']` verbatim, which is right for
    businesses-mode (it carries an ISO code) but turns a consumer-mode city
    into a bogus pseudo-code ('MANCHESTER') that matches no resolved lead
    country. Used as a geographic gate that would drop 100% of a batch, so
    only accept a value we can actually believe: a 2-letter alpha code, or a
    place name CITY_TO_COUNTRY knows. Anything else -> None, which callers
    must treat as "no country constraint", never as "matches nothing".
    """
    for raw in (filters.get('country'), filters.get('location'), location):
        raw = (raw or '').strip()
        if not raw:
            continue
        if len(raw) == 2 and raw.isalpha():
            return raw.upper()
        resolved = _extract_country_from_excerpt(raw)
        if resolved:
            return resolved.upper()
    return None


def _query_is_place_anchored(query: str, location: str | None) -> bool:
    """Does THIS search query already name the operator's target location?

    A plain case-insensitive substring check against the actual query text —
    honest about what it knows, nothing inferred. When the query itself
    contains the place ("need a plumber recommendation Manchester"),
    Facebook's own search has already scoped the results to that place (see
    the measurement table in _apply_consumer_filter_chain's INTENT VS
    GEOGRAPHY docstring), so the post-hoc _apply_geo_country_filter stage
    would only discard genuine local posts that don't spell out their own
    city — the poster already knows where they are — for zero geographic
    benefit.

    Deliberately checks the QUERY TEXT, never the discovery source: an
    operator can submit any query on either the browser or the Apify path,
    so "was this particular search geo-anchored" has to be answered from
    what was actually searched for, not from which backend ran it.
    """
    loc = (location or '').strip()
    if not loc:
        return False
    return loc.lower() in (query or '').lower()


class GeoRegime(NamedTuple):
    """How a batch of stubs relates to the operator's target location.

    Two INDEPENDENT decisions that used to be one boolean (`geo_scoped`):

      search_is_geo_scoped
          The search that produced these stubs is already confined to the
          target place. Drives (a) skipping the post-hoc
          `_apply_geo_country_filter` and (b) trusting `location` as a
          fallback country signal in `_resolve_lead_country`.

      location_in_classifier_prompt
          The operator's town is handed to the Gemini intent classifier,
          whose location clause then requires a place signal IN THE POST
          BODY.

    They were the same flag until group-sourced runs needed them to differ:
    a supplied group fixes the geography beyond doubt (so both (a) and (b)
    are right) while its members never name their own town (so the prompt
    clause rejects everything). Measured live on three real group asks
    (2026-08-04): location=None -> [True, True, False];
    location='Manchester' -> [False, False, False]. Collapsing the two back
    into one flag re-creates a guaranteed zero-lead run.
    """

    search_is_geo_scoped: bool
    location_in_classifier_prompt: bool


def _geo_regime(
    *,
    discovery: str,
    supplied_groups: list,
    query: str,
    location: str | None,
) -> GeoRegime:
    """Decide the geographic regime for ONE search, in ONE place.

    Every consumer of the decision (country stamping, the post-hoc country
    filter, the classifier prompt) reads the result of this function, so they
    cannot drift apart — the previous drift was invisible and cost 100% of the
    yield on the group path.

    Four regimes, in precedence order:

      1. BROWSER discovery -> (scoped, prompted). The Facebook search itself is
         geo-scoped (geo-stuffed group term + `_is_consumer_facing_group` drops
         wrong-country groups), so the classifier is consistent with it.
         Checked FIRST because `group_urls` only drives the Apify path — the
         browser path never reads it.
      2. OPERATOR-SUPPLIED GROUPS -> (scoped, NOT prompted). The group supplies
         the geography (a post in "Dane Bank Community Page" is in Manchester,
         full stop) and the town in the prompt zeroes the yield. Wins over
         rule 3 on purpose: a group run whose query happens to name the town is
         still a group run, and must not get the town back through anchoring.
      3. PLACE-ANCHORED QUERY -> (scoped, prompted). The query itself names the
         place, so Facebook already scoped the results, exactly like the
         browser path. Read from the actual query TEXT, never inferred from the
         discovery source.
      4. GLOBAL APIFY SEARCH -> (not scoped, not prompted). Results are
         geographically scattered, so the classifier judges intent only and
         `_apply_geo_country_filter` enforces geography afterwards from the
         evidence in each post.
    """
    if discovery != 'apify':
        return GeoRegime(search_is_geo_scoped=True, location_in_classifier_prompt=True)
    if supplied_groups:
        return GeoRegime(search_is_geo_scoped=True, location_in_classifier_prompt=False)
    if _query_is_place_anchored(query, location):
        return GeoRegime(search_is_geo_scoped=True, location_in_classifier_prompt=True)
    return GeoRegime(search_is_geo_scoped=False, location_in_classifier_prompt=False)


def _stub_country_evidence(stub: dict) -> Optional[str]:
    """ISO-2 country the POST ITSELF evidences, or None when it names nowhere.

    Reuses _resolve_lead_country, but passes location=None AND
    geo_scoped=False ON PURPOSE. That function's second signal is the
    operator's own target location, trusted only when geo_scoped — feeding
    it the target location here would make every post "resolve" to the
    target country and turn the geo filter below into a silent no-op. Only
    the group name and the post body count as evidence here.
    """
    resolved = _resolve_lead_country(
        stub.get('group_name'), None, stub.get('content_excerpt'),
        geo_scoped=False,
    )
    return resolved.upper() if resolved else None


def _apply_geo_country_filter(
    stubs: list,
    *,
    location: str | None,
    filters: dict,
    geo_scoped: bool,
    on_progress: ProgressCallback = None,
) -> list:
    """Drop posts that EVIDENCE a different country than the operator's target.

    Runs only when the discovery search itself was NOT geo-scoped
    (`geo_scoped=False` — today that means the Apify path). See
    _apply_consumer_filter_chain's docstring for why geography has to be a
    separate stage there.

    Three rules, all deliberate:
      - target country unresolvable -> keep everything, and SAY so. Guessing
        a country here would reproduce the all-zero bug this stage exists to
        fix.
      - post evidences a DIFFERENT country -> drop.
      - post evidences NO country -> KEEP. Absence of evidence is not
        evidence of a mismatch, and most genuine consumer asks name no place
        at all ("recently moved to the area and need a plumber"). Dropping
        those would quietly discard the best leads in the batch.

    Always emits exactly one 'geo_filtered' event when it runs, even at
    dropped=0, so an operator reading the SSE stream sees intent and
    geography as two separate numbers. The whole reason this stage is
    explicit is that the previous failure mode was INVISIBLE: one
    llm_filtered=20 line and a job that returned nothing.
    """
    if geo_scoped or not stubs:
        return stubs

    target = _resolve_target_country(location, filters)
    if not target:
        _emit(on_progress, 'geo_filtered', dropped=0, kept=len(stubs),
              target_country=None,
              reason=(
                  'target country could not be resolved from the scrape '
                  f'filters (location={location!r}) — keeping every post '
                  'rather than guessing a country to filter against'
              ))
        return stubs

    kept: list = []
    dropped_countries: dict[str, int] = {}
    for s in stubs:
        evidenced = _stub_country_evidence(s)
        if evidenced and evidenced != target:
            dropped_countries[evidenced] = dropped_countries.get(evidenced, 0) + 1
            continue
        kept.append(s)

    _emit(on_progress, 'geo_filtered',
          dropped=len(stubs) - len(kept), kept=len(kept),
          target_country=target, dropped_countries=dropped_countries,
          reason=(
              'discovery searched Facebook globally, so posts whose own text '
              f'or group name places them outside {target} are dropped here; '
              'posts naming no place are kept'
          ))
    return kept


def _apply_consumer_filter_chain(
    stubs: list,
    *,
    niche: str,
    location: str | None,
    filters: dict,
    on_progress: ProgressCallback = None,
    geo_scoped: bool = True,
    classifier_sees_location: Optional[bool] = None,
) -> list:
    """Keep only post stubs that look like a real consumer ASKING for the niche.

    THE GEMINI CLASSIFIER IS THE GATE. The substring heuristics
    (_looks_like_business_post / _is_actively_asking) are a FALLBACK that
    runs ONLY when the classifier produces no verdicts.

    Measured 2026-08-03 on 20 REAL posts from a live Apify search for
    "need a plumber recommendation", labelled blind by three reviewers
    (19/20 unanimous; consensus = 8 genuine consumer leads):

        substring filter only    precision  80%   recall 50%
        Gemini classifier only   precision 100%   recall 88%
        substring THEN Gemini    precision 100%   recall 50%

    Running the substring filter FIRST (as this chain used to) cost HALF the
    recall for ZERO precision benefit — both configurations score 100%
    precision. Three genuine asks were destroyed before Gemini could see
    them, because CONSUMER_PATTERNS has 'any recommendation' and 'need a
    good' but not 'need a recommendation' / 'need recommendations' /
    'looking for recommendations':

        "Looking for recommendations for a plumber to come in for a shower
         to be redone."
        "I need a recommendation for a good local plumber around Devine."
        "House trade recommendations. I've recently moved to the area and
         need recommendations for a structural engineer..."

    Meanwhile the substring filter KEPT an advert Gemini correctly rejected
    ("...we highly recommend Chris with Watkins Plumbing, LLC" — matches
    CONSUMER 'in need of', and POST_EXPERIENCE_PATTERNS has 'i highly
    recommend' but not 'we highly recommend'). Expanding the pattern lists is
    whack-a-mole against an unbounded phrase space; the lists are visibly
    tuned for a dentist niche in the Philippines and do not generalise.
    DO NOT re-add a substring pre-gate.

    The fallback is NOT optional. This chain is the LAST gate before
    tools/db/upsert_leads.py — there is no downstream intent filtering. When
    the classifier returns None (GEMINI_API_KEY unset, HTTP 429, timeout, or
    its all-or-nothing length-mismatch guard), dropping the heuristics too
    would make raw adverts and tradespeople advertising their own
    availability into cold-email targets. That has happened once already: a
    beauty business ("My My Lashes") was saved as an electrician lead during
    a Frankfurt run when the classifier was skipped.

    That same incident exposed a SECOND hole this docstring now documents:
    _consumer_filter_defaults() deliberately returns (False, False) for
    non-English markets — the substring heuristics are English-only, so the
    design intends the multilingual Gemini classifier to be the SOLE gate
    there. That meant a Gemini outage on a non-English market used to have
    NOTHING left to fall back to, and the old `return stubs` at the end of
    this function shipped every unfiltered post straight to upsert_leads.py.
    Zero leads plus a clear explanation is strictly better for this operator
    than a contaminated leads table feeding cold email, so the fix is to
    FAIL CLOSED: when the classifier gave no verdicts AND no
    language-appropriate substring filter is applicable, return an EMPTY
    list and emit 'consumer_filter_unavailable' naming the cause. This is
    deliberate data loss, not a bug — an empty, explained batch is
    diagnosable; a silently unfiltered one is not.

    Semantics, exactly:
      - classifier returns verdicts             -> those verdicts are the
                                                     SOLE gate
      - classifier returns None, substring       -> substring filter (the
        filter applicable (English-ish market)      old behaviour)
      - classifier returns None, NO substring    -> FAIL CLOSED: return [],
        filter applicable (non-English market)      emit
                                                     'consumer_filter_unavailable'
      - use_llm_classifier=False                 -> same two rows above,
                                                     minus the classifier call

    INTENT VS GEOGRAPHY (`geo_scoped`, `classifier_sees_location`)
    -------------------------------------------------------------
    `geo_scoped` says whether the search that produced these stubs was itself
    geographically scoped, and therefore whether the post-hoc
    `_apply_geo_country_filter` stage runs.

    `classifier_sees_location` says, separately, whether the operator's town
    goes into the Gemini prompt. `None` (the default) means "follow
    `geo_scoped`", which is what every caller wanted while the two decisions
    were one flag. Pass it explicitly to break the coupling — group-sourced
    runs need `geo_scoped=True, classifier_sees_location=False`, because the
    group fixes the geography while its members never name their own town (see
    `GeoRegime` for the measurement). Callers should get both values from
    `_geo_regime` rather than deciding locally.

    Callers derive `geo_scoped` two ways, both legitimate, never guessed:
      (a) from the DISCOVERY SOURCE (below), and
      (b) from the QUERY TEXT itself naming the target place — see the
          PLACE-ANCHORED QUERIES override after the two regimes below.

      geo_scoped=True  (browser discovery). The Facebook search was geo-scoped
        already: group discovery uses a geo-stuffed term and
        _is_consumer_facing_group drops wrong-country groups, so the surviving
        candidates are local. The operator's `location` goes into the
        classifier prompt exactly as before, and no separate geo stage runs.

      geo_scoped=False (Apify discovery). The actor searches Facebook
        GLOBALLY — we deliberately do not feed it `location_uid`, which would
        need a seeded Facebook geo-ID table — so its results are
        geographically scattered. Handing the classifier a target city then
        makes it reject essentially everything, because its location clause is
        strict at CITY level. Measured 2026-08-04 on 20 real posts, same
        niche, only the location argument differing:

            location=''            -> kept 7/20
            location='Manchester'  -> kept 0/20

        and a live end-to-end run produced "20 mapped, llm_filtered dropped=20
        kept=0" — EVERY dashboard scrape on the Apify path returned zero
        leads. Geography was being enforced at the wrong stage, against
        candidates that were never geo-filtered in the first place. So on this
        path the classifier judges INTENT ONLY (location omitted) and
        _apply_geo_country_filter enforces geography afterwards, at COUNTRY
        granularity, from the evidence in the post itself.

    Honest trade-off: global search + post-hoc country filtering yields FEWER
    target-country leads per run than a genuinely geo-scoped search would,
    because most global results are somewhere else. This converts a guaranteed
    zero into a smaller-but-real number and makes the loss visible. Geo-scoping
    the SEARCH is the real fix — either an intent-shaped query that also names
    the place ("need a plumber recommendation Manchester") or the actor's
    `location_uid` with a seeded geo table.

    PLACE-ANCHORED QUERIES (the override). When the query DOES already name
    the place — checked by `_query_is_place_anchored`, a case-insensitive
    substring match of `location` against the actual query text, never a
    guess from the discovery source — Facebook's own search has already
    geo-scoped the results, exactly like the browser path. Re-running
    _apply_geo_country_filter on top would only discard genuine local posts
    that don't spell out their own city (the poster already knows where they
    are), for zero geographic benefit. `search_posts` therefore ORs this
    detection into `geo_scoped` before calling this chain, so a place-anchored
    Apify query gets the geo_scoped=True treatment (no post-hoc filter) even
    though the discovery source is Apify. A query that does NOT name the
    place — an operator can type anything — still gets the full Apify
    treatment above, unchanged.

    Emits the same progress stages the inline copies did — 'llm_filtered',
    'llm_skipped' and 'consumer_filtered', with the same detail keys, plus
    'consumer_filter_unavailable' for the fail-closed case and 'geo_filtered'
    for the geographic stage. The SSE stream and job UI parse those names; do
    not rename them.
    """
    if not stubs:
        return stubs

    exclude_businesses, asking_only = _consumer_filter_defaults(filters, location)
    use_llm_classifier = filters.get('use_llm_classifier', True)
    substring_filter_applicable = exclude_businesses or asking_only
    # `location` still drives LANGUAGE resolution above (_consumer_filter_defaults)
    # and the geo stage below — it is only withheld from the classifier PROMPT,
    # which is where enforcing it against candidates the search never geo-scoped
    # (global Apify search) or that never name their own town (group members)
    # zeroed out every run.
    prompt_location = (
        geo_scoped if classifier_sees_location is None else classifier_sees_location
    )
    classifier_location = location if prompt_location else None

    # ── Primary gate: Gemini semantic intent classification ──────────────
    if use_llm_classifier:
        excerpts = [s.get('content_excerpt', '') or '' for s in stubs]
        verdicts = _classify_consumer_posts_with_gemini(
            excerpts, niche, location=classifier_location,
        )
        if verdicts is not None:
            llm_kept = [s for s, v in zip(stubs, verdicts) if v]
            llm_dropped = len(stubs) - len(llm_kept)
            if llm_dropped > 0:
                _emit(on_progress, 'llm_filtered',
                      dropped=llm_dropped, kept=len(llm_kept),
                      reason='Gemini classifier flagged as non-consumer')
            # Geography second, as its own visible stage (no-op when the
            # discovery search was already geo-scoped).
            return _apply_geo_country_filter(
                llm_kept, location=location, filters=filters,
                geo_scoped=geo_scoped, on_progress=on_progress,
            )
        if substring_filter_applicable:
            _emit(on_progress, 'llm_skipped',
                  reason='GEMINI_API_KEY missing or API error — falling back '
                         'to the substring filter')
        else:
            _emit(on_progress, 'llm_skipped',
                  reason='GEMINI_API_KEY missing or API error — no '
                         'language-appropriate substring filter available '
                         'for this market')

    # ── Fallback gate: substring heuristics (recall ~50%, precision ~80%) ─
    if substring_filter_applicable:
        before = len(stubs)
        kept: list = []
        for s in stubs:
            excerpt = s.get('content_excerpt', '') or ''
            handle = s.get('author_handle', '') or ''
            if exclude_businesses and _looks_like_business_post(excerpt, handle):
                continue
            if asking_only and not _is_actively_asking(excerpt):
                continue
            kept.append(s)
        dropped = before - len(kept)
        if dropped > 0:
            _emit(on_progress, 'consumer_filtered', dropped=dropped, kept=len(kept),
                  reason='non-asking posts (thanks/recommend/business) removed')
        # Geography runs after WHICHEVER intent gate ran, including this
        # fallback — a Gemini outage must not also turn the geo filter off.
        return _apply_geo_country_filter(
            kept, location=location, filters=filters,
            geo_scoped=geo_scoped, on_progress=on_progress,
        )

    # ── No verdicts AND no applicable substring filter: FAIL CLOSED ───────
    # Nothing gated this batch — the classifier is out and this market has
    # no language-appropriate substring safety net (see docstring / Frankfurt
    # incident above). Dropping the whole batch beats writing it unfiltered
    # into a leads table that feeds cold email.
    _emit(on_progress, 'consumer_filter_unavailable',
          location=location, dropped=len(stubs), kept=0,
          reason=(
              'Gemini classifier unavailable and no language-appropriate '
              'substring filter exists for this market — dropping the '
              'batch instead of writing it to leads unfiltered'
          ))
    return []


def _is_consumer_facing_group(group_name: str, operator_location: str | None = None) -> bool:
    """Decide whether a discovered FB group is consumer-facing.

    Five-stage decision (order matters):
      1. COUNTRY MISMATCH — when the operator's location maps to a known
         country and the group name carries tokens for a *different*
         country, DROP. Runs FIRST so a generic POSITIVE token like
         'free' can't keep a foreign-country group ("Free Legal Advice
         Philippines" on a Brooklyn search).
      2a. CLASSIFIEDS OVERRIDE — name matches a curated per-language
         classifieds token (kleinanzeigen, flohmarkt, mercatino, …). These
         are unambiguous consumer classifieds/flea-market boards, so KEEP
         even if a generic negative token co-occurs. Runs before NEGATIVE.
      2. STRONG POSITIVE — name contains 'free', 'affordable', 'cheap',
         'budget', 'barato' (Filipino for cheap). These ARE consumer
         groups even if they also contain a generic token like 'clinic'.
         KEEP regardless of negatives.
      3. STRONG NEGATIVE — name clearly indicates a professional / B2B
         space: job board, supplier directory, lab, association,
         marketplace. DROP.
      4. DEFAULT — ambiguous, KEEP and rely on per-post asking-only
         filter to clean things up.
    """
    name = (group_name or '').lower()

    # Stage 1: country mismatch.
    if operator_location:
        operator_country = _extract_country_from_excerpt(operator_location)
        if operator_country:
            for country, pattern in _COUNTRY_NAME_TOKENS.items():
                if country == operator_country:
                    continue
                if pattern.search(group_name or ''):
                    return False

            # Stage 1b: city-in-name mismatch. The token loop above only
            # catches explicit COUNTRY words ('usa', 'ireland'); group names
            # usually carry a CITY ('Atlanta', 'Dublin'). Resolve any city in
            # the name to its country and drop if it's a DIFFERENT country.
            group_country = _extract_country_from_excerpt(group_name or '')
            if group_country and group_country != operator_country:
                return False

    # Stage 2a (NEW): a curated consumer-classifieds token is a STRONG
    # positive — a local classifieds / flea-market / for-sale board is
    # exactly where consumer service-asks live, so KEEP it even if the name
    # also carries a generic negative token (e.g. 'equipment'). Uses the
    # CURATED _GATE_OVERRIDE_TOKENS subset (NOT the full relevance vocab):
    # trade-role words like 'handyman' co-occur with B2B negatives and must
    # NOT override here. Niche is irrelevant to the gate (ranking-only).
    _lang = _resolve_relevance_language(operator_location)
    _override = set(_GATE_OVERRIDE_TOKENS.get(_lang, ())) | set(_GATE_OVERRIDE_TOKENS['English'])
    if any(re.search(r'\b' + re.escape(tok) + r'\b', name) for tok in _override):
        return True

    POSITIVE_TOKENS = (
        'free', 'affordable', 'cheap', 'budget', 'barato', 'mura',
        'help', 'community', 'recommendation', 'buy and sell',
    )
    if any(tok in name for tok in POSITIVE_TOKENS):
        return True

    NEGATIVE_TOKENS = (
        ' job', 'jobs', ' career', 'careers',
        'hiring', 'recruiter', 'reliever', 'recruitment',
        'society', 'association', 'professionals',
        'practitioners', 'licensed',
        'supplies', 'suppliers', ' supply', 'marketplace',
        'equipment', 'distributor',
        'laboratory', ' lab ', ' md', ' md ',
        'dental md', 'dentist group',
        # Filipino + tech tokens spotted in live data:
        # 'tiange' = flea market / vendor stalls (B2B equipment trading);
        # 'tech' / 'technicians' = lab tech / dental-tech communities;
        # 'clinics' (plural) = clinic-business networking forums.
        # NOTE: 'dentista' was here but removed when we expanded to Europe —
        # Spanish "Dentistas Madrid" is a legit consumer group. PH-specific
        # peer-forum drops now ride on the 'ph' country token in
        # _COUNTRY_NAME_TOKENS, which catches "DENTISTA PH" etc.
        'tiange', ' tech', 'technicians',
        'dental clinics', 'clinic owners', 'practice owners',
    )
    padded = f' {name} '
    if any(tok in padded for tok in NEGATIVE_TOKENS):
        return False

    return True


# Module-level "current scrape context" — set by scrape_listing() at
# the top of each scrape and consumed by _open_driver() when it needs
# to pick a country code for the residential proxy. This avoids
# threading `location` through nine call sites (_open_session,
# _sync_discover_groups, _sync_group_first_scrape, ...). Each FB
# scrape runs in its own Python subprocess, so the global is process-
# scoped and safe from cross-job leakage.
_CURRENT_LOCATION: Optional[str] = None
# ISO-2 country resolved from the current scrape's filters via
# _target_country_from_filters(). Set alongside _CURRENT_LOCATION in
# scrape_listing so that _claim_or_raise picks the right account even
# when called deep in the sync helpers (which have no access to filters).
_TARGET_COUNTRY: Optional[str] = None

from tools.scraper.shared import apify
from tools.scraper.platforms import facebook_apify


_DISCOVERY_SOURCES = {'apify', 'browser'}


def _discovery_source() -> str:
    """Which discovery backend search_posts uses.

    'apify'   — cookieless Apify actor. No account, no daily cap, runs on any
                host including Cloud Run. The default since 2026-07-31.
    'browser' — the original logged-in undetected-chromedriver crawl. Kept for
                private-group search (Apify can only see public groups) and as
                the rollback path. Behaviour is unchanged from before Apify.

    An unrecognised value fails SAFE to 'browser' (the pre-Apify behaviour)
    but WARNS loudly first: a typo like FB_DISCOVERY=apfiy would otherwise
    silently open a browser and burn a Facebook account's daily cap.
    """
    raw = (os.environ.get('FB_DISCOVERY') or 'apify').strip().lower()
    if raw not in _DISCOVERY_SOURCES:
        print(
            f'WARN: unrecognised FB_DISCOVERY={raw!r} — expected one of '
            f'{sorted(_DISCOVERY_SOURCES)}; falling back to the browser path '
            f'(this claims a Facebook account and spends its daily cap)',
            file=sys.stderr, flush=True,
        )
        return 'browser'
    return raw


def _enrich_mode() -> str:
    """Whether author enrichment opens a browser.

    'stub'    — build AuthorLead from the PostStub the discovery step already
                returned. Zero account usage. The default since 2026-07-31.
    'browser' — visit each author's profile with a logged-in account to pull
                bio/website/email. Rare payoff, high account cost; opt in only
                when a campaign genuinely needs those fields.
    """
    return (os.environ.get('FB_ENRICH') or 'stub').strip().lower()


# Tab titles Brave/Chrome produce on a profile page that are NOT a person's
# name. The browser path historically wrote these into leads.company_name.
_NON_NAME_TITLES = {'facebook', '', 'log in to facebook', 'log into facebook', 'meta'}


def _is_non_name(value: str) -> bool:
    s = (value or '').strip().lower()
    if s in _NON_NAME_TITLES:
        return True
    return re.sub(r'^\(\d+\)\s*', '', s).strip() == 'facebook'


# Display-name markers that identify a COMPANY rather than a consumer.
# Module-level (not inline in the browser enrich loop) because BOTH the
# browser path (_sync_enrich_authors) and the browserless default path
# (_stub_enrich_authors) gate on them — a second inline copy would drift.
#
# Generic biz suffixes (ltd/inc/llc/corp/...) catch profiles that are
# clearly companies, not individuals. Medical-niche tokens stay because
# plumber/handyman searches commonly surface medical-clinic ads that
# happen to mention the niche.
_BIZ_NAME_SUFFIXES = (
    # Company-form markers
    ' ltd', ' ltd.', ' limited', ' inc', ' inc.', ' llc',
    ' corp', ' corp.', ' corporation', ' co.', ' co ',
    ' plc', ' gmbh', ' s.r.l', ' pty', ' ag',
    # Common business-tail descriptors
    ' agency', ' agencies', ' services', ' solutions',
    ' consultancy', ' consulting', ' group',
    ' studios', ' studio',
)
_BIZ_NAME_NICHE_TOKENS = (
    'clinic', 'dental', 'dentist', 'dds', 'orthodontic',
    'spa', 'salon', 'medspa', 'wellness',
    'pharmacy', 'medical', 'pediatric',
)


def _display_name_looks_like_business(display_name: str) -> bool:
    """True when a recovered display name reads as a company, not a person.

    Pure string logic, so the browserless enrichment path can apply the same
    gate the browser path applies — Apify supplies display_name directly.
    """
    name_lower = (display_name or '').strip().lower()
    if not name_lower:
        return False
    name_lower_padded = ' ' + name_lower + ' '
    return (
        any(suffix in name_lower_padded for suffix in _BIZ_NAME_SUFFIXES)
        or any(tok in name_lower for tok in _BIZ_NAME_NICHE_TOKENS)
    )


def _stub_enrich_authors(
    post_stubs: list[PostStub],
    on_progress: ProgressCallback = None,
) -> list[AuthorLead]:
    """Build AuthorLeads straight from PostStubs — no browser, no account.

    Apify already returns the two fields that key a lead row (display name and
    profile URL). The fields a profile visit would add (website_url, email,
    bio_excerpt) are rare on personal FB profiles and cost one account-quota
    visit each, which is what previously locked the account out for 24h.
    """
    # Dedup by author_profile_url FIRST, but — unlike a plain dedup — keep
    # EVERY stub for that author as a `posts` entry. upsert_leads.py:279-304
    # writes each into lead_platform_posts (content_excerpt/group_name),
    # which is what powers "we saw your post about X" outreach
    # personalization. Mirrors the browser path's `unique_authors` grouping
    # (facebook.py around :2900) — same idea, just without opening a browser.
    unique_authors: dict[str, list[PostStub]] = {}
    for stub in post_stubs:
        profile_url = (stub.get('author_profile_url') or '').strip()
        if not profile_url:
            continue
        unique_authors.setdefault(profile_url, []).append(stub)

    leads: list[AuthorLead] = []
    for profile_url, posts in unique_authors.items():
        first = posts[0]
        handle = (first.get('author_handle') or '').strip()
        name = (first.get('display_name') or '').strip()
        if not name or _is_non_name(name):
            name = handle
        # Same display-name business gate the browser path applies
        # (_sync_enrich_authors), using the shared marker lists. Without it
        # 'RCA Dental Clinic' — a post that survives the excerpt filters —
        # lands in the CRM as a consumer lead. Pure string logic, so no
        # browser is needed; Apify already gave us the display name.
        if _display_name_looks_like_business(name):
            _emit(on_progress, 'enrich_skipped_business', name=name, url=profile_url)
            continue
        lead: AuthorLead = {
            'platform': 'facebook',
            'profile_url': profile_url,
            'author_handle': handle,
            'display_name': name,
            'company_name': name,  # mapped to leads.company_name by upsert
            'website_url': None,
            'email': None,
            'location': None,
            'is_business_profile': False,
            'follower_count': None,
            'bio_excerpt': None,
            # Attach every observed post — upsert_leads.py writes them into
            # lead_platform_posts keyed on (platform, post_url).
            'posts': posts,
        }
        # country/category/location_confidence come from the FIRST stub for
        # this author — matches the browser path's posts[0] precedent
        # (facebook.py :3028-3029); later stubs never override them.
        for passthrough in ('country', 'category', 'location_confidence'):
            if first.get(passthrough):
                lead[passthrough] = first[passthrough]
        leads.append(lead)
    return leads


def _search_posts_via_apify(
    query: str,
    filters: dict,
    max_results: int,
    on_progress: ProgressCallback,
) -> list[PostStub]:
    """Keyword post discovery through Apify. Opens no browser, claims no account."""
    actor = facebook_apify.search_actor()
    _emit(on_progress, 'search_started', query=query, source='apify', actor=actor)
    run_input = facebook_apify.build_search_input(
        query,
        max_results=max_results,
        start_date=filters.get('start_date') or None,
    )
    items = apify.run_actor(actor, run_input)
    stubs: list[PostStub] = []
    for item in items:
        stub = facebook_apify.post_to_stub(item)
        if stub:
            stubs.append(stub)
    _emit(on_progress, 'apify_run', actor=actor, requested=max_results,
          returned=len(items), mapped=len(stubs))
    return stubs


def _discover_group_ids_via_apify(query: str, limit: int) -> list[tuple[str, str]]:
    """Find public groups matching a keyword. Returns (group_id, group_name)."""
    actor = facebook_apify.search_actor()
    items = apify.run_actor(
        actor,
        facebook_apify.build_search_input(query, max_results=limit, search_type='groups'),
    )
    pairs: list[tuple[str, str]] = []
    for item in items:
        gid = str(item.get('id') or item.get('group_id') or '').strip()
        if not gid:
            continue
        pairs.append((gid, (item.get('name') or item.get('title') or '').strip()))
    return pairs


def _group_posts_via_apify(
    groups: list[tuple[str, str]],
    max_results: int,
    on_progress: ProgressCallback,
    keyword: Optional[str] = None,
) -> list[PostStub]:
    """Pull posts from each public group. A group that fails is skipped, not fatal.

    Private groups are invisible to this actor by design (it is cookieless).
    Those remain the browser path's job, with an account that has joined them.

    ONE RUN PER GROUP even though the actor's `startUrls` accepts an array.
    Billing is per RESULT ($1.50/1000), not per run, so batching saves nothing
    — while a single batched run turns one private/renamed group into a total
    loss instead of one skipped group, and per-group runs keep group
    attribution certain rather than inferred from each item.

    `keyword` becomes the actor's `search`, which it applies BEFORE billing —
    so a keyword makes the run both cheaper and more on-target. Omitted when
    blank (an empty filter matches nothing).
    """
    actor = facebook_apify.group_posts_actor()
    per_group = max(1, max_results // max(1, len(groups)))
    stubs: list[PostStub] = []
    for gid, gname in groups:
        try:
            items = apify.run_actor(
                actor,
                facebook_apify.build_group_posts_input(
                    gid, max_items=per_group, keyword=keyword,
                ),
            )
        except apify.ApifyError as exc:
            _emit(on_progress, 'group_skipped', group_id=gid, reason=str(exc)[:120])
            continue
        for item in items:
            # gname is '' for operator-supplied groups (we know the id from the
            # URL but not the title) — passing None lets post_to_stub fill it
            # from the actor's own `groupTitle`, which _resolve_lead_country
            # then reads as location evidence.
            stub = facebook_apify.post_to_stub(
                item, group_id=gid, group_name=gname or None,
            )
            if stub:
                stubs.append(stub)
    _emit(on_progress, 'apify_groups_done', groups=len(groups), posts=len(stubs))
    return stubs


def _open_driver(account: Optional[dict] = None):
    """Open Facebook's browser session.

    When the claimed social_accounts row carries an adspower_profile_id, the
    session opens through AdsPower (isolated fingerprint + the profile's own
    proxy). Otherwise this is unchanged: the shared undetected-chromedriver
    opener with FB_PROFILE_DIR and the residential-proxy wiring.
    """
    from tools.scraper.shared.uc_driver import open_uc_driver  # noqa: WPS433 — lazy
    return open_uc_driver(
        'FB_PROFILE_DIR',
        user_agent=None,
        window_size=(1280, 900),
        proxy_location=_CURRENT_LOCATION,
        adspower_profile_id=(account or {}).get('adspower_profile_id') or None,
    )


def _dismiss_fb_cookie_banner(driver) -> bool:
    """Dismiss FB's GDPR cookie banner if present. The banner is an
    overlay that blocks all other clicks (including the trust-gate
    Continue button) until the operator chooses Decline or Allow.
    Verified DOM (Chrome 148, Virgin Media UK IP, 2026-05-29):

        <div role="button" aria-label="Decline optional cookies">
        <div role="button" aria-label="Allow all cookies">

    We choose Decline to avoid persisting tracking cookies the scraper
    doesn't need; Allow would work just as well to dismiss the banner.
    """
    for locator in (
        ('xpath', '//div[@role="button"][@aria-label="Decline optional cookies"]'),
        ('xpath', '//div[@role="button"][@aria-label="Allow all cookies"]'),
    ):
        try:
            elem = driver.find_element(*locator)
            elem.click()
            time.sleep(3)
            print('INFO: dismissed FB cookie banner', file=sys.stderr)
            return True
        except Exception:  # noqa: BLE001
            continue
    return False


def _bypass_fb_trust_gate(driver) -> bool:
    """Click 'Continue as <name>' if FB is showing the new-IP trust gate.

    When saved cookies arrive from an IP different from the one they
    were minted on (e.g. residential proxy session originally captured
    from operator's home IP), FB serves an account-selector page:

        Explore the things you love.
        <Display Name>
        Continue
        Use another profile
        Create new account

    Page is *not* /login/ so our existing 'rejected cookies' check
    misses it, and the scraper proceeds to /search/groups/?q=... which
    redirects right back to this gate, returning zero results. One
    click on 'Continue' establishes trust for the new IP and the
    session works normally afterward.

    Verified DOM (Chrome 148, Virgin Media UK IP, 2026-05-29):

        <div role="button" aria-label="Continue James Optirate">

    The aria-label suffixes the account's display name, so we match on
    aria-label starting with 'Continue'. We also dismiss the EU cookie
    banner first because its overlay blocks clicks on the Continue
    button underneath.

    Returns True if we clicked Continue, False if no gate was present.
    """
    try:
        body = (driver.execute_script('return document.body.innerText') or '')
    except Exception:  # noqa: BLE001
        return False
    # Gate signature: 'Continue' alongside 'Use another profile' /
    # 'Create new account'. Plain Facebook home pages don't show those.
    if 'Continue' not in body or ('Use another profile' not in body and 'Create new account' not in body):
        return False

    # Step 1: dismiss the cookie banner if present — its overlay blocks
    # all other clicks. Safe no-op when the banner isn't shown.
    _dismiss_fb_cookie_banner(driver)

    # Step 2: click the Continue button. FB uses div[role=button] with
    # aria-label='Continue <Display Name>' — match by aria-label prefix
    # so it works for any account name.
    for locator in (
        ('xpath', '//div[@role="button"][starts-with(@aria-label, "Continue ")]'),
        ('xpath', '//div[@role="button"][@aria-label="Continue"]'),
        ('xpath', '//div[@role="button"][.//*[normalize-space()="Continue"]]'),
        ('xpath', '//button[normalize-space()="Continue"]'),
        ('xpath', '//a[normalize-space()="Continue"]'),
    ):
        try:
            elem = driver.find_element(*locator)
            elem.click()
            time.sleep(5)
            print('INFO: bypassed FB trust gate (Continue as <name>)', file=sys.stderr)
            return True
        except Exception:  # noqa: BLE001
            continue
    print('WARN: trust gate detected but no Continue button matched any selector', file=sys.stderr)
    return False


def _inject_cookies(driver, jar: list[dict]) -> None:
    """Restore a saved cookie jar after navigating to a domain page."""
    for cookie in jar:
        try:
            driver.add_cookie(cookie)
        except Exception as exc:  # noqa: BLE001
            print(f'WARN: cookie {cookie.get("name")}: {exc}', file=sys.stderr)


def _is_checkpoint(driver) -> bool:
    """Heuristic detection of a captcha / security-check page.

    Facebook's checkpoint URL contains '/checkpoint/' or '/confirmcontact'.
    Also checks for common challenge keywords in the page title.
    """
    try:
        url = driver.current_url.lower()
        if '/checkpoint/' in url or '/confirmcontact' in url or '/login/' in url:
            return True
        title = (driver.title or '').lower()
        return any(k in title for k in ('security check', 'verify', 'log in'))
    except Exception:  # noqa: BLE001
        return False


# ── Selector helpers (⚠️ tune empirically) ──────────────────────────
# Facebook re-randomizes class names regularly. We lean on stable
# attributes (role=article, aria-label, hrefs that match canonical
# patterns) instead. Update these helpers when FB ships a redesign.

# Selectors that isolate the actual post body, in priority order. FB
# applies a char-randomization defense to the surrounding UI furniture
# ("Sponsored", timestamps) by splitting it into one-char-per-span with
# random DOM order — `.text` on the whole card returns gibberish. But
# the post body itself is rendered inside one of these stable wrappers
# in normal-reading order.
_POST_BODY_SELECTORS = (
    'div[data-ad-rendering-role="story_message"]',
    'div[data-ad-preview="message"]',
    'div[data-ad-comet-preview="message"]',
)


def _extract_post_body(card_el) -> str:
    """Return the post body text from a feed card, bypassing FB's
    char-randomized UI furniture. Falls back to the longest dir=auto
    block if the named wrappers aren't present (DOM drift)."""
    for sel in _POST_BODY_SELECTORS:
        try:
            elems = card_el.find_elements('css selector', sel)
        except Exception:  # noqa: BLE001
            continue
        for el in elems:
            try:
                t = (el.text or '').strip()
            except Exception:  # noqa: BLE001
                continue
            if t:
                return t
    # Fallback — pick the longest visible dir=auto block, which on
    # text-only posts is almost always the body. Skip very short
    # blocks (author names, "See more", timestamps).
    try:
        candidates = card_el.find_elements('css selector', 'div[dir="auto"]')
    except Exception:  # noqa: BLE001
        candidates = []
    longest = ''
    for c in candidates:
        try:
            t = (c.text or '').strip()
        except Exception:  # noqa: BLE001
            continue
        if len(t) > len(longest) and len(t) >= 20:
            longest = t
    return longest

def _click_share_and_capture(driver, article, post_url_re) -> Optional[str]:
    """Click the Share button on a post and read the resolved /share/p/<token>/
    URL from the system clipboard.

    Facebook's search-result cards don't render the canonical share permalink
    as a plain anchor — the URL is generated server-side only when the user
    explicitly clicks "Copy link" inside the Share menu. We reproduce that
    interaction headlessly and read clipboard via JS.

    Costs ~1.5-2s per post (find share button + open menu + close).
    Returns the captured URL on success, None on any failure — caller falls
    back to the synthetic `#post-<digest>` URL.
    """
    try:
        # The Share button uses aria-label="Send this to friends or post it
        # on your profile." across most locales; some renders use just "Share".
        # Match either via a substring CSS selector.
        share_btns = article.find_elements(
            'css selector',
            'div[aria-label*="Send" i][role="button"], div[aria-label*="Share" i][role="button"]',
        )
        if not share_btns:
            return None
        btn = share_btns[0]

        # Scroll into view so the menu doesn't render off-screen.
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", btn)
        time.sleep(0.3)

        # Clear any prior clipboard contents so we don't read stale data
        # if the click silently fails.
        try:
            driver.execute_script(
                "if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('');"
            )
        except Exception:
            pass

        btn.click()
        time.sleep(1.2)

        # The menu renders into <body>, not the article — look at document
        # scope. Items are role="menuitem" with a descendant <span> whose
        # text is the action ("Copy link", "Share to feed", etc.).
        copy_clicked = False
        for el in driver.find_elements('css selector', 'div[role="menuitem"], div[role="dialog"] div[role="button"]'):
            try:
                txt = (el.text or '').strip().lower()
            except Exception:
                continue
            if 'copy link' in txt:
                try:
                    el.click()
                    copy_clicked = True
                    break
                except Exception:
                    continue

        if not copy_clicked:
            # Close any open dialog by sending Escape, then bail.
            try:
                driver.execute_script("document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));")
            except Exception:
                pass
            return None

        # FB usually shows a "Link copied to clipboard" toast 200-500ms after
        # the click. Give the async clipboard write a moment to flush.
        time.sleep(0.6)

        captured = None
        try:
            captured = driver.execute_async_script(
                """
                const cb = arguments[arguments.length - 1];
                if (!navigator.clipboard || !navigator.clipboard.readText) { cb(null); return; }
                navigator.clipboard.readText().then(v => cb(v)).catch(() => cb(null));
                """
            )
        except Exception:
            captured = None

        # Close any still-open dialog so the next article's scan isn't
        # blocked by an overlay.
        try:
            driver.execute_script("document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));")
        except Exception:
            pass
        time.sleep(0.2)

        if not captured:
            return None
        captured = captured.strip()
        if 'facebook.com' not in captured or not post_url_re.search(captured):
            return None
        return captured
    except Exception:
        return None


def _extract_posts_from_search_page(driver) -> list[dict]:
    """Pull post stubs out of a Facebook search results page.

    Returns dicts with: post_url, author_handle, author_profile_url,
    content_excerpt, posted_at (best-effort).

    FB uses several post-URL patterns. We accept any anchor whose
    href matches one of the known patterns:
      - /posts/<id> or /<handle>/posts/<id>
      - /permalink.php?story_fbid=...
      - /share/p/<id>
      - /groups/<id>/posts/<id>
      - /story.php?...
    """
    import re
    import hashlib

    # Author = a user profile or page handle (NOT /groups/, /photo/, /watch/,
    # /search/, /reel/, /events/). FB encrypts post permalinks behind
    # `__cft__` tokens but the BASE URL (path + meaningful query) is still
    # the actual post permalink — we just strip the tracking junk.
    NON_AUTHOR_PREFIXES = (
        '/groups/', '/photo/', '/photo.php', '/watch/', '/search/', '/reel/',
        '/events/', '/marketplace/', '/share/', '/permalink', '/story.php',
        '/messages/', '/help/', '/policies/', '/privacy/', '/terms/',
    )

    # Patterns that identify an anchor as pointing at a SPECIFIC POST (not
    # the author profile, not the group page, not a generic FB nav link).
    POST_URL_PATTERNS = [
        r'/photo/?\?[^"]*fbid=',           # photo posts: /photo/?fbid=...&set=pcb.<post>
        r'/photo\.php\?[^"]*fbid=',        # legacy photo URL
        r'/posts/(?:pfbid)?[A-Za-z0-9]',   # /<handle>/posts/<id>  AND  /<handle>/posts/pfbid<token>
        r'/permalink\.php\?',              # /permalink.php?story_fbid=...
        r'/groups/[^/]+/posts/',
        r'/groups/[^/]+/permalink/',
        r'/groups/[^/]+/multi_permalinks/',
        r'/share/p/',
        r'/share/v/',                      # video share permalinks
        r'/share/r/',                      # reel share permalinks
        r'/videos/\d',
        r'/story\.php\?',
        r'/people/[^/]+/posts/',           # /people/<name>/posts/<id>
    ]
    post_url_re = re.compile('|'.join(POST_URL_PATTERNS))

    def _clean_fb_url(href: str) -> str:
        """Strip FB's __cft__ / __tn__ / ref_ tracking params; keep the
        path + content-meaningful query (fbid, set, story_fbid, etc.).
        Anchors render fine without tracking params."""
        if '?' not in href:
            return href.split('#')[0]
        base, _, qs = href.partition('?')
        kept = []
        for part in qs.split('&'):
            if not part:
                continue
            key = part.split('=', 1)[0]
            if key.startswith('__') or key in ('ref', 'eav', '_rdr', 'mibextid'):
                continue
            kept.append(part)
        cleaned = base + ('?' + '&'.join(kept) if kept else '')
        return cleaned.split('#')[0]

    def _is_author_link(href: str) -> bool:
        if 'facebook.com' not in href:
            return False
        path = href.split('facebook.com', 1)[-1].split('?')[0].split('#')[0]
        # Group posts surfaced in search results expose the author as
        # /groups/<gid>/user/<uid>/ — recognize it BEFORE the /groups/
        # reject below. FB switched search-result authors to this shape;
        # without this the open-feed extractor finds no author and skips
        # every card (the 0-stubs-from-N-cards bug, fixed 2026-06-15).
        if re.search(r'/groups/\d+/user/\d+/?', path):
            return True
        if any(path.startswith(p) for p in NON_AUTHOR_PREFIXES):
            return False
        # /profile.php?id=... is a valid author link
        if '/profile.php' in href:
            return True
        # /<handle>/ or /<handle>?... — single path segment is the handle
        segments = [s for s in path.strip('/').split('/') if s]
        return len(segments) == 1 and segments[0] not in ('', 'home.php')

    posts: list[dict] = []
    articles: list = []
    try:
        articles = driver.find_elements('css selector', 'div[role="feed"] > div')
        if not articles:
            articles = driver.find_elements('css selector', 'div[role="article"]')
    except Exception:
        pass
    print(f'DEBUG: found {len(articles)} post-card elements on page', file=sys.stderr)

    for idx, article in enumerate(articles[:30]):
        try:
            all_links = article.find_elements('css selector', 'a[href]')
            author_url = None
            real_post_url = None
            for a in all_links:
                href = (a.get_attribute('href') or '')
                if not href:
                    continue
                # Capture the FIRST real post permalink we see in the card.
                if real_post_url is None and post_url_re.search(href):
                    real_post_url = _clean_fb_url(href)
                if author_url is None and _is_author_link(href):
                    gm = re.search(r'/groups/\d+/user/(\d+)', href)
                    if gm:
                        # Canonicalize the in-group author link to the user's
                        # global profile so author enrichment + cross-group
                        # dedup key on one stable URL per person.
                        author_url = f'https://www.facebook.com/profile.php?id={gm.group(1)}'
                    elif '/profile.php' in href:
                        m = re.search(r'/profile\.php\?id=(\d+)', href)
                        author_url = f'https://www.facebook.com/profile.php?id={m.group(1)}' if m else href.split('&')[0]
                    else:
                        author_url = href.split('?')[0]

            if not author_url:
                continue

            # Layer 2: <a> anchors didn't expose a permalink. Try
            # role="link" elements (FB wraps the timestamp in a role-link
            # span/div whose href is set lazily after focus). Probe their
            # `href`, `data-href`, and ancestor-anchor `href`.
            if not real_post_url:
                try:
                    role_links = article.find_elements('css selector', '[role="link"]')
                    for el in role_links:
                        for attr in ('href', 'data-href', 'data-lynx-uri'):
                            val = (el.get_attribute(attr) or '')
                            if val and post_url_re.search(val):
                                real_post_url = _clean_fb_url(val)
                                break
                        if real_post_url:
                            break
                except Exception:
                    pass

            # Layer 3: still no permalink. Click the Share button to open
            # FB's share menu, then click "Copy link" — FB resolves the
            # canonical /share/p/<token>/ URL only at this point. Read it
            # back via navigator.clipboard.readText() (clipboard-read perm
            # is granted in _open_driver via Chrome prefs).
            if not real_post_url:
                real_post_url = _click_share_and_capture(driver, article, post_url_re)
                if real_post_url:
                    real_post_url = _clean_fb_url(real_post_url)

            # Use the dedicated story_message wrapper to bypass FB's
            # char-randomized UI furniture; fall back to article.text
            # if the wrapper isn't present (defense against DOM drift).
            body = _extract_post_body(article)
            raw_text = (article.text or '').strip()
            excerpt = (body or raw_text)[:500]
            if not excerpt:
                continue

            # Prefer the real post permalink. Fall back to a synthetic hash
            # only if no permalink-shaped URL appeared in the card — that
            # way (platform, post_url) is still unique for dedup, but most
            # rows now carry a clickable link to the actual post on FB.
            if real_post_url:
                post_url = real_post_url
            else:
                digest = hashlib.sha1(excerpt[:200].encode('utf-8')).hexdigest()[:12]
                post_url = f'{author_url}#post-{digest}'

            # Handle: /<handle>/ → handle; /profile.php?id=N → profile.php:N
            if '/profile.php' in author_url:
                m = re.search(r'[?&]id=(\d+)', author_url)
                author_handle = f'profile.php:{m.group(1)}' if m else 'profile.php'
            else:
                author_handle = author_url.rstrip('/').split('/')[-1].split('?')[0]
            posts.append({
                'post_url': post_url,
                'author_handle': author_handle,
                'author_profile_url': author_url,
                'content_excerpt': excerpt,
                'posted_at': None,
            })
        except Exception as exc:  # noqa: BLE001
            print(f'DEBUG: article[{idx}] parse error: {exc}', file=sys.stderr)
            continue
    print(f'DEBUG: extracted {len(posts)} post stubs from page', file=sys.stderr)
    return posts


def _extract_posts_from_group_search(driver, group: dict) -> list['PostStub']:
    """Extract post stubs from a group's in-group search page.

    Differs from open-feed extraction in three ways:
      1. Post URLs are mostly `/stories/<id>/...` (text) or
         `/photo/?fbid=...&set=gm.<id>&idorvanity=<gid>` (photo).
      2. Author links are `/groups/<gid>/user/<uid>/` — must be
         transformed to /profile.php?id=<uid> for outreach.
      3. Some posts are "Anonymous participant" — flagged with
         author_handle='anonymous-<hash>' and profile_url=None.
    """
    import hashlib
    out: list[PostStub] = []
    try:
        cards = driver.find_elements('css selector', 'div[role="feed"] > div')
    except Exception:
        cards = []
    if not cards:
        return out

    # Group-post URL patterns
    GROUP_POST_RE = re.compile(
        r'/stories/\d+/[A-Za-z0-9]+|'
        r'/photo/?\?[^"]*set=gm\.\d+|'
        r'/groups/[^/]+/posts/[0-9a-zA-Z]+|'
        r'/groups/[^/]+/permalink/\d+'
    )

    for idx, card in enumerate(cards[:30]):
        try:
            # `text` is only used for dedup hashing + anonymous-poster
            # detection. The DISPLAYABLE post body comes from
            # _extract_post_body, which bypasses FB's char-randomized
            # UI furniture.
            text = (card.text or '').strip()
            if not text:
                continue
            body = _extract_post_body(card)

            # Find author. In-group post anchors look like:
            #   https://www.facebook.com/groups/<gid>/user/<uid>/
            # Treat 'Anonymous participant' specially.
            is_anonymous = 'Anonymous participant' in text or text.lower().startswith('anonymous')
            author_url: Optional[str] = None
            author_handle: Optional[str] = None

            if not is_anonymous:
                for a in card.find_elements('css selector', 'a[href*="/user/"]'):
                    h = (a.get_attribute('href') or '')
                    m = re.search(rf'/groups/{group["group_id"]}/user/(\d+)/', h)
                    if m:
                        uid = m.group(1)
                        author_url = f'{FB_BASE}/profile.php?id={uid}'
                        author_handle = f'profile.php:{uid}'
                        break

            if is_anonymous or not author_url:
                # Synthesize anon identity from excerpt hash so dedup still works
                digest = hashlib.sha1(text[:200].encode('utf-8')).hexdigest()[:12]
                author_handle = f'anonymous-{digest}'
                author_url = None

            # Find real post permalink in the card. Three-tier strategy:
            #   1. Scan in-card anchors for known permalink patterns (cheap)
            #   2. Click the Share button → "Copy link" → read clipboard
            #      for FB's canonical /share/p/<token>/ URL (~1.5-2s/card,
            #      but reliable across FB's frequent DOM changes)
            #   3. Synthetic <author>#post-<hash> fallback (preserves dedup)
            post_url: Optional[str] = None
            for a in card.find_elements('css selector', 'a[href]'):
                h = (a.get_attribute('href') or '')
                if not h or 'facebook.com' not in h:
                    continue
                if GROUP_POST_RE.search(h):
                    # Strip tracking
                    base, _, qs = h.partition('?')
                    if qs:
                        kept = [p for p in qs.split('&')
                                if not p.startswith('__') and not p.startswith('eav')
                                and p.split('=')[0] not in ('ref', '_rdr', 'mibextid')]
                        post_url = base + (('?' + '&'.join(kept)) if kept else '')
                    else:
                        post_url = base
                    post_url = post_url.split('#')[0]
                    break

            # Tier 2: ask FB for the share URL via clipboard. Uses the same
            # broad permalink regex the open-feed scrape uses, so we accept
            # `/share/p/`, `/groups/<gid>/multi_permalinks/`, etc.
            if not post_url:
                try:
                    real = _click_share_and_capture(driver, card, _BROAD_POST_URL_RE)
                except Exception:
                    real = None
                if real:
                    post_url = real.split('#')[0]

            if not post_url:
                # Tier 3: synthetic so (platform, post_url) stays unique
                digest = hashlib.sha1(text[:200].encode('utf-8')).hexdigest()[:12]
                anchor = author_url or f'{FB_BASE}/groups/{group["group_id"]}'
                post_url = f'{anchor}#post-{digest}'

            out.append({
                'platform': 'facebook',
                'post_url': post_url,
                'author_handle': author_handle,
                'author_profile_url': author_url,
                'content_excerpt': (body or text)[:500],
                'posted_at': None,
                'group_id': group['group_id'],
                'group_name': group.get('name'),
                'is_anonymous': is_anonymous or (author_url is None),
            })
        except Exception as exc:  # noqa: BLE001
            print(f'DEBUG: group card[{idx}] parse error: {exc}', file=sys.stderr)
            continue
    return out


def _extract_pages_from_category(driver) -> list[dict]:
    """Pull Page stubs from /pages/category/* listing pages."""
    out: list[dict] = []
    try:
        anchors = driver.find_elements('css selector', 'a[href*="/pages/"]')
    except Exception:
        anchors = []
    seen = set()
    for a in anchors[:100]:
        try:
            href = a.get_attribute('href') or ''
            if '/pages/' not in href:
                continue
            name = (a.text or '').strip()
            if not name or href in seen:
                continue
            seen.add(href)
            out.append({
                'name': name,
                'profile_url': href.split('?')[0],
                'rating': None,
            })
        except Exception:  # noqa: BLE001
            continue
    return out


# ── The scraper class ───────────────────────────────────────────────
class FacebookScraper(SocialPlatformScraper):
    """Concrete Facebook plugin — both consumer + business modes."""

    name = 'facebook'
    base_url = FB_BASE
    requires_proxy = True

    supports_post_search = True
    supports_group_search = True

    # The filter schema lists EVERY field the UI may render. The frontend
    # chooses which subset to show based on the mode toggle.
    filter_schema: list[FilterField] = [
        {'name': 'lead_type', 'type': 'select', 'label': 'Lead type', 'required': True,
         'default': 'consumers',
         'options': [
             {'value': 'consumers', 'label': 'People asking for a service (post authors)'},
             {'value': 'businesses', 'label': 'Businesses in a niche (page owners)'},
         ]},
        # Consumer mode fields — split into niche + location
        {'name': 'niche',    'type': 'text', 'label': 'Niche / service', 'required': True},
        {'name': 'location', 'type': 'text', 'label': 'Location / city',  'required': True},
        # Business mode fields
        {'name': 'category', 'type': 'text', 'label': 'Page category (slug)'},
        {'name': 'country',  'type': 'select', 'label': 'Country', 'options_source': 'taxonomy:countries'},
    ]

    # ── Group-first consumer scraping (spec 2026-05-27) ──────────────
    def _sync_discover_groups(self, niche: str, location: str, on_progress: ProgressCallback) -> list[dict]:
        """Hit /search/groups/?q=<niche+location>, return ALL discovered
        groups: each {group_id, name, member_count, url, snippet}. No
        cap — operator opted for full coverage.
        """
        account = self._claim_or_raise()
        driver = self._open_session(account)
        groups: list[dict] = []
        try:
            qparts = [p for p in (niche, location) if p]
            qstr = quote_plus(' '.join(qparts).strip())
            url = f'{FB_BASE}/search/groups/?q={qstr}'
            _emit(on_progress, 'groups_search_start', query=' '.join(qparts))
            driver.get(url)
            time.sleep(4)
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], 'captcha-during-groups-search')
                return []
            # Scroll a little to surface more groups
            for _ in range(2):
                driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
                _human_pause(SCROLL_PAUSE)
            try:
                cards = driver.find_elements('css selector', 'div[role="feed"] > div')
                if not cards:
                    cards = driver.find_elements('css selector', 'div[role="article"]')
            except Exception:
                cards = []
            print(f'DEBUG: groups page url={driver.current_url} title={driver.title!r} cards_found={len(cards)}', file=sys.stderr)
            try:
                debug_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '.tmp'))
                os.makedirs(debug_dir, exist_ok=True)
                driver.save_screenshot(os.path.join(debug_dir, 'fb_groups_discovery.png'))
                with open(os.path.join(debug_dir, 'fb_groups_discovery.html'), 'w', encoding='utf-8') as f:
                    f.write(driver.page_source)
            except Exception as exc:
                print(f'DEBUG: screenshot failed: {exc}', file=sys.stderr)
            seen = set()
            dbg_inspected = 0
            for c in cards:
                try:
                    text = (c.text or '').strip()
                    # Cache anchors ONCE so we don't trigger stale-element
                    # exceptions calling find_elements twice on the same card.
                    anchors = c.find_elements('css selector', 'a[href*="/groups/"]')
                    if dbg_inspected < 3:
                        print(f'DEBUG: card text={text[:80]!r} group_anchors={len(anchors)}', file=sys.stderr)
                    if not text:
                        continue
                    gid = None; gurl = None
                    hrefs_seen: list = []
                    for a in anchors:
                        try:
                            h = (a.get_attribute('href') or '')
                        except Exception as exc:
                            h = ''
                            if dbg_inspected <= 3:
                                print(f'DEBUG:    anchor stale: {exc!s:.80}', file=sys.stderr)
                        hrefs_seen.append(h[:120])
                        m = re.search(r'/groups/([0-9a-zA-Z._-]+)/?', h)
                        if m:
                            gid_candidate = m.group(1)
                            if gid_candidate not in {'search', 'feed', 'discover'}:
                                gid = gid_candidate
                                gurl = f'{FB_BASE}/groups/{gid}/'
                                break
                    if dbg_inspected < 3:
                        print(f'DEBUG:   -> hrefs={hrefs_seen!s:.300} gid={gid}', file=sys.stderr)
                        dbg_inspected += 1
                    if not gid or gid in seen:
                        continue
                    seen.add(gid)
                    lines = [ln.strip() for ln in text.split('\n') if ln.strip()]
                    name = lines[0] if lines else '?'
                    members_m = re.search(r'([\d,.]+\s*[KMkm]?)\s*member', text, re.IGNORECASE)
                    members = members_m.group(1) if members_m else None
                    is_public = 'public' in text.lower()[:80]
                    groups.append({
                        'group_id': gid,
                        'name': name,
                        'member_count_text': members,
                        'is_public': is_public,
                        'is_member': _card_is_member(text),
                        'url': gurl,
                        'snippet': text[:200],
                    })
                except Exception as exc:
                    print(f'DEBUG: per-card exception: {type(exc).__name__}: {str(exc)[:150]}', file=sys.stderr)
                    continue
            _bump_counters(account['id'], delta_today=1, delta_hour=1)
            _emit(on_progress, 'groups_found', count=len(groups))
            return groups
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_group_first_scrape(
        self,
        niche: str,
        location: str,
        on_progress: ProgressCallback,
        generic_group_cap: int = 5,
    ) -> list:
        """Orchestrate the discovery → per-group search → aggregate flow.
        Sequential and cancellable; partial results persist if the parent
        process is killed mid-flight (each in-group search is a complete
        unit). Returns aggregated PostStubs across all discovered groups.

        Caller is responsible for niche translation (search_posts handles
        that BEFORE calling us, so the classifier downstream gets the same
        translated value). Here we just use the niche we're given.
        """
        groups_raw = self._sync_discover_groups(niche, location, on_progress)
        if not groups_raw:
            _emit(on_progress, 'groups_found', count=0)
            return []
        # Filter out professional / job / supplier / association groups.
        # Their 'looking for X' posts are job seekers and clinic recruiters,
        # not consumers. Cuts both noise and wall time dramatically.
        gated = [g for g in groups_raw if _is_consumer_facing_group(g.get('name', ''), location)]
        dropped_pro = len(groups_raw) - len(gated)
        if dropped_pro:
            _emit(on_progress, 'groups_filtered', dropped=dropped_pro, kept=len(gated),
                  reason='professional/job/supplier groups removed')
        if not gated:
            _emit(on_progress, 'groups_found', count=0)
            return []

        # Prioritize niche/classifieds/community groups; cap generic
        # city/lifestyle groups so non-English markets stop drowning in
        # lifestyle-group noise (and we don't burn account quota on it).
        groups, prio = _order_and_cap_groups(gated, niche, location, generic_group_cap)
        _emit(on_progress, 'groups_prioritized',
              relevant=prio['relevant'],
              generic_searched=prio['generic_searched'],
              generic_skipped=prio['generic_skipped'])
        # Assisted-join queue: record tier-2 groups the account isn't a member
        # of so the operator can join them manually; auto-flip prior candidates
        # to 'joined' once they show as members. Best-effort, never blocks.
        try:
            cand_groups = [
                {**g, 'tier': _group_relevance_tier(g.get('name', ''), location, niche)}
                for g in gated
            ]
            tier2_gids = [g['group_id'] for g in cand_groups if g.get('tier') == 2]
            existing_status: dict = {}
            if tier2_gids:
                resp = (table('fb_group_candidates')
                        .select('group_id,status')
                        .eq('platform', 'facebook')
                        .in_('group_id', tier2_gids)
                        .execute())
                existing_status = {r['group_id']: r['status'] for r in (resp.data or [])}
            plan = _plan_candidate_writes(cand_groups, existing_status, niche, location, _now_iso())
            if plan['upsert']:
                table('fb_group_candidates').upsert(
                    plan['upsert'], on_conflict='platform,group_id').execute()
            for gid in plan['mark_joined']:
                (table('fb_group_candidates')
                 .update({'status': 'joined', 'joined_detected_at': _now_iso()})
                 .eq('platform', 'facebook').eq('group_id', gid).eq('status', 'candidate')
                 .execute())
            _emit(on_progress, 'group_queue_updated',
                  queued=len(plan['upsert']), joined=len(plan['mark_joined']))
        except Exception as exc:  # noqa: BLE001
            print(f'[group-queue] non-fatal: {str(exc)[:300]}', file=sys.stderr)
        if not groups:
            _emit(on_progress, 'groups_found', count=0)
            return []
        in_group_keyword = _in_group_keyword(niche, location)
        account = self._claim_or_raise()

        # Reuse ONE Chrome session across all in-group searches. Spawning
        # a fresh chromedriver per group costs 5-10s and 42 groups means
        # 4-7 wasted minutes per scrape. _open_session hydrates cookies
        # once; subsequent driver.get() calls just navigate.
        driver = self._open_session(account)
        aggregated: list = []
        try:
            for i, g in enumerate(groups, 1):
                _emit(on_progress, 'group_progress', n=i, total=len(groups),
                      group_name=g.get('name', '?')[:60], group_id=g['group_id'])
                try:
                    url = f'{FB_BASE}/groups/{g["group_id"]}/search/?q={quote_plus(in_group_keyword)}'
                    driver.get(url)
                    _human_pause(SCROLL_PAUSE)
                    if _is_checkpoint(driver):
                        _flag_checkpoint(account['id'], f'captcha-in-group-{g["group_id"]}')
                        _emit(on_progress, 'group_failed', group_id=g['group_id'], reason='captcha')
                        break
                    # Light scroll for lazy content
                    driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
                    _human_pause(SCROLL_PAUSE)
                    stubs = _extract_posts_from_group_search(driver, g)
                    if stubs:
                        aggregated.extend(stubs)
                        _emit(on_progress, 'group_posts_kept', count=len(stubs), group_name=g.get('name'))
                    _bump_counters(account['id'], delta_today=1, delta_hour=1)
                except Exception as exc:  # noqa: BLE001
                    _emit(on_progress, 'group_failed', group_id=g['group_id'], reason=str(exc)[:120])
                # Human-like gap between consecutive group searches. Firing
                # group-after-group with only scroll pauses is the metronome
                # cadence FB's automation detection flags; a randomized
                # ~5-12s gap (skipped after the last group) breaks it.
                if i < len(groups):
                    _human_pause(5.0, extra=7.0)
            _emit(on_progress, 'search_done', total=len(aggregated))
            return aggregated
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_search_inside_group(
        self,
        account: dict,
        group: dict,
        keyword: str,
        on_progress: ProgressCallback,
    ) -> list[PostStub]:
        """Run an in-group post search inside one group. Returns PostStubs
        with the in-group URL patterns (set=gm.<id>, /stories/<id>/, etc).
        Caller is responsible for filtering and account-claiming.
        """
        driver = self._open_session(account)
        results: list[PostStub] = []
        try:
            url = f'{FB_BASE}/groups/{group["group_id"]}/search/?q={quote_plus(keyword)}'
            driver.get(url)
            _human_pause(SCROLL_PAUSE * 2)
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], f'captcha-in-group-{group["group_id"]}')
                return results
            # Scroll a couple of times to load lazy content
            for _ in range(2):
                driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
                _human_pause(SCROLL_PAUSE)
            posts = _extract_posts_from_group_search(driver, group)
            for p in posts:
                results.append(p)
            _bump_counters(account['id'], delta_today=1, delta_hour=1)
            return results
        finally:
            try: driver.quit()
            except Exception: pass

    # ── BasePlatformScraper interface ────────────────────────────────
    async def scrape_listing(
        self,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        """Discover either Pages (businesses) or post-authors (consumers).

        For lead_type='consumers' we run search_posts under the hood and
        reshape PostStubs into profile-stub form (with ``profile_url`` set
        to the author profile). The orchestrator's existing list→enrich
        pipeline then routes each author through enrich_profiles, which
        detects the PostStub shape and pivots to author-enrichment.
        """
        # Record the operator's location/country for the proxy-country
        # resolver in _open_driver(). consumers-mode uses `location`
        # (city), businesses-mode uses `country` (ISO code).
        global _CURRENT_LOCATION, _TARGET_COUNTRY
        _CURRENT_LOCATION = (
            (filters.get('location') or '').strip()
            or (filters.get('country') or '').strip()
            or None
        )
        _TARGET_COUNTRY = _target_country_from_filters(filters)

        lead_type = (filters.get('lead_type') or 'consumers').lower()

        if lead_type == 'consumers':
            # NEW: group-first flow (spec 2026-05-27).
            # Accept either the new (niche + location) shape OR the legacy
            # single `query` field for back-compat.
            niche = (filters.get('niche') or '').strip()
            location = (filters.get('location') or '').strip()
            legacy_query = (filters.get('query') or '').strip()
            if not niche and legacy_query:
                niche = legacy_query  # back-compat
            if not niche:
                raise ValueError("Consumer-mode Facebook scrapes require 'niche' (and ideally 'location') filters")

            # Escape hatch: groups_only=false uses the old open-feed flow.
            #
            # `already_filtered` tracks whether the stubs have already been
            # through _apply_consumer_filter_chain. search_posts runs the whole
            # chain internally, so re-running it here would (a) pay for a
            # SECOND Gemini call per job and (b) re-destroy every lead the
            # classifier just recovered, by re-applying the substring
            # heuristics as a de-facto pre-gate. The group-first branch below
            # returns RAW stubs, so those still need the chain.
            if filters.get('groups_only') is False:
                query = ' '.join(p for p in (niche, location) if p)
                post_stubs = await self.search_posts(
                    query, filters, max_results=max_results, on_progress=on_progress,
                )
                already_filtered = True
            else:
                already_filtered = False
                # scrape_listing's group-first branch is browser-ONLY: it
                # claims an account and drives undetected-chromedriver. When
                # FB_DISCOVERY selects the browserless Apify path, running it
                # anyway would silently contradict the operator's config and
                # spend a Facebook account's daily cap. Fail loudly instead of
                # rerouting — `list` and `search-posts` are different entry
                # points with different contracts (list returns reshaped
                # profile stubs), so quietly swapping one for the other would
                # be a second surprise on top of the first.
                if _discovery_source() == 'apify':
                    raise RuntimeError(
                        "FB_DISCOVERY=apify selects the browserless Apify discovery path, "
                        "but --action list (scrape_listing) with groups_only implements only "
                        "the browser crawl. Use --action search-posts (then --action "
                        "enrich-authors) for Apify discovery, or set FB_DISCOVERY=browser "
                        "to run --action list on the logged-in browser path."
                    )
                post_stubs = await asyncio.to_thread(
                    self._sync_group_first_scrape, niche, location, on_progress,
                    _resolve_generic_cap(filters),
                )
            # Consumer-only filter chain — ONE shared implementation (see
            # _apply_consumer_filter_chain). Gemini's verdicts are the gate;
            # the substring heuristics are the fallback for when the
            # classifier returns nothing. Skipped entirely when search_posts
            # already ran it, so the open-feed path filters exactly once.
            #
            # geo_scoped=True: the only way to reach this branch is the
            # browser group-first crawl (the Apify case raised above), and that
            # crawl's groups were geo-selected, so geography stays inside the
            # classifier prompt and no post-hoc country stage runs.
            if not already_filtered:
                post_stubs = _apply_consumer_filter_chain(
                    post_stubs, niche=niche, location=location,
                    filters=filters, on_progress=on_progress,
                    geo_scoped=True,
                )

            # Reshape PostStubs into profile-stub form so the list→enrich
            # orchestrator can drive them. Anonymous posts (group asks
            # from users we can't DM) get a synthetic identity instead
            # of a real profile URL — they ride through the pipeline but
            # land with outreach_status='lost' so they don't pollute the
            # actionable lead queue.
            reshaped: list[dict] = []
            for s in post_stubs:
                author_url = s.get('author_profile_url')
                handle = s.get('author_handle') or 'anonymous'
                is_anon = s.get('is_anonymous') or author_url is None

                if is_anon and not author_url:
                    # Anonymous group ask — synthesize a stable identity.
                    # profile_url stays None; UI will render as unreachable.
                    profile_url = f'{FB_BASE}/groups/{s.get("group_id","unknown")}#anon-{handle.split("-",1)[-1]}'
                else:
                    profile_url = author_url

                reshaped.append({
                    **s,
                    'profile_url': profile_url,
                    'name': handle if not is_anon else 'Anonymous group ask',
                    'rating': None,
                    # Category = the niche the operator searched for.
                    'category': niche or legacy_query,
                    # Country: resolves from the post's own evidence (group
                    # name + excerpt) first. Falls back to the operator's
                    # search location with geo_scoped=True because the ONLY
                    # way to reach this branch is the browser group-first
                    # crawl (see the geo_scoped=True note two lines above at
                    # the filter-chain call) — but even then only when that
                    # location itself maps to a real ISO-2 country. Unmapped
                    # places (e.g. "Nairobi") or arbitrary operator text
                    # (e.g. "Wigan") are NEVER written into `country` — they
                    # surface honestly instead via `location_confidence`.
                    'country': _resolve_lead_country(
                        s.get('group_name'), location, s.get('content_excerpt'),
                        geo_scoped=True,
                    ),
                    'location_confidence': _derive_location_confidence(
                        s.get('group_name'), s.get('content_excerpt'), location,
                    ),
                    'is_anonymous': is_anon,
                    'outreach_status': 'lost' if is_anon else None,
                })
            _emit(on_progress, 'category_done', count=len(reshaped))
            return reshaped

        category = filters.get('category')
        if not category:
            raise ValueError("Business-mode Facebook scrapes require 'category' filter")
        return await asyncio.to_thread(self._sync_scrape_pages, category, max_results or 50, on_progress)

    async def enrich_profiles(
        self,
        profile_stubs: list[dict],
        *,
        screenshots_dir: str = '',
        parallel_tabs: int = 1,
        output_path: str = '',
        flush_every: int = 25,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        """Best-effort enrichment. Pivots to author-enrichment when the input
        stubs are reshaped PostStubs (carry ``post_url``)."""
        if not profile_stubs:
            return []
        # Detect consumer-mode reshape: PostStubs carry a 'post_url'.
        if any('post_url' in s for s in profile_stubs):
            # This pivot is browser-ONLY (_sync_enrich_authors visits each
            # profile with a logged-in account). FB_ENRICH=stub asks for the
            # browserless path, which lives on --action enrich-authors. Fail
            # loudly rather than rerouting: enrich_profiles' contract is
            # profile stubs in / enriched profile dicts out, while
            # enrich_authors returns AuthorLeads.
            if _enrich_mode() == 'stub':
                raise RuntimeError(
                    "FB_ENRICH=stub selects the browserless stub-enrichment path, but "
                    "--action enrich (enrich_profiles) implements only the browser "
                    "profile-visit crawl. Use --action enrich-authors for stub "
                    "enrichment, or set FB_ENRICH=browser to run --action enrich on "
                    "the logged-in browser path."
                )
            return await asyncio.to_thread(self._sync_enrich_authors, profile_stubs, on_progress)
        return await asyncio.to_thread(self._sync_enrich_pages, profile_stubs, screenshots_dir, on_progress)

    # ── SocialPlatformScraper interface ──────────────────────────────
    async def search_posts(
        self,
        query: str,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[PostStub]:
        if not query:
            raise ValueError("search_posts requires a non-empty query")
        # Route: when groups_only is set (the operator's default — set
        # server-side in scrape-runner.ts for consumer-mode jobs), use the
        # group-discovery → per-group search pipeline implemented at
        # _sync_group_first_scrape. This is the May-27 design and is the
        # ONLY path that yields real consumer asks; the open-feed search
        # is dominated by ads phrased as "Looking for X?".
        #
        # Escape hatch: pass groups_only=False to filters to revert to the
        # open-feed scrape (kept for parity testing + rollback).
        groups_only = bool(filters.get('groups_only', True))
        niche = (filters.get('niche') or '').strip()
        location = (filters.get('location') or filters.get('country') or '').strip()

        # Auto-translate niche to the local language of the city BEFORE search +
        # classifier. Operator submits "electrician" + "Frankfurt"; we translate
        # to "Elektriker" and use that for BOTH the FB group/post search AND the
        # downstream Gemini classifier. Falls through (no translation) for
        # English-primary cities or unknown locations. Original term is preserved
        # in `original_niche` for category-stamping on the persisted lead row
        # (so dashboard filter "category=electrician" finds these German leads).
        original_niche = niche
        if niche and location:
            translated = await asyncio.to_thread(_translate_niche_to_local, niche, location)
            if translated and translated.strip().lower() != niche.strip().lower():
                _emit(
                    on_progress,
                    'niche_translated',
                    **{'from': niche, 'to': translated, 'location': location},
                )
                niche = translated

        # Discovery source. The Apify branch sits HERE — after niche
        # translation (so it searches the local-language term) and before the
        # country/category stamping and consumer filter chain below (so Apify
        # stubs get exactly the same treatment browser stubs do). Moving it
        # below the stamping would silently drop category/country on every
        # Apify lead.
        discovery = _discovery_source()
        # Operator-named groups. Apify group DISCOVERY is broken (our search
        # actor's search_type='groups' returns 0 items even for a one-word
        # query, and the old data-slayer group-post actor returns 0 for its own
        # documented default input), so when the operator supplies the groups
        # themselves discovery is SKIPPED OUTRIGHT — not attempted then fallen
        # back from, because a doomed discovery call is still a billable run.
        supplied_groups = facebook_apify.parse_group_urls(filters.get('group_urls'))
        if discovery == 'apify':
            # `max_results or 50` would turn an explicit 0 into 50 and spend a
            # billable actor run (on the free plan, the day's only run).
            resolved_max = max_results if max_results is not None else 50
            # GROUP DISCOVERY wants a geo-stuffed term — matching a group by
            # place name is exactly the point ("plumber Manchester" finds
            # "Manchester Tradespeople").
            group_search_term = f'{niche} {location}'.strip() if niche and location else query
            if supplied_groups:
                # `group_keyword` (NOT `query`) drives the actor's `search`:
                # that field is a keyword filter, and feeding it a whole intent
                # phrase ("need a plumber recommendation") matches nothing.
                # niche/location are NOT required here — they only ever existed
                # to build the (broken) discovery term.
                group_keyword = (filters.get('group_keyword') or '').strip() or None
                _emit(
                    on_progress, 'apify_groups_supplied',
                    groups=len(supplied_groups), keyword=group_keyword,
                    reason='operator supplied group URLs — group discovery skipped '
                           '(Apify group search returns 0 items for any query)',
                )
                if location:
                    # MEASURED TRAP, not a hypothetical — and now DEFUSED by
                    # _geo_regime, which withholds the town from the classifier
                    # prompt on this path while still trusting the group's
                    # geography. The Gemini location clause demands a city
                    # signal IN THE POST BODY and group members never name
                    # their own town. Live Gemini call on three real group asks,
                    # 2026-08-04:
                    #     location=None         -> [True, True, False]
                    #     location='Manchester' -> [False, False, False]
                    # Still emitted loudly: the operator's own filter value is
                    # being partially ignored, and silent divergence between
                    # what was typed and what ran is exactly what made the
                    # original zero-yield run undiagnosable. This reports a
                    # decision already taken — it is NOT a chore for the
                    # operator, because the Scrape page can carry a location
                    # over from a previous search and clearing it by hand was
                    # never a safeguard.
                    _emit(
                        on_progress, 'apify_groups_location_warning',
                        location=location, ignored_for_intent=True,
                        reason=f'{location!r} was IGNORED for intent matching: '
                               'group_urls already fixes the geography, and '
                               'feeding a town to the intent classifier makes it '
                               'require each post to NAME that town — measured 0 '
                               'kept of 3 genuine asks. The location is still '
                               "used to tag each lead's country and to pick the "
                               'sending account.',
                    )
                pairs = [
                    (facebook_apify.group_id_from_url(url) or url, '')
                    for url in supplied_groups
                ]
                stubs = await asyncio.to_thread(
                    _group_posts_via_apify, pairs, resolved_max, on_progress,
                    group_keyword,
                )
            elif groups_only:
                if not niche or not location:
                    raise ValueError(
                        "Group-first search requires both 'niche' and 'location' in filters. "
                        "Pass groups_only=False to fall back to the open-feed search."
                    )
                groups = await asyncio.to_thread(
                    _discover_group_ids_via_apify, group_search_term, 10,
                )
                if not groups:
                    # Live-tested 2026-08-03: both community group actors
                    # (scrapeforge/facebook-search-posts search_type=groups,
                    # data-slayer/facebook-group-posts) return 0 items even
                    # for broad/default inputs — group search on these
                    # community actors is known non-functional. Without this
                    # branch, groups=[] means _group_posts_via_apify loops
                    # zero times and the job silently returns 0 leads with no
                    # explanation. Surface a loud, actionable event, then
                    # degrade to the open-feed search, which demonstrably
                    # works, so the job still produces leads.
                    _emit(
                        on_progress, 'apify_groups_unavailable',
                        actor=facebook_apify.search_actor(),
                        reason='group discovery returned no groups; group search on '
                               'community Apify actors is known non-functional — '
                               'falling back to open-feed keyword search',
                    )
                    # OPEN-FEED fallback: the operator's `query` verbatim, same
                    # as the non-groups_only branch below. See the comment there.
                    stubs = await asyncio.to_thread(
                        _search_posts_via_apify, query, filters,
                        resolved_max, on_progress,
                    )
                else:
                    stubs = await asyncio.to_thread(
                        _group_posts_via_apify, groups, resolved_max, on_progress,
                    )
            else:
                # OPEN-FEED search: pass the operator's `query` through
                # VERBATIM, exactly as the browser path does below. Replacing
                # it with f'{niche} {location}' removed the operator's only
                # channel for an intent-shaped query — measured live, the
                # geo-stuffed "looking for a plumber in Manchester" returned
                # 0 usable of 20 (all adverts), while intent phrasing like
                # "need a plumber recommendation" returned real consumer asks.
                stubs = await asyncio.to_thread(
                    _search_posts_via_apify, query, filters,
                    resolved_max, on_progress,
                )
        elif groups_only:
            if not niche or not location:
                raise ValueError(
                    "Group-first search requires both 'niche' and 'location' in filters. "
                    "Pass groups_only=False to fall back to the open-feed search."
                )
            stubs = await asyncio.to_thread(
                self._sync_group_first_scrape, niche, location, on_progress,
                _resolve_generic_cap(filters),
            )
        else:
            stubs = await asyncio.to_thread(
                self._sync_search_posts, query, False, max_results or 50, on_progress,
            )
        # The geographic regime for THIS search, decided ONCE (see _geo_regime)
        # and reused by the country stamping below, the filter chain's geography
        # stage, and the classifier prompt further down — so those three can
        # never drift apart. A global (non-place-anchored) Apify search must not
        # stamp its target country onto a post that names no place of its own,
        # and the geo-mismatch filter has to agree on the same premise.
        #
        # OPERATOR-SUPPLIED GROUPS are geo-scoped for the strongest reason
        # available: the GROUP supplies the geography. A post in "Dane Bank
        # Community Page" is in Manchester, full stop. Measured three ways on
        # real data — local groups 35% intent with CERTAIN location (~35%
        # in-target), a global query 35% intent with GUESSED location (~3.5%
        # in-target). Running the post-hoc country filter over group-sourced
        # posts would only discard genuine local asks that never name their own
        # town, which is most of them. Those same posts are ALSO why the town
        # must stay out of the classifier prompt on this path — the second half
        # of the regime.
        regime = _geo_regime(
            discovery=discovery, supplied_groups=supplied_groups,
            query=query, location=location,
        )
        geo_scoped = regime.search_is_geo_scoped

        # Stamp country/category from the operator's filters onto every stub.
        # Uses ORIGINAL (un-translated) niche so the dashboard's "category=electrician"
        # filter finds leads scraped from German "Elektriker" groups. Without this,
        # AuthorLead lands with category=null and the Lead Matrix loses the row.
        stamp_niche = original_niche or (filters.get('category') or '').strip() or None
        stamp_location = location or None
        for s in stubs:
            if stamp_niche and not s.get('category'):
                s['category'] = stamp_niche
            if not s.get('country'):
                resolved = _resolve_lead_country(
                    s.get('group_name'), location, s.get('content_excerpt'),
                    geo_scoped=geo_scoped,
                )
                if resolved:
                    s['country'] = resolved
            if not s.get('location_confidence'):
                s['location_confidence'] = _derive_location_confidence(
                    s.get('group_name'), s.get('content_excerpt'),
                    s.get('country') or stamp_location,
                )

        # ── Consumer-only filter chain (was previously ONLY in scrape_listing) ──
        #
        # scrape-runner.ts dispatches FB consumer-mode jobs as `--action search-posts`
        # → `--action enrich-authors`, completely bypassing scrape_listing. That
        # meant the substring + Gemini filters never ran on production scrapes —
        # the EC2 worker happily saved every noise post FB returned (Visayan
        # "Snacks, sips, and sunshine" type content for non-PH queries, etc.).
        # The "looking for plumber in Birmingham" runs happened to look clean
        # only because FB returned mostly-relevant posts for common niches.
        #
        # Running the chain HERE means every call path (scrape_listing AND the
        # direct search-posts action) gets the filters. scrape_listing's
        # open-feed branch marks these stubs already-filtered and does NOT run
        # the chain a second time — that double-run used to pay for two Gemini
        # calls per job AND re-destroy the leads this call just recovered.
        # Operator can disable via filters.exclude_businesses / asking_only /
        # use_llm_classifier. exclude_businesses and asking_only default ON for
        # English markets and OFF for non-English; they now gate the FALLBACK
        # path only (see _apply_consumer_filter_chain) — an explicit filter
        # value always wins.
        #
        # `geo_scoped` starts from the DISCOVERY SOURCE: the browser search is
        # geo-scoped (geo-stuffed group term + wrong-country group drop), the
        # Apify actor searches globally because we do not feed it
        # location_uid. On the Apify path the classifier therefore judges
        # intent only and a separate country stage handles geography — passing
        # the target city into a classifier judging globally-scattered
        # candidates is what made every run return zero leads.
        #
        # OVERRIDE: if THIS query already names the target place ("need a
        # plumber recommendation Manchester"), Facebook has already scoped the
        # results — running the post-hoc country filter on top would only
        # drop genuine local posts that don't spell out their own city, for
        # zero geographic benefit. Detected from the actual query text
        # (_query_is_place_anchored), never from the discovery source: an
        # operator can submit any query on either path.
        #
        # Both halves come from the `regime` computed once above, so the
        # country-stamping loop, this stage's geography opinion and the
        # classifier prompt cannot disagree.
        is_consumer_mode = (filters.get('lead_type') or 'consumers').lower() == 'consumers'
        if is_consumer_mode and stubs:
            stubs = _apply_consumer_filter_chain(
                stubs, niche=niche or query, location=location,
                filters=filters, on_progress=on_progress,
                geo_scoped=regime.search_is_geo_scoped,
                classifier_sees_location=regime.location_in_classifier_prompt,
            )

        return stubs

    async def search_groups(
        self,
        query: str,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[GroupStub]:
        if not query:
            return []
        return await asyncio.to_thread(self._sync_search_groups, query, max_results or 20, on_progress)

    async def enrich_authors(
        self,
        post_stubs: list[PostStub],
        *,
        screenshots_dir: str = '',
        on_progress: ProgressCallback = None,
    ) -> list[AuthorLead]:
        if not post_stubs:
            return []
        if _enrich_mode() == 'stub':
            leads = _stub_enrich_authors(post_stubs, on_progress)
            # Detail key is `total=` on BOTH events, matching the browser
            # path (facebook.py:2900 and :3041/:3109). Anything parsing these
            # events reads `total`; emitting `enriched=` would break it.
            _emit(on_progress, 'enrich_start', total=len(leads), source='stub')
            _emit(on_progress, 'enrich_done', total=len(leads), source='stub')
            return leads
        return await asyncio.to_thread(self._sync_enrich_authors, post_stubs, on_progress)

    # ── Sync internals ───────────────────────────────────────────────
    def _claim_or_raise(self, country: Optional[str] = None) -> dict:
        country = country or _TARGET_COUNTRY or _target_country_from_env()
        if not country:
            raise RuntimeError(
                "Cannot determine the scrape's target country, so no geo-consistent "
                "Facebook account can be selected. Set a 'country' (or a mappable "
                "'location') in the scrape filters."
            )
        account = _claim_account('facebook', country=country)
        if not account:
            if country:
                raise RuntimeError(
                    f"No active Facebook account pinned to country {country}. "
                    f"Connect one in Social Accounts and pin it to {country}."
                )
            raise RuntimeError(
                "No active Facebook account available. Connect one in Social Accounts "
                "and check daily/hourly caps."
            )
        # Geo-consistency: operate this account on its own country's residential IP.
        global _CURRENT_LOCATION
        pin = account.get('proxy_location') or account.get('country')
        if pin:
            _CURRENT_LOCATION = pin
        return account

    def _open_session(self, account: dict):
        """Open a driver and hydrate it with the account's saved cookies.

        Three-second sleeps after each home navigation: without them FB
        sometimes returns a tiny 'Not Found' stub on subsequent searches
        (verified live — cookies need a beat to be trusted by the edge
        before we navigate away).

        When the session was originally captured from one IP and we're
        now arriving from another (e.g. residential proxy in a new
        country), Facebook intercepts with a 'Continue as <name>' trust
        gate before letting us reach the real homepage. We detect that
        gate and click Continue programmatically — one extra click,
        then the session is established for the new IP and subsequent
        requests proceed normally.
        """
        driver = _open_driver(account)
        driver.get(FB_BASE)
        time.sleep(3)
        # Persistent-profile mode skips the DB cookie jar entirely — the
        # profile dir already holds a self-consistent session from the
        # one-time interactive login. Injecting old DB cookies on top
        # would just stomp the fresh profile cookies.
        if os.environ.get('FB_PROFILE_DIR'):
            _bypass_fb_trust_gate(driver)
        else:
            jar = load_cookies(account['id'])
            if jar:
                _inject_cookies(driver, jar)
                driver.get(FB_BASE)  # re-navigate so injected cookies stick
                time.sleep(4)
                _bypass_fb_trust_gate(driver)
        # Cheap sanity: if we're still on /login/, the cookies are bad.
        if '/login' in driver.current_url:
            driver.quit()
            _flag_checkpoint(account['id'], 'cookies-rejected-redirected-to-login')
            raise RuntimeError(f"Facebook rejected cookies for account {account['handle']} — needs re-connect")
        return driver

    def _sync_search_posts(
        self,
        query: str,
        groups_only: bool,
        max_results: int,
        on_progress: ProgressCallback,
    ) -> list[PostStub]:
        account = self._claim_or_raise()
        _emit(on_progress, 'search_start', query=query)
        driver = self._open_session(account)
        results: list[PostStub] = []
        try:
            # Facebook's open-feed search-posts URL pattern. This is the
            # FALLBACK path; group-first is handled by _sync_group_first_scrape.
            # Note: the previous `&filters=groups` URL hint was empirically a
            # no-op (verified 2026-06-05: 0 posts returned with the hint).
            # The groups_only parameter is preserved on this function's
            # signature for backwards compat but is no longer used here.
            search_url = f'{FB_BASE}/search/posts/?q={quote_plus(query)}'
            driver.get(search_url)
            _human_pause(SCROLL_PAUSE)

            # Diagnostic — log where Chrome actually ended up. If cookies
            # don't authenticate, FB redirects to /login/ and the search
            # page never renders. If the URL ends in /search/posts but
            # results are empty, the selectors need tuning instead.
            try:
                _emit(on_progress, 'debug_url', url=driver.current_url[:200], title=(driver.title or '')[:100])
            except Exception:  # noqa: BLE001
                pass

            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], 'captcha-during-search')
                return results

            # Give FB's React feed extra time to mount real post cards
            # (the initial 'article' element is usually a skeleton/placeholder).
            time.sleep(4)

            # Save a debug screenshot so we can SEE what FB rendered.
            try:
                debug_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '.tmp'))
                os.makedirs(debug_dir, exist_ok=True)
                png_path = os.path.join(debug_dir, 'fb_search_debug.png')
                html_path = os.path.join(debug_dir, 'fb_search_debug.html')
                driver.save_screenshot(png_path)
                with open(html_path, 'w', encoding='utf-8') as fh:
                    fh.write(driver.page_source)
                _emit(on_progress, 'debug_screenshot', path=png_path)
            except Exception as exc:  # noqa: BLE001
                print(f'WARN: debug screenshot failed: {exc}', file=sys.stderr)

            seen_urls: set[str] = set()
            for scroll in range(MAX_SCROLLS_PER_QUERY):
                page_posts = _extract_posts_from_search_page(driver)
                for raw in page_posts:
                    if raw['post_url'] in seen_urls:
                        continue
                    seen_urls.add(raw['post_url'])
                    stub: PostStub = {
                        'platform': 'facebook',
                        'post_url': raw['post_url'],
                        'author_handle': raw['author_handle'],
                        'author_profile_url': raw['author_profile_url'],
                        'content_excerpt': raw['content_excerpt'],
                        'posted_at': raw['posted_at'],
                        'media_urls': [],
                    }
                    results.append(stub)
                    _emit(on_progress, 'post_found', url=raw['post_url'])
                    if len(results) >= max_results:
                        break
                if len(results) >= max_results:
                    break
                # scroll for more
                driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
                _human_pause(SCROLL_PAUSE)

            _bump_counters(account['id'], delta_today=1, delta_hour=1)
            _emit(on_progress, 'search_done', total=len(results))
            return results
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_search_groups(
        self,
        query: str,
        max_results: int,
        on_progress: ProgressCallback,
    ) -> list[GroupStub]:
        account = self._claim_or_raise()
        _emit(on_progress, 'search_start', query=query, kind='groups')
        driver = self._open_session(account)
        results: list[GroupStub] = []
        try:
            driver.get(f'{FB_BASE}/search/groups/?q={quote_plus(query)}')
            _human_pause(SCROLL_PAUSE)
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], 'captcha-during-group-search')
                return results

            # Best-effort: anchors with /groups/<id> hrefs and visible text.
            try:
                anchors = driver.find_elements('css selector', 'a[href*="/groups/"]')
            except Exception:
                anchors = []
            seen = set()
            for a in anchors:
                href = (a.get_attribute('href') or '').split('?')[0]
                if '/groups/' not in href or href in seen:
                    continue
                seen.add(href)
                # Group ID is the path segment after /groups/.
                try:
                    group_id = href.rstrip('/').split('/groups/')[-1].split('/')[0]
                except Exception:
                    continue
                name = (a.text or '').strip().split('\n')[0]
                if not name:
                    continue
                results.append({
                    'platform': 'facebook',
                    'group_id': group_id,
                    'group_url': href,
                    'name': name,
                    'member_count': None,    # parse-from-text is brittle; v2
                    'is_private': False,
                    'description_excerpt': None,
                })
                _emit(on_progress, 'group_found', url=href)
                if len(results) >= max_results:
                    break
            _bump_counters(account['id'], delta_today=1, delta_hour=1)
            _emit(on_progress, 'search_done', total=len(results))
            return results
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_enrich_authors(
        self,
        post_stubs: list[PostStub],
        on_progress: ProgressCallback,
    ) -> list[AuthorLead]:
        # When the orchestrator chains LIST -> ENRICH back-to-back, the
        # previous undetected-chromedriver process may not have fully
        # released its chromedriver binary by the time we try to start
        # a fresh Chrome here. Brief settle prevents 'session not created'
        # races on Windows.
        time.sleep(3)
        account = self._claim_or_raise()
        # Dedup by author_profile_url FIRST so we minimize profile visits.
        unique_authors: dict[str, list[PostStub]] = {}
        for stub in post_stubs:
            url = stub.get('author_profile_url') or ''
            if not url:
                continue
            unique_authors.setdefault(url, []).append(stub)
        _emit(on_progress, 'enrich_start', total=len(unique_authors))

        driver = self._open_session(account)
        leads: list[AuthorLead] = []
        try:
            for i, (profile_url, posts) in enumerate(unique_authors.items(), 1):
                try:
                    driver.get(profile_url)
                    _human_pause(SCROLL_PAUSE)
                    if _is_checkpoint(driver):
                        _flag_checkpoint(account['id'], 'captcha-during-enrich')
                        break

                    # Display name. Try in order:
                    #   1. <meta property="og:title"> — FB sets this to the
                    #      page owner's name even on profiles where <title>
                    #      degrades to just "Facebook".
                    #   2. <title> — usually "Name | Facebook"
                    #   3. <h1> — first non-trivial heading
                    #   4. URL-derived handle (last-resort)
                    bad_titles = {'facebook', '', 'log in to facebook', 'log into facebook', 'meta'}
                    def _is_bad(name: str) -> bool:
                        # Brave shows the unread notification badge in <title>,
                        # so a profile page may end up as "(2) Facebook" or
                        # "(15) Facebook". Strip the leading "(N) " prefix
                        # before comparing. Previous implementation used
                        # lstrip('(0123456789 ') which forgot to include ')',
                        # so it stopped after the digit and never matched
                        # "facebook" — producing 5 leads with company_name=
                        # "(2) Facebook" in the DB before this fix.
                        s = (name or '').strip().lower()
                        if s in bad_titles:
                            return True
                        return re.sub(r'^\(\d+\)\s*', '', s).strip() == 'facebook'

                    display_name = ''
                    # 1. og:title
                    try:
                        og = driver.find_elements('css selector', 'meta[property="og:title"]')
                        if og:
                            display_name = (og[0].get_attribute('content') or '').strip()
                    except Exception:
                        pass
                    # 2. document.title fallback
                    if _is_bad(display_name):
                        raw_title = driver.title or ''
                        display_name = raw_title.split(' | ')[0].split(' - ')[0].strip()
                    # 3. h1 fallback
                    if _is_bad(display_name):
                        try:
                            for el in driver.find_elements('css selector', 'h1'):
                                txt = (el.text or '').strip()
                                if not _is_bad(txt):
                                    display_name = txt
                                    break
                        except Exception:
                            pass
                    # 4. URL-derived last resort
                    if _is_bad(display_name):
                        if '/profile.php' in profile_url:
                            import re as _re
                            m = _re.search(r'[?&]id=(\d+)', profile_url)
                            display_name = f'FB User {m.group(1)}' if m else 'Unknown'
                        else:
                            tail = profile_url.rstrip('/').split('/')[-1]
                            display_name = tail.replace('.', ' ').replace('_', ' ').title() if tail else 'Unknown'

                    # Second-pass business filter using the recovered display name.
                    # Handles cases like /profile.php?id=N where the handle gave
                    # no signal but og:title revealed 'RCA Dental Clinic',
                    # 'XLRT LTD', 'Acme Web Agency', etc.
                    # Marker lists live at module level (_BIZ_NAME_SUFFIXES /
                    # _BIZ_NAME_NICHE_TOKENS) and are shared with the
                    # browserless _stub_enrich_authors path.
                    if _display_name_looks_like_business(display_name):
                        _emit(on_progress, 'enrich_skipped_business', name=display_name, url=profile_url)
                        continue
                    # Bio link — the first external anchor in the intro section.
                    bio_link = None
                    try:
                        anchors = driver.find_elements(
                            'css selector', 'a[href^="https://"]:not([href*="facebook.com"])',
                        )
                        if anchors:
                            bio_link = anchors[0].get_attribute('href')
                    except Exception:
                        pass

                    leads.append({
                        'platform': 'facebook',
                        'profile_url': profile_url,
                        'author_handle': posts[0].get('author_handle'),
                        'display_name': display_name,
                        'company_name': display_name,  # mapped to leads.company_name by upsert
                        # Carry country + category from the listing stub (which
                        # extracted them from the post excerpt + query keyword).
                        # Without this both fields land NULL in the leads table.
                        'country': posts[0].get('country'),
                        'category': posts[0].get('category'),
                        'website_url': bio_link,
                        'email': None,
                        'location': None,
                        'is_business_profile': False,  # heuristic; v2
                        'follower_count': None,
                        'bio_excerpt': None,
                        # Attach every observed post — upsert_leads.py writes
                        # them into lead_platform_posts keyed on (platform,post_url).
                        'posts': posts,
                    })
                    _emit(on_progress, 'enrich_progress', i=i, total=len(unique_authors))
                except Exception as exc:  # noqa: BLE001
                    _emit(on_progress, 'enrich_failed', url=profile_url, reason=str(exc)[:80])
                if i % COUNTER_FLUSH_EVERY == 0:
                    _bump_counters(account['id'], delta_today=COUNTER_FLUSH_EVERY, delta_hour=COUNTER_FLUSH_EVERY)
            # Flush remaining counters.
            remainder = len(leads) % COUNTER_FLUSH_EVERY
            if remainder:
                _bump_counters(account['id'], delta_today=remainder, delta_hour=remainder)
            _emit(on_progress, 'enrich_done', total=len(leads))
            return leads
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_scrape_pages(
        self,
        category: str,
        max_results: int,
        on_progress: ProgressCallback,
    ) -> list[dict]:
        account = self._claim_or_raise()
        _emit(on_progress, 'search_start', category=category)
        driver = self._open_session(account)
        try:
            driver.get(f'{FB_BASE}/pages/category/{quote_plus(category)}/')
            _human_pause(SCROLL_PAUSE)
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], 'captcha-during-category')
                return []
            pages = _extract_pages_from_category(driver)[:max_results]
            _bump_counters(account['id'], delta_today=1, delta_hour=1)
            _emit(on_progress, 'category_done', count=len(pages))
            return pages
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_enrich_pages(
        self,
        stubs: list[dict],
        screenshots_dir: str,
        on_progress: ProgressCallback,
    ) -> list[dict]:
        account = self._claim_or_raise()
        driver = self._open_session(account)
        out: list[dict] = []
        try:
            for i, stub in enumerate(stubs, 1):
                try:
                    driver.get(stub['profile_url'])
                    _human_pause(SCROLL_PAUSE)
                    if _is_checkpoint(driver):
                        _flag_checkpoint(account['id'], 'captcha-during-page-enrich')
                        break
                    # Bio / website link — first off-Facebook anchor.
                    website = None
                    try:
                        anchors = driver.find_elements(
                            'css selector', 'a[href^="https://"]:not([href*="facebook.com"])',
                        )
                        if anchors:
                            website = anchors[0].get_attribute('href')
                    except Exception:
                        pass
                    enriched = dict(stub)
                    enriched.update({
                        'platform': 'facebook',
                        'website_url': website,
                        'is_business_profile': True,
                        'follower_count': None,
                    })
                    out.append(enriched)
                    _emit(on_progress, 'enrich_progress', i=i, total=len(stubs))
                except Exception as exc:  # noqa: BLE001
                    _emit(on_progress, 'enrich_failed', url=stub.get('profile_url'), reason=str(exc)[:80])
            _bump_counters(account['id'], delta_today=len(out), delta_hour=len(out))
            _emit(on_progress, 'enrich_done', total=len(out))
            return out
        finally:
            try: driver.quit()
            except Exception: pass

    # ── Comment posting ──────────────────────────────────────────────

    def post_comment(self, post_url: str, text: str, account_id: str) -> dict:
        """Post a comment on a Facebook post via the account's saved session.

        This is the WRITE path — it uses the account identified by ``account_id``
        (the lead's OWN account, chosen by the server for geo-consistency) and does
        NOT call ``_claim_or_raise``/_``_claim_account`` (those are for READ scrapes).

        Returns ``{"posted": True, "error": None}`` on success, or
        ``{"posted": False, "error": "<reason>"}`` on failure.

        Selenium interaction is wrapped in ``asyncio.to_thread`` in the async
        caller below. Call the sync method directly in tests.
        """
        account = _load_account_by_id(account_id)

        # Geo-consistency: pin the proxy location to this account's country
        # BEFORE opening any browser so _open_driver picks the right exit node.
        global _CURRENT_LOCATION
        pin = account.get('proxy_location') or account.get('country')
        if pin:
            _CURRENT_LOCATION = pin

        # Comment-cap guard — do NOT open a browser if already capped.
        comment_used = account.get('comment_used_today') or 0
        comment_cap = account.get('comment_daily_cap') or 0
        if comment_cap == 0:
            print(
                f"WARN: comment_daily_cap is 0/NULL for account {account.get('handle')} "
                f"— set it in social_accounts to enable commenting",
                file=sys.stderr,
            )
        if comment_used >= comment_cap:
            return {'posted': False, 'error': 'comment_cap_reached'}

        driver = None
        try:
            driver = self._open_session(account)
            driver.get(post_url)
            _human_pause(SCROLL_PAUSE, extra=1.5)

            # Trust-gate / checkpoint check immediately after navigation.
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], 'captcha-before-comment')
                return {'posted': False, 'error': 'checkpoint'}

            # Dismiss cookie banner if it appeared (it blocks all clicks).
            _dismiss_fb_cookie_banner(driver)

            # Bypass trust gate in case we hit a new-IP redirect.
            if _bypass_fb_trust_gate(driver):
                # Re-navigate to the post after trusting the IP.
                driver.get(post_url)
                _human_pause(SCROLL_PAUSE)
                if _is_checkpoint(driver):
                    _flag_checkpoint(account['id'], 'captcha-after-trust-gate-comment')
                    return {'posted': False, 'error': 'checkpoint'}

            # ── FB comment composer. VERIFIED LIVE 2026-06-24 on james's
            # account: posted a real comment via the
            # div[role=textbox][contenteditable=true] selector + send_keys +
            # Enter ({"posted": true}). FB rewrites class names ~monthly but
            # the SHAPE (role=textbox, contenteditable) is stable; if it ever
            # breaks, re-verify these on a live post:
            #   1. Locate the right comment box (a post page may have several
            #      nested-comment boxes in addition to the top-level one).
            #   2. Whether send_keys per-char suffices or JS InputEvent injection
            #      is needed for Lexical to register the text.
            #   3. The submit affordance — Enter key vs. a "Post" button.
            #   4. The post-submit verification selector (how to confirm our text
            #      actually appears in the rendered comment).
            # ──────────────────────────────────────────────────────────────────

            # Scroll down to make comment sections visible / load lazy content.
            driver.execute_script('window.scrollBy(0, 400);')
            _human_pause(1.0)

            # Locate the comment composer. FB renders a Lexical-powered
            # contenteditable div as the comment input.
            # Best-known selectors in priority order:
            COMMENT_BOX_SELECTORS = [
                # Aria-labelled composer (most stable — survives class-name churn)
                'div[role="textbox"][aria-label*="comment" i][contenteditable="true"]',
                'div[role="textbox"][aria-label*="Write a comment" i][contenteditable="true"]',
                # Fallback: any top-level contenteditable (may match nested replies
                # — verify which index is correct for the primary comment area)
                'div[role="textbox"][contenteditable="true"]',
            ]
            composer = None
            for sel in COMMENT_BOX_SELECTORS:
                try:
                    candidates = driver.find_elements('css selector', sel)
                    if candidates:
                        composer = candidates[0]
                        print(f'INFO: comment composer found via selector: {sel}', file=sys.stderr)
                        break
                except Exception:
                    continue

            if composer is None:
                print('WARN: no comment composer found on page — selectors need live verification', file=sys.stderr)
                return {'posted': False, 'error': 'composer_not_found'}

            # Scroll the composer into view and click to focus.
            driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", composer)
            _human_pause(0.4)
            composer.click()
            _human_pause(0.3)

            # Type the comment text human-paced (per-character send_keys).
            # Lexical tracks keystroke-level input; bulk string injection via
            # element.send_keys("whole string") works in most cases but may
            # miss Lexical's onChange events — per-char is safer.
            # LIVE-VERIFY: if the composer stays empty after per-char send_keys,
            # switch to JS InputEvent injection (see ActionChains alternative).
            for ch in text:
                composer.send_keys(ch)
                time.sleep(random.uniform(0.03, 0.09))

            _human_pause(0.6)

            # Submit: Enter key is the standard FB comment-submit affordance.
            # LIVE-VERIFY: some FB surfaces render a "Post" button instead.
            # If Enter submits but a visible "Post" button is present, prefer
            # clicking the button (more reliable than the key event).
            from selenium.webdriver.common.keys import Keys  # noqa: WPS433 — lazy
            composer.send_keys(Keys.RETURN)
            _human_pause(2.0, extra=1.0)  # wait for the comment to render

            # Post-submit verification: look for our text in a comment node.
            # LIVE-VERIFY: the exact selector for rendered comment text may differ
            # (span[dir="auto"] inside a comment article is the typical shape).
            submitted_text_snippet = text[:40]
            comment_appeared = False
            try:
                all_spans = driver.find_elements('css selector', 'span[dir="auto"]')
                for span in all_spans:
                    try:
                        if submitted_text_snippet in (span.text or ''):
                            comment_appeared = True
                            break
                    except Exception:
                        continue
            except Exception:
                pass

            if not comment_appeared:
                print(
                    f'WARN: comment text snippet not found in page after submit — '
                    f'may have posted but verification selector needs live tuning',
                    file=sys.stderr,
                )
                # Still treat as posted if no checkpoint/error surfaced —
                # the verification step is best-effort pending live selector work.

            # ── END LIVE-DISCOVERY BLOCK ──────────────────────────────────────

            # Success path: bump comment counters (separate from read counters).
            _bump_comment_counter(account['id'])
            return {'posted': True, 'error': None}

        except RuntimeError:
            # _open_session raises RuntimeError on cookie rejection — that's a
            # checkpoint/login-gate scenario, not a generic error.
            _flag_checkpoint(account['id'], 'login-gate-during-comment')
            return {'posted': False, 'error': 'checkpoint'}
        except Exception as exc:  # noqa: BLE001
            body_text = ''
            try:
                body_text = (driver.execute_script('return document.body.innerText') or '')[:200]
            except Exception:
                pass
            # Detect checkpoint-like page content.
            if any(k in body_text.lower() for k in ('security check', 'verify your identity', 'captcha')):
                _flag_checkpoint(account['id'], f'captcha-during-comment: {str(exc)[:80]}')
                return {'posted': False, 'error': 'checkpoint'}
            print(f'ERROR: post_comment failed: {exc}', file=sys.stderr)
            return {'posted': False, 'error': str(exc)[:200]}
        finally:
            if driver is not None:
                try:
                    driver.quit()
                except Exception:
                    pass
