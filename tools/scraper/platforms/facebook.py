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
import re
import sys
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus

from tools.scraper.platforms._social_base import (
    AuthorLead,
    GroupStub,
    PostStub,
    SocialPlatformScraper,
)
from tools.scraper.platforms.base import FilterField, ProgressCallback
from tools.db.supabase_client import table
from tools.scraper.shared.session_store import load_cookies, save_cookies

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _emit(on_progress: ProgressCallback, stage: str, **detail) -> None:
    """Emit a canonical PROGRESS:<stage>:<detail> line + callback."""
    payload = {'stage': stage, **detail}
    if on_progress:
        on_progress(payload)
    parts = [f'PROGRESS:{stage}']
    for k, v in detail.items():
        parts.append(f'{k}={v}')
    print(':'.join(parts) if len(parts) == 1 else parts[0] + ':' + ' '.join(parts[1:]), flush=True)


def _claim_account(platform: str = 'facebook') -> Optional[dict]:
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
    rows = (
        table('social_accounts')
        .select('id,platform,handle,daily_cap,hourly_cap,used_today,used_this_hour,encrypted_cookies,last_used_at')
        .eq('platform', platform)
        .eq('status', 'active')
        .order('used_today', desc=False)
        .limit(5)
        .execute()
        .data
    )
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


