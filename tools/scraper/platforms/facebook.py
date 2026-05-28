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
    """
    rows = (
        table('social_accounts')
        .select('id,platform,handle,daily_cap,hourly_cap,used_today,used_this_hour,encrypted_cookies')
        .eq('platform', platform)
        .eq('status', 'active')
        .order('used_today', desc=False)
        .limit(5)
        .execute()
        .data
    )
    for row in rows:
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
        # Philippines
        ('lapu-lapu city', 'PH'), ('mandaue city', 'PH'), ('cebu city', 'PH'),
        ('liloan', 'PH'), ('mandaue', 'PH'), ('mactan', 'PH'),
        ('lapu-lapu', 'PH'), ('cebu', 'PH'), ('manila', 'PH'), ('makati', 'PH'),
        ('quezon city', 'PH'), ('davao', 'PH'),
        # US (samples — expand as needed)
        ('new york', 'US'), ('los angeles', 'US'), ('chicago', 'US'),
        ('san francisco', 'US'), ('brooklyn', 'US'), ('manhattan', 'US'),
        # UK
        ('london', 'GB'), ('manchester', 'GB'), ('birmingham', 'GB'),
        # Singapore
        ('singapore', 'SG'),
        # Australia
        ('sydney', 'AU'), ('melbourne', 'AU'), ('brisbane', 'AU'),
    ]
    for needle, country in CITY_TO_COUNTRY:
        if needle in lowered:
            return country
    return None


def _detect_chrome_major_version() -> Optional[int]:
    """Read installed Chrome's major version so chromedriver matches."""
    import re
    import subprocess
    candidates = [
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    ]
    chrome_path = next((p for p in candidates if os.path.isfile(p)), None)
    if not chrome_path:
        return None
    try:
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             f"(Get-Item '{chrome_path}').VersionInfo.ProductVersion"],
            text=True, timeout=5,
        ).strip()
        m = re.match(r'(\d+)\.', out)
        return int(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        return None


def _open_driver():
    """Open an undetected-chromedriver, headless if PLAYWRIGHT_HEADLESS=true."""
    import undetected_chromedriver as uc  # noqa: WPS433 — lazy

    headless = os.getenv('PLAYWRIGHT_HEADLESS', 'false').lower() == 'true'
    options = uc.ChromeOptions()
    if headless:
        options.add_argument('--headless=new')
    options.add_argument('--window-size=1280,900')
    options.add_argument('--lang=en-US,en')
    options.add_argument('--disable-blink-features=AutomationControlled')
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
    driver = uc.Chrome(options=options, use_subprocess=True, version_main=version_main)
    driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
    return driver


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
        r'/photo/?\?[^"]*fbid=',     # photo posts: /photo/?fbid=...&set=pcb.<post>
        r'/photo\.php\?[^"]*fbid=',  # legacy photo URL
        r'/posts/\d',                # /<handle>/posts/<id>
        r'/permalink\.php\?',        # /permalink.php?story_fbid=...
        r'/groups/[^/]+/posts/',
        r'/groups/[^/]+/permalink/',
        r'/share/p/',
        r'/videos/\d',
        r'/story\.php\?',
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

            excerpt = (article.text or '').strip()[:500]
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
            text = (card.text or '').strip()
            if not text:
                continue

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

            # Find real post permalink in the card
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
            if not post_url:
                # Fallback: synthetic so (platform, post_url) stays unique
                digest = hashlib.sha1(text[:200].encode('utf-8')).hexdigest()[:12]
                anchor = author_url or f'{FB_BASE}/groups/{group["group_id"]}'
                post_url = f'{anchor}#post-{digest}'

            out.append({
                'platform': 'facebook',
                'post_url': post_url,
                'author_handle': author_handle,
                'author_profile_url': author_url,
                'content_excerpt': text[:500],
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
    ) -> list:
        """Orchestrate the discovery → per-group search → aggregate flow.
        Sequential and cancellable; partial results persist if the parent
        process is killed mid-flight (each in-group search is a complete
        unit). Returns aggregated PostStubs across all discovered groups.
        """
        groups = self._sync_discover_groups(niche, location, on_progress)
        if not groups:
            _emit(on_progress, 'groups_found', count=0)
            return []
        in_group_keyword = f'looking for a {niche}'
        account = self._claim_or_raise()
        aggregated: list = []
        for i, g in enumerate(groups, 1):
            _emit(on_progress, 'group_progress', n=i, total=len(groups),
                  group_name=g.get('name', '?')[:60], group_id=g['group_id'])
            try:
                # Re-claim if the previous in-group search bumped the cap
                # past hourly threshold (defensive — usually still active).
                stubs = self._sync_search_inside_group(account, g, in_group_keyword, on_progress)
                if stubs:
                    aggregated.extend(stubs)
                    _emit(on_progress, 'group_posts_kept', count=len(stubs), group_name=g.get('name'))
            except Exception as exc:  # noqa: BLE001 — keep going on per-group errors
                _emit(on_progress, 'group_failed', group_id=g['group_id'], reason=str(exc)[:120])
        _emit(on_progress, 'search_done', total=len(aggregated))
        return aggregated

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
                )
            # Two-layer consumer-only filter:
            #  1. Drop business/ad posts (clinic handles, ad copy).
            #  2. Keep only posts that look like someone ACTIVELY ASKING
            #     for the service. Post-experience thank-you posts
            #     ('Salamat Doc...') and recommendations ('I recommend
            #     Dr.X') get dropped — those people already have a
            #     dentist, they're not leads.
            # Either filter is operator-overridable via filters.
            exclude_businesses = filters.get('exclude_businesses', True)
            asking_only = filters.get('asking_only', True)
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
                    # Category = what found this person (niche keyword). For
                    # group scrapes this is the niche field; for legacy
                    # open-feed escape-hatch it's the original query.
                    'category': niche or legacy_query,
                    # Country = the location we asked for + a fallback to
                    # excerpt-based extraction in case location is a region
                    # name we don't directly map.
                    'country': (
                        _extract_country_from_excerpt(location)
                        or _extract_country_from_excerpt(s.get('content_excerpt', ''))
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
        groups_only = bool(filters.get('groups_only'))
        return await asyncio.to_thread(
            self._sync_search_posts, query, groups_only, max_results or 50, on_progress,
        )

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
        """Open a driver and hydrate it with the account's saved cookies."""
        driver = _open_driver()
        driver.get(FB_BASE)
        jar = load_cookies(account['id'])
        if jar:
            _inject_cookies(driver, jar)
            driver.get(FB_BASE)  # re-navigate so injected cookies stick
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
            # Facebook's search-posts URL pattern.
            search_url = f'{FB_BASE}/search/posts/?q={quote_plus(query)}'
            if groups_only:
                # The "in groups" filter has a stable URL hint.
                search_url += '&filters=groups'
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
                        s = (name or '').strip().lower()
                        return s in bad_titles or s.rstrip(')').lstrip('(0123456789 ') == 'facebook'

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
                    # no signal but og:title revealed 'RCA Dental Clinic' etc.
                    biz_tokens = ('clinic', 'dental', 'dentist', 'dds', 'orthodontic',
                                  'studio', 'spa', 'salon', 'medspa', 'wellness',
                                  'pharmacy', 'medical', 'pediatric')
                    if any(tok in display_name.lower() for tok in biz_tokens):
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