def _classify_consumer_posts_with_gemini(
    post_excerpts: list[str],
    niche: str,
    *,
    location: Optional[str] = None,
    timeout_s: int = 30,
) -> Optional[list[bool]]:
    """Send a batch of post excerpts to Gemini Flash and return per-post
    consumer-or-not verdicts.

    Returns a list[bool] aligned 1:1 with post_excerpts (True = real
    consumer ask, False = drop). Returns None when the API key isn't
    configured, the request fails, or the response can't be parsed —
    callers should treat None as "skip the LLM stage, keep substring
    filter verdicts".

    Cost-aware: batches up to 50 excerpts per call (well under
    Gemini's input limit). One call per scrape, not per post.
    """
    api_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')
    if not api_key or not post_excerpts:
        return None

    # Build a numbered list so the model can return verdicts indexed
    # by position. JSON-structured output avoids parse drift.
    numbered = '\n'.join(
        f'[{i}] {(text or "")[:400]}'
        for i, text in enumerate(post_excerpts)
    )

    location_clause = (
        f'\n\nTARGET LOCATION: "{location}".\n'
        f'  - The post must be about a job IN or NEAR {location}. A different city or '
        f'    region in the same country (e.g. operator searched London, post is from '
        f'    Manchester or Bury) is FALSE.\n'
        f'  - Surrounding boroughs / suburbs / postcodes of {location} count as the same '
        f'    location. Example: searching London, a post mentioning E1 / Croydon / '
        f'    Camden / Greater London passes.\n'
        f'  - THE AUTHOR NAME IS NOT A LOCATION SIGNAL. If the author is called "Yvette Rome" '
        f'    or "John London" or "Sarah Paris", that is a SURNAME / COINCIDENCE, not evidence '
        f'    that the post is from the target city. Only the post body, attached photo text, '
        f'    or explicit FB metadata (e.g. "in Manchester, United Kingdom") counts as a '
        f'    location signal.\n'
        f'  - The post can be in ANY language (English, German, French, Italian, Spanish, '
        f'    Portuguese, Polish, etc.). Judge the location signal by the city/neighborhood '
        f'    NAMES in the post text — those names render the same way regardless of the '
        f'    post language. A German post saying "ich suche einen Elektriker in Frankfurt-'
        f'    Sachsenhausen" has a clear Frankfurt signal even though the language is German. '
        f'    Conversely, a German post with NO mention of {location} or any neighborhood of '
        f'    {location} should classify FALSE — we can\'t verify it\'s from there.\n'
        if location else ''
    )

    prompt = f"""You are classifying Facebook group posts to find PROSPECTS — private individuals who currently need to hire someone specifically for "{niche}".

For each numbered post, answer TRUE or FALSE.

NICHE MATCH (strict): the post must be asking for "{niche}" or an exact synonym, NOT a related trade.
  - "Website builder" search: a post asking for a "website developer" or "web designer" passes. A post asking for a "bathroom builder", "house builder", or any physical-construction "builder" is FALSE — different service entirely, only the word matches.
  - "Plumber" search: a post asking for a "plumbing engineer" or "heating engineer" passes. A "handyman" who happens to do plumbing as a side skill is FALSE unless they explicitly mention the plumbing job is the ask.
  - "Dentist" search: orthodontist / dental hygienist / oral surgeon pass. GP, doctor, or unrelated medical specialist is FALSE.
  - When in doubt about whether two services are the same, default to FALSE. We'd rather miss a marginal lead than send cold outreach to someone in the wrong industry.
{location_clause}
TRUE — the author is a private individual or household describing a SPECIFIC personal need FOR THE NICHE:
  - mentions a property, address, postcode, "my house", "my flat", "my mum's"
  - one-off job: install, fix, repair, replace, advice for a personal situation
  - asking on behalf of a family member or friend counts (still a consumer lead)

FALSE — everything else, including:
  - WRONG NICHE — a builder when you wanted a website builder, etc. (see niche rules above)
  - WRONG LOCATION — different city when the operator targeted a specific one (see location rules above)
  - RHETORICAL HEADLINES — "Looking for X?" / "Need a Y?" / "Want a Z?" with no personal context, no address, no "my house / my flat / for my mum" follow-up. These are ad creatives where the body (truncated by FB's "See more") would continue "...we can help! Call us today / DM us / visit our site." If the excerpt is ONLY a question + brand-tagline shape, classify FALSE. A genuine consumer ask always has personal detail attached (a postcode, "my", "asap", "for the bathroom in our flat", etc.).
  - businesses advertising their own services ("Need a reliable plumber? Call us…")
  - clinics/contractors recruiting staff ("Looking for a Gas Safe engineer, full time")
  - agencies pitching websites / marketing / lead-gen to tradespeople
  - SaaS, AI, app, platform, or product pitches aimed at tradespeople
  - practitioner-to-practitioner networking ("Hey fellow plumbers, advice on getting leads?")
  - job seekers posting their CV / availability ("I have a diploma, looking for work")
  - business-partnership offers ("Looking for a master plumber to start a business")
  - past-tense / already-found posts ("Salamat Doc / had my procedure / went to…")
  - vague marketplace lead-gen posts with no concrete personal need

Return ONLY a JSON object with this exact shape, no preamble or markdown:
{{"verdicts": [true, false, true, ...]}}

The verdicts array MUST have exactly {len(post_excerpts)} entries in the same order as the input.

Posts:
{numbered}
"""

    # Same model the frontend's template generator uses, so we stay
    # consistent and the existing API key (which has access to it)
    # works without an additional quota request.
    url = (
        'https://generativelanguage.googleapis.com/v1beta/models/'
        f'gemini-2.5-flash:generateContent?key={api_key}'
    )
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.1,
            # Gemini 2.5 Flash spends "thinking tokens" before output.
            # 2048 was empirically too low when classifying 30+ posts in a
            # single call — the model burned the budget on reasoning and
            # the visible JSON came back truncated/empty. 8192 leaves plenty
            # of headroom (typical output is a list of ~30 booleans = ~200
            # tokens of actual JSON).
            'maxOutputTokens': 8192,
            'responseMimeType': 'application/json',
        },
    }

    try:
        import requests as _requests  # noqa: WPS433 — lazy
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
            # Defensive: empty response (thinking-budget exhausted OR safety
            # filter blocked it). Surface the full response body so the
            # caller can see in stderr/DB what Gemini actually returned.
            print(
                f'[gemini-classifier] empty response from Gemini (likely '
                f'thinking-budget exhausted); body summary: {str(body)[:500]}',
                file=sys.stderr,
            )
            return None
        parsed = json.loads(text)
        verdicts = parsed.get('verdicts')
        if not isinstance(verdicts, list) or len(verdicts) != len(post_excerpts):
            print(
                f'[gemini-classifier] verdict count mismatch '
                f'(expected {len(post_excerpts)}, got {len(verdicts) if isinstance(verdicts, list) else "non-list"})',
                file=sys.stderr,
            )
            return None
        return [bool(v) for v in verdicts]
    except Exception as exc:  # noqa: BLE001
        print(f'[gemini-classifier] failed, falling back to substring filter only: {exc}', file=sys.stderr)
        return None


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


def _extract_country_from_excerpt(text: str) -> Optional[str]:
    """Best-effort: scan a post excerpt for a city/region name and map to a
    country ISO code. Returns None when no known city is found. The map is
    intentionally narrow — only places we've actually seen leads in. Expand
    as new regions surface in real scrapes.

    For the dental-services-in-Cebu test data the cities Liloan, Mandaue,
    Mactan, Lapu-Lapu, Cebu all signal PH; the same pattern works for any
    region — add (city, country) pairs as you find them.
    """
    if not text:
        return None
    lowered = text.lower()
    # Order: most specific multi-word cities first so 'lapu-lapu city' matches
    # before a generic 'cebu' substring would.
    CITY_TO_COUNTRY = [
        # Order matters: multi-word cities first so 'cluj-napoca' matches
        # before a generic 'cluj' substring would, and 'new york' before
        # the word 'york' shows up in any other context.

        # ─── United Kingdom ─────────────────────────────────────
        ('london', 'GB'), ('manchester', 'GB'), ('birmingham', 'GB'),
        ('leeds', 'GB'), ('liverpool', 'GB'), ('bristol', 'GB'),
        ('edinburgh', 'GB'), ('glasgow', 'GB'),
        ('belfast', 'GB'), ('cardiff', 'GB'),
        # ─── Ireland ────────────────────────────────────────────
        ('dublin', 'IE'), ('cork', 'IE'), ('galway', 'IE'),
        # ─── Germany ────────────────────────────────────────────
        ('berlin', 'DE'), ('munich', 'DE'), ('hamburg', 'DE'),
        ('frankfurt', 'DE'), ('cologne', 'DE'), ('stuttgart', 'DE'),
        ('düsseldorf', 'DE'), ('dusseldorf', 'DE'), ('leipzig', 'DE'),
        # ─── France ─────────────────────────────────────────────
        ('paris', 'FR'), ('marseille', 'FR'), ('lyon', 'FR'),
        ('toulouse', 'FR'), ('nice', 'FR'), ('bordeaux', 'FR'),
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
    for needle, country in CITY_TO_COUNTRY:
        if needle in lowered:
            return country
    return None


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


def _detect_chrome_major_version() -> Optional[int]:
    """Read installed Chrome's major version so chromedriver matches.

    Supports Windows (typical dev machine) and Linux (EC2 worker / Cloud
    Run). On Linux, Chrome was installed via `apt install
    google-chrome-stable_current_amd64.deb` so the binary lives at
    /usr/bin/google-chrome. We call it with --version because Linux
    binaries don't expose VersionInfo the way Windows PEs do.
    """
    import re
    import subprocess
    win_candidates = [
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    ]
    linux_candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ]
    candidates = linux_candidates if sys.platform.startswith('linux') else win_candidates
    chrome_path = next((p for p in candidates if os.path.isfile(p)), None)
    if not chrome_path:
        return None
    try:
        if sys.platform.startswith('linux'):
            out = subprocess.check_output(
                [chrome_path, '--version'],
                text=True, timeout=5,
            ).strip()
        else:
            out = subprocess.check_output(
                ['powershell', '-NoProfile', '-Command',
                 f"(Get-Item '{chrome_path}').VersionInfo.ProductVersion"],
                text=True, timeout=5,
            ).strip()
        # Linux output: "Google Chrome 148.0.7778.215"
        # Windows output: "148.0.7778.215"
        m = re.search(r'(\d+)\.', out)
        return int(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        return None


# Module-level "current scrape context" — set by scrape_listing() at
# the top of each scrape and consumed by _open_driver() when it needs
# to pick a country code for the residential proxy. This avoids
# threading `location` through nine call sites (_open_session,
# _sync_discover_groups, _sync_group_first_scrape, ...). Each FB
# scrape runs in its own Python subprocess, so the global is process-
# scoped and safe from cross-job leakage.
_CURRENT_LOCATION: Optional[str] = None


def _build_proxy_auth_extension(host: str, port: str, username: str, password: str) -> str:
    """Generate a temporary Chrome extension that auto-fills proxy auth.

    Chrome's --proxy-server flag intentionally rejects user:pass@host:port
    URLs (security-by-design; the dialog has to be filled by the user OR
    by an extension). The well-known workaround is a tiny extension that
    registers a webRequest.onAuthRequired listener and answers with the
    credentials. We generate one per driver session, drop it in /tmp,
    and load it via options.add_extension().
    """
    import zipfile
    import tempfile
    import textwrap

    manifest = textwrap.dedent('''
        {
            "version": "1.0.0",
            "manifest_version": 2,
            "name": "Residential Proxy Auth",
            "permissions": [
                "proxy", "tabs", "unlimitedStorage", "storage",
                "<all_urls>", "webRequest", "webRequestBlocking"
            ],
            "background": {"scripts": ["background.js"]},
            "minimum_chrome_version": "22.0.0"
        }
    ''').strip()
    background = textwrap.dedent(f'''
        var config = {{
            mode: "fixed_servers",
            rules: {{
                singleProxy: {{
                    scheme: "http",
                    host: "{host}",
                    port: parseInt({port})
                }},
                bypassList: ["localhost"]
            }}
        }};
        chrome.proxy.settings.set({{value: config, scope: "regular"}}, function() {{}});
        chrome.webRequest.onAuthRequired.addListener(
            function(details) {{
                return {{authCredentials: {{username: "{username}", password: "{password}"}}}};
            }},
            {{urls: ["<all_urls>"]}},
            ['blocking']
        );
    ''').strip()
    fd, path = tempfile.mkstemp(suffix='_proxy_auth.zip')
    os.close(fd)
    with zipfile.ZipFile(path, 'w') as zp:
        zp.writestr('manifest.json', manifest)
        zp.writestr('background.js', background)
    return path


def _resolve_proxy_country(location: Optional[str], fallback: str = 'AT') -> str:
    """Pick the residential-proxy country code that matches the operator's
    location. Falls back to whatever country code is baked into the
    proxy credentials when we can't map the location.
    """
    if not location:
        return fallback
    cc = _extract_country_from_excerpt(location)
    return cc if cc else fallback


def _apply_proxy_country(username: str, cc: str) -> str:
    """Swap the country code inside a residential-proxy username so the
    proxy issues an IP from the requested country. Each provider has
    a slightly different convention:

      Proxy Lite : pl-XYZ_area-AT          -> pl-XYZ_area-GB
      Proxio     : abc-region-AT           -> abc-region-GB
      Bright Data: lum-customer-X-cc-at    -> lum-customer-X-cc-gb

    We pattern-match the common ones rather than hard-coding a single
    convention so swapping providers via env vars doesn't require code.
    """
    # _area-XX (Proxy Lite, Smartproxy variants)
    out = re.sub(r'(?<=_area-)[A-Za-z]{2}\b', cc.upper(), username)
    # -region-XX (Proxio)
    out = re.sub(r'(?<=-region-)[A-Za-z]{2}\b', cc.upper(), out)
    # _country-XX (Enigma format, but theirs is in the PASSWORD — see
    # _apply_proxy_country_password). Include here for providers that
    # use it in username too.
    out = re.sub(r'(?<=_country-)[A-Za-z]{2}\b', cc.upper(), out)
    # -cc-XX (some Bright Data variants)
    out = re.sub(r'(?<=-cc-)[A-Za-z]{2}\b', cc.lower(), out)
    return out


def _apply_proxy_country_password(password: str, cc: str) -> str:
    """Some providers put the country code in the PASSWORD slot
    (Enigma: 58fc5cbc0ebf_country-AT). Same pattern set, applied
    to the password string.
    """
    out = re.sub(r'(?<=_country-)[A-Za-z]{2}\b', cc.upper(), password)
    out = re.sub(r'(?<=_area-)[A-Za-z]{2}\b', cc.upper(), out)
    return out


def _open_driver():
    """Open an undetected-chromedriver, headless if PLAYWRIGHT_HEADLESS=true.

    On Linux hosts (EC2 worker / Cloud Run) AND when the
    RESIDENTIAL_PROXY_* env vars are set, routes all Chrome traffic
    through the residential proxy so Facebook sees a consumer IP
    instead of a datacenter IP. Windows / local runs use the
    operator's home IP directly — no point burning paid proxy
    bandwidth when FB already trusts the residential connection.
    """
    import undetected_chromedriver as uc  # noqa: WPS433 — lazy

    headless = os.getenv('PLAYWRIGHT_HEADLESS', 'false').lower() == 'true'
    # Persistent-profile mode (2026-05-30): when FB_PROFILE_DIR is set,
    # Chrome loads its entire user-data-dir from disk (cookies +
    # localStorage + IndexedDB + fingerprint state). The profile is
    # minted once by the operator via scripts/ec2-fb-login-session.sh
    # and reused by every subsequent scrape — same Chrome instance,
    # same fingerprint, no cross-machine cookie transplant for FB to
    # flag as a new device. FB_PROFILE_HEADFUL=true forces headful
    # (used by the login flow); scraping honors PLAYWRIGHT_HEADLESS.
    profile_dir = os.environ.get('FB_PROFILE_DIR')
    if profile_dir and os.environ.get('FB_PROFILE_HEADFUL', '').lower() == 'true':
        headless = False
    options = uc.ChromeOptions()
    # Browser binary resolution. By default undetected-chromedriver
    # auto-detects Google Chrome in standard locations. On the Windows
    # EC2 worker we use BRAVE instead (better fingerprint resistance,
    # no Google Chrome installed), so we set options.binary_location
    # explicitly. Order:
    #   1. BROWSER_BIN env var (override)
    #   2. Brave at common Windows paths (per-user LOCALAPPDATA first,
    #      then Program Files variants)
    #   3. Leave unset → uc auto-detects Chrome (Linux EC2 path)
    browser_bin = os.environ.get('BROWSER_BIN')
    if not browser_bin and sys.platform == 'win32':
        for candidate in (
            os.path.join(os.environ.get('LOCALAPPDATA', ''), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            r'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe',
            r'C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe',
        ):
            if candidate and os.path.exists(candidate):
                browser_bin = candidate
                break
    if browser_bin:
        options.binary_location = browser_bin
        print(f'INFO: using browser binary {browser_bin}', file=sys.stderr)
    if headless:
        options.add_argument('--headless=new')
    if profile_dir:
        # Clean up stale Brave/Chromium singleton lock files. When a prior
        # Brave crashed (or was killed) it leaves SingletonLock/Cookie/Socket
        # behind, and the next launch with --user-data-dir refuses to start.
        # Manifests as `undetected_chromedriver!GetHandleVerifier` native
        # crashes on the second invocation. Cleanup is safe because we only
        # remove these files when we are about to start the only legitimate
        # Brave that should be using this profile.
        for stale in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
            stale_path = os.path.join(profile_dir, stale)
            try:
                os.remove(stale_path)
                print(f'INFO: removed stale {stale} from profile', file=sys.stderr)
            except FileNotFoundError:
                pass
            except OSError as exc:
                print(f'WARN: could not remove {stale_path}: {exc}', file=sys.stderr)
        options.add_argument(f'--user-data-dir={profile_dir}')
        print(f'INFO: using persistent Chrome profile at {profile_dir}', file=sys.stderr)
    options.add_argument('--window-size=1280,900')
    options.add_argument('--lang=en-US,en')
    options.add_argument('--disable-blink-features=AutomationControlled')
    # Grant clipboard read/write so _click_share_and_capture() can read
    # the /share/p/<token>/ URL that FB writes when "Copy link" is clicked.
    # Without this Chrome blocks navigator.clipboard.readText() with
    # NotAllowedError. The "*" pattern grants for all origins (we're a
    # single-purpose scraper instance).
    options.add_experimental_option(
        'prefs',
        {
            'profile.content_settings.exceptions.clipboard': {
                '[*.]facebook.com,*': {'setting': 1},
            },
        },
    )
    # Linux-server essentials. Chrome's renderer process crashes
    # without these on headless EC2 / Cloud Run hosts because the
    # sandbox needs user-namespace cloning (not always available),
    # /dev/shm is tiny on most containers, and there's no GPU.
    # These flags are harmless on Windows dev machines but only
    # appended on Linux to keep dev-mode security checks intact.
    if sys.platform.startswith('linux'):
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')

    # Residential proxy wiring. Only kicks in on Linux (server) AND when
    # all four env vars are set. Local runs always use the host's own IP.
    proxy_host = os.environ.get('RESIDENTIAL_PROXY_HOST')
    proxy_port = os.environ.get('RESIDENTIAL_PROXY_PORT')
    proxy_user = os.environ.get('RESIDENTIAL_PROXY_USERNAME')
    proxy_pass = os.environ.get('RESIDENTIAL_PROXY_PASSWORD')
    proxy_force = os.environ.get('RESIDENTIAL_PROXY_FORCE', '').lower() == 'true'
    proxy_active = (
        (sys.platform.startswith('linux') or proxy_force)
        and proxy_host and proxy_port and proxy_user and proxy_pass
    )
    seleniumwire_options: Optional[dict] = None
    if proxy_active:
        cc = _resolve_proxy_country(_CURRENT_LOCATION)
        proxy_user_rewritten = _apply_proxy_country(proxy_user, cc)
        proxy_pass_rewritten = _apply_proxy_country_password(proxy_pass, cc)
        # selenium-wire intercepts traffic locally and handles proxy auth
        # in Python — required because Manifest V2 auth extensions are
        # silently disabled by Chrome 128+ in --headless=new mode (the
        # blank page we got from api.ipify.org through the proxy was
        # Chrome receiving a 407, no extension responding, page erroring
        # to ""). undetected-chromedriver detects seleniumwire_options
        # and uses selenium-wire's driver internally — same uc.Chrome
        # call, just with an extra kwarg.
        proxy_url = f'http://{proxy_user_rewritten}:{proxy_pass_rewritten}@{proxy_host}:{proxy_port}'
        seleniumwire_options = {
            'proxy': {
                'http': proxy_url,
                'https': proxy_url,
                'no_proxy': 'localhost,127.0.0.1',
            },
            # selenium-wire MITMs HTTPS to inspect requests — accepting
            # its self-signed CA is required for Chrome to trust the
            # intercepted certs. The CA is generated per process; no
            # security risk because nothing else trusts it.
            'verify_ssl': False,
            'disable_capture': True,
        }
        # Chrome refuses to load HTTPS pages through selenium-wire by
        # default because the MITM cert is signed by an unknown CA
        # (selenium-wire generates a per-process root CA in
        # ~/.mitmproxy and signs per-domain leaves). The proper fix is
        # to install that CA in the OS trust store, but for a scraper
        # process we just trust everything — the only "attacker" in
        # the cert chain is our own local interceptor.
        options.add_argument('--ignore-certificate-errors')
        options.add_argument('--ignore-ssl-errors=yes')
        options.add_argument('--allow-running-insecure-content')
        print(
            f'INFO: residential proxy active {proxy_host}:{proxy_port} cc={cc} (selenium-wire)',
            file=sys.stderr,
        )

    # Pin chromedriver to installed Chrome major version so we don't get
    # the version-149-but-Chrome-148 mismatch.
    version_main: Optional[int] = None
    override = os.getenv('SOCIAL_CHROME_VERSION')
    if override and override.isdigit():
        version_main = int(override)
    else:
        version_main = _detect_chrome_major_version()
    if version_main:
        print(f'INFO: pinning chromedriver to Chrome major version {version_main}', file=sys.stderr)
    if seleniumwire_options:
        # selenium-wire ships its own undetected-chromedriver wrapper —
        # plain `uc.Chrome(seleniumwire_options=...)` accepts the kwarg
        # but doesn't actually wire selenium-wire's interceptor in
        # (uc.Chrome forwards **kwargs to selenium's Chrome which then
        # silently drops the unknown kwarg). The Singapore EC2 IP we
        # got back from api.ipify.org through the proxy was the
        # signature: selenium-wire was being skipped, Chrome went
        # direct. The seleniumwire.undetected_chromedriver wrapper
        # registers the local intercepting proxy and patches Chrome's
        # --proxy-server flag to point at it, before delegating to
        # undetected-chromedriver for the stealth patches.
        from seleniumwire.undetected_chromedriver import Chrome as WireUCChrome  # noqa: WPS433
        driver = WireUCChrome(
            options=options,
            seleniumwire_options=seleniumwire_options,
            use_subprocess=True,
            version_main=version_main,
        )
    else:
        driver = uc.Chrome(options=options, use_subprocess=True, version_main=version_main)
    driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
    # CDP-level clipboard grant. Required for navigator.clipboard.readText()
    # to succeed in _click_share_and_capture(). The prefs route only covers
    # fresh profiles — existing user-data-dir profiles ignore it. CDP grant
    # applies to the live session unconditionally.
    try:
        driver.execute_cdp_cmd(
            'Browser.grantPermissions',
            {
                'origin': 'https://www.facebook.com',
                'permissions': ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            },
        )
    except Exception as exc:  # noqa: BLE001
        print(f'WARN: clipboard CDP grant failed (Share->Copy link fallback will not work): {exc}', file=sys.stderr)
    return driver


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
                    if '/profile.php' in href:
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
                time.sleep(SCROLL_PAUSE)
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
                    time.sleep(SCROLL_PAUSE)
                    if _is_checkpoint(driver):
                        _flag_checkpoint(account['id'], f'captcha-in-group-{g["group_id"]}')
                        _emit(on_progress, 'group_failed', group_id=g['group_id'], reason='captcha')
                        break
                    # Light scroll for lazy content
                    driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
                    time.sleep(SCROLL_PAUSE)
                    stubs = _extract_posts_from_group_search(driver, g)
                    if stubs:
                        aggregated.extend(stubs)
                        _emit(on_progress, 'group_posts_kept', count=len(stubs), group_name=g.get('name'))
                    _bump_counters(account['id'], delta_today=1, delta_hour=1)
                except Exception as exc:  # noqa: BLE001
                    _emit(on_progress, 'group_failed', group_id=g['group_id'], reason=str(exc)[:120])
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
            time.sleep(SCROLL_PAUSE * 2)
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], f'captcha-in-group-{group["group_id"]}')
                return results
            # Scroll a couple of times to load lazy content
            for _ in range(2):
                driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
                time.sleep(SCROLL_PAUSE)
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
        global _CURRENT_LOCATION
        _CURRENT_LOCATION = (
            (filters.get('location') or '').strip()
            or (filters.get('country') or '').strip()
            or None
        )

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
            if filters.get('groups_only') is False:
                query = ' '.join(p for p in (niche, location) if p)
                post_stubs = await self.search_posts(
                    query, filters, max_results=max_results, on_progress=on_progress,
                )
            else:
                post_stubs = await asyncio.to_thread(
                    self._sync_group_first_scrape, niche, location, on_progress,
                    _resolve_generic_cap(filters),
                )
            # Two-layer consumer-only filter:
            #  1. Drop business/ad posts (clinic handles, ad copy).
            #  2. Keep only posts that look like someone ACTIVELY ASKING
            #     for the service. Post-experience thank-you posts
            #     ('Salamat Doc...') and recommendations ('I recommend
            #     Dr.X') get dropped — those people already have a
            #     dentist, they're not leads.
            # Either filter is operator-overridable via filters.
            exclude_businesses, asking_only = _consumer_filter_defaults(filters, location)
            use_llm_classifier = filters.get('use_llm_classifier', True)
            if exclude_businesses or asking_only:
                before = len(post_stubs)
                kept: list = []
                for s in post_stubs:
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
                post_stubs = kept

            # LLM final-pass classifier. Substring patterns get us to
            # ~30% precision; Gemini Flash 2.0 lifts it to ~80-90% by
            # judging semantic intent (recruiter vs consumer, agency
            # pitch vs ask). Costs ~$0.01 per scrape (1 batched call).
            # Falls through silently when GEMINI_API_KEY isn't set or
            # the API errors — substring filter results stay in place.
            if use_llm_classifier and post_stubs:
                excerpts = [s.get('content_excerpt', '') or '' for s in post_stubs]
                verdicts = _classify_consumer_posts_with_gemini(
                    excerpts, niche, location=location,
                )
                if verdicts is not None:
                    llm_kept = [s for s, v in zip(post_stubs, verdicts) if v]
                    llm_dropped = len(post_stubs) - len(llm_kept)
                    if llm_dropped > 0:
                        _emit(on_progress, 'llm_filtered',
                              dropped=llm_dropped, kept=len(llm_kept),
                              reason='Gemini classifier flagged as non-consumer')
                    post_stubs = llm_kept
                else:
                    _emit(on_progress, 'llm_skipped',
                          reason='GEMINI_API_KEY missing or API error — substring filter only')

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
                    # Country = the location field the operator typed,
                    # verbatim. Previously we tried to auto-detect a country
                    # code from a hardcoded city list (PH-biased, useless
                    # for Brooklyn / London / Sydney). Operator-provided
                    # text is the ground truth — Lead Matrix surfaces it
                    # as-is.
                    'country': location or None,
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

        if groups_only:
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
        # Stamp country/category from the operator's filters onto every stub.
        # Uses ORIGINAL (un-translated) niche so the dashboard's "category=electrician"
        # filter finds leads scraped from German "Elektriker" groups. Without this,
        # AuthorLead lands with category=null and the Lead Matrix loses the row.
        stamp_niche = original_niche or (filters.get('category') or '').strip() or None
        stamp_location = location or None
        for s in stubs:
            if stamp_niche and not s.get('category'):
                s['category'] = stamp_niche
            if stamp_location and not s.get('country'):
                s['country'] = stamp_location

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
        # Moving the chain HERE means every call path (scrape_listing AND the
        # direct search-posts action) gets the filters. The duplicate filter
        # block in scrape_listing becomes a no-op on already-clean stubs.
        # Operator can disable via filters.exclude_businesses / asking_only /
        # use_llm_classifier (all default True).
        is_consumer_mode = (filters.get('lead_type') or 'consumers').lower() == 'consumers'
        if is_consumer_mode and stubs:
            exclude_businesses, asking_only = _consumer_filter_defaults(filters, location)
            use_llm_classifier = filters.get('use_llm_classifier', True)

            if exclude_businesses or asking_only:
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
                stubs = kept

            # LLM final-pass — substring patterns are ~30% precision; Gemini Flash
            # lifts to ~80-90% by judging semantic intent. Falls through silently
            # when GEMINI_API_KEY isn't set or the API errors.
            if use_llm_classifier and stubs:
                excerpts = [s.get('content_excerpt', '') or '' for s in stubs]
                niche_for_llm = niche or query
                verdicts = _classify_consumer_posts_with_gemini(
                    excerpts, niche_for_llm, location=location,
                )
                if verdicts is not None:
                    llm_kept = [s for s, v in zip(stubs, verdicts) if v]
                    llm_dropped = len(stubs) - len(llm_kept)
                    if llm_dropped > 0:
                        _emit(on_progress, 'llm_filtered',
                              dropped=llm_dropped, kept=len(llm_kept),
                              reason='Gemini classifier flagged as non-consumer')
                    stubs = llm_kept
                else:
                    _emit(on_progress, 'llm_skipped',
                          reason='GEMINI_API_KEY missing or API error — substring filter only')

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
        return await asyncio.to_thread(self._sync_enrich_authors, post_stubs, on_progress)

    # ── Sync internals ───────────────────────────────────────────────
    def _claim_or_raise(self) -> dict:
        account = _claim_account('facebook')
        if not account:
            raise RuntimeError(
                "No active Facebook account available. Connect one in Social Accounts "
                "and check daily/hourly caps."
            )
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
        driver = _open_driver()
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
            time.sleep(SCROLL_PAUSE)

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
                time.sleep(SCROLL_PAUSE)

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
            time.sleep(SCROLL_PAUSE)
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
                    time.sleep(SCROLL_PAUSE)
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
                    #
                    # Generic biz suffixes (ltd/inc/llc/corp/...) catch profiles
                    # that are clearly companies, not individuals. Medical-niche
                    # tokens stay because plumber/handyman searches commonly
                    # surface medical-clinic ads that happen to mention the niche.
                    biz_suffixes = (
                        # Company-form markers
                        ' ltd', ' ltd.', ' limited', ' inc', ' inc.', ' llc',
                        ' corp', ' corp.', ' corporation', ' co.', ' co ',
                        ' plc', ' gmbh', ' s.r.l', ' pty', ' ag',
                        # Common business-tail descriptors
                        ' agency', ' agencies', ' services', ' solutions',
                        ' consultancy', ' consulting', ' group',
                        ' studios', ' studio',
                    )
                    biz_niche_tokens = (
                        'clinic', 'dental', 'dentist', 'dds', 'orthodontic',
                        'spa', 'salon', 'medspa', 'wellness',
                        'pharmacy', 'medical', 'pediatric',
                    )
                    name_lower = display_name.lower()
                    name_lower_padded = ' ' + name_lower + ' '
                    matched_biz = (
                        any(suffix in name_lower_padded for suffix in biz_suffixes)
                        or any(tok in name_lower for tok in biz_niche_tokens)
                    )
                    if matched_biz:
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
            time.sleep(SCROLL_PAUSE)
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
                    time.sleep(SCROLL_PAUSE)
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
