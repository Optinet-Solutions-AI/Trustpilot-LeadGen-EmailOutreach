"""InstagramScraper — sibling of FacebookScraper.

Differences from FB:
  • IG has no group concept — search_groups returns [].
  • Primary discovery primitive is hashtag search (/explore/tags/<tag>/),
    not keyword text search. The query string is normalized to a hashtag
    (strip leading '#') and passed as the URL slug.
  • IG fingerprints harder than FB — mobile UA + viewport, undetected
    chromedriver patched mode.
  • Session cookie is ``sessionid`` rather than ``c_user``.
  • Empirically higher captcha rate → default daily_cap on the
    social_accounts row should be smaller (set to 25 by the API
    in M4).

Like the Facebook plugin, selectors here are best-effort against IG's
current DOM. Expect first-real-run tuning.
"""
from __future__ import annotations

import asyncio
import os
import random as _random
import sys
import time
from typing import Optional
from urllib.parse import quote_plus

from tools.scraper.platforms._social_base import (
    AuthorLead,
    GroupStub,
    PostStub,
    SocialPlatformScraper,
)
from tools.scraper.platforms.base import FilterField, ProgressCallback
from tools.scraper.platforms.facebook import (
    SCROLL_PAUSE,
    MAX_SCROLLS_PER_QUERY,
    COUNTER_FLUSH_EVERY,
    _bump_counters,
    _claim_account,
    _emit,
    _flag_checkpoint,
    _inject_cookies,
    _is_checkpoint,
    _derive_location_confidence,
    _extract_country_from_excerpt,
)
from tools.scraper.shared.session_store import load_cookies
from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini

IG_BASE = 'https://www.instagram.com'
MOBILE_UA = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) '
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
)

import html as _html
import re as _re
_OG_DESC_RE = _re.compile(r'<meta[^>]+property=["\']og:description["\'][^>]+content="([^"]*)"', _re.I)
# IG og:description format: 'N likes, M comments - <handle> on <Month> <Day>, <Year>: "<caption>"'
_OG_AUTHOR_RE = _re.compile(r'-\s*([A-Za-z0-9._]+)\s+on\s+\w+\s+\d{1,2},\s*\d{4}\s*:', _re.I)


def _caption_from_og(html_text: str) -> str:
    """Pull the post caption from the og:description meta tag (server-rendered,
    robust to IG's React churn). IG format:
      'N likes, M comments - <handle> on <date>: "<caption>"'
    Returns the caption with HTML entities unescaped and IG's wrapping quotes
    stripped."""
    m = _OG_DESC_RE.search(html_text or '')
    if not m:
        return ''
    raw = _html.unescape(m.group(1))
    body = (raw.split(':', 1)[1] if ':' in raw else raw).strip()
    if body.startswith('"'):
        body = body[1:].strip()
    if body.endswith('".'):
        body = body[:-2]
    elif body.endswith('"'):
        body = body[:-1]
    return body.strip()


def _author_handle_from_og(html_text: str) -> str:
    """Extract the post author's handle from the og:description prefix
    ('... - <handle> on <date>: ...'). Returns '' if not matched. This is the
    reliable author source: IG hashtag-grid URLs are '/p/<shortcode>/' with no
    author segment, and og:title carries the display name, not the handle."""
    m = _OG_DESC_RE.search(html_text or '')
    if not m:
        return ''
    a = _OG_AUTHOR_RE.search(_html.unescape(m.group(1)))
    return a.group(1) if a else ''


def _decode_bio_link(href: str) -> Optional[str]:
    """IG wraps external bio links as 'l.instagram.com/?u=<url-encoded target>'.
    Decode the real target and drop IG's tracking query. Returns None when the
    href isn't a wrapped bio link (e.g. the meta.ai / threads / about.meta nav
    links IG injects into every profile's chrome)."""
    from urllib.parse import urlparse, parse_qs, unquote
    if 'l.instagram.com' not in (href or ''):
        return None
    target = (parse_qs(urlparse(href).query).get('u') or [None])[0]
    if not target:
        return None
    return unquote(target).split('?')[0] or None


def _bio_link_from_profile(driver) -> Optional[str]:
    """Find a profile's real bio website by decoding the l.instagram.com link
    shim. Plain external <a> tags on a profile are Meta/IG nav chrome
    (meta.ai, threads.com, about.meta.com, developers.facebook.com), NOT the
    bio link — so we ONLY trust the l.instagram.com redirect wrapper."""
    try:
        anchors = driver.find_elements('css selector', 'a[href*="l.instagram.com"]')
    except Exception:
        return None
    for a in anchors:
        try:
            decoded = _decode_bio_link(a.get_attribute('href') or '')
        except Exception:
            continue
        if decoded:
            return decoded
    return None


class _IGSession:
    """Holds a Playwright browser session. `.page` is the Selenium-driver
    equivalent the scraper methods drive. `.close()` tears the whole stack down."""
    def __init__(self, pw, browser, context, page):
        self._pw = pw
        self._browser = browser
        self._context = context
        self.page = page

    def close(self) -> None:
        for fn in (self._context.close, self._browser.close, self._pw.stop):
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass


def _proxy_for_country(country: str) -> dict:
    """Playwright proxy dict for the residential proxy, pinned to `country` by
    swapping the password's `_country-XX` tag. Playwright does proxy auth
    NATIVELY — the selenium-wire path (uc_driver) crashes on Windows heavy-auth
    pages, which is why IG scraping moved to Playwright here."""
    host = os.environ['RESIDENTIAL_PROXY_HOST']
    port = os.environ['RESIDENTIAL_PROXY_PORT']
    user = os.environ['RESIDENTIAL_PROXY_USERNAME']
    base = os.environ['RESIDENTIAL_PROXY_PASSWORD']
    cc = (country or 'GB').upper()
    pw_pass = (_re.sub(r'_country-[A-Za-z]{2}', f'_country-{cc}', base)
               if '_country-' in base else f'{base}_country-{cc}')
    return {'server': f'http://{host}:{port}', 'username': user, 'password': pw_pass}


def _open_ig_playwright(country: str, cookies=None) -> _IGSession:
    """Open a mobile Playwright chromium routed through `country`'s residential
    proxy. Public IG tag pages render WITHOUT a login (validated live), so no
    session is required; `cookies` (if supplied) seed a best-effort logged-in
    second layer for deeper content."""
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=True, proxy=_proxy_for_country(country))
    context = browser.new_context(
        user_agent=MOBILE_UA, viewport={'width': 414, 'height': 896},
        is_mobile=True, has_touch=True,
    )
    if cookies:
        pw_cookies = []
        for c in cookies:
            try:
                pw_cookies.append({
                    'name': c['name'], 'value': c['value'],
                    'domain': c.get('domain') or '.instagram.com', 'path': c.get('path') or '/',
                    'secure': bool(c.get('secure', True)), 'httpOnly': bool(c.get('httpOnly', False)),
                })
            except Exception:  # noqa: BLE001
                continue
        try:
            context.add_cookies(pw_cookies)
        except Exception:  # noqa: BLE001
            pass
    page = context.new_page()
    page.set_default_timeout(45000)
    return _IGSession(pw, browser, context, page)


def _dismiss_cookie_modal(page) -> None:
    """IG overlays a cookie-consent modal on first load that blocks the grid.
    Dismiss it so posts are extractable/interactable."""
    for label in ('Decline optional cookies', 'Only allow essential cookies', 'Allow all cookies'):
        try:
            btn = page.get_by_role('button', name=label)
            if btn.count():
                btn.first.click(timeout=3000)
                return
        except Exception:  # noqa: BLE001
            continue


def _ig_is_checkpoint_pw(page) -> bool:
    """Playwright equivalent of FB's _is_checkpoint — IG bounced us to a login
    or challenge wall."""
    url = page.url or ''
    return '/accounts/login' in url or '/challenge' in url


def _bio_link_from_profile_pw(page) -> Optional[str]:
    """Playwright version of _bio_link_from_profile: decode the l.instagram.com
    bio-link shim (plain external <a> tags are Meta/IG nav chrome, not the bio)."""
    try:
        hrefs = page.eval_on_selector_all(
            'a[href*="l.instagram.com"]', 'els => els.map(e => e.getAttribute("href"))')
    except Exception:  # noqa: BLE001
        return None
    for h in hrefs or []:
        decoded = _decode_bio_link(h or '')
        if decoded:
            return decoded
    return None


def _normalize_hashtag(q: str) -> str:
    """Strip the leading '#' and any whitespace; lowercase."""
    return q.strip().lstrip('#').lower()


def _paced_sleep(extra_max: float = 2.0) -> None:
    """Sleep SCROLL_PAUSE plus a random 0.3–extra_max s. IG fingerprints harder
    than FB and flags fixed-cadence automation, so inter-navigation pauses are
    jittered (mirrors FB's anti-flag pacing)."""
    time.sleep(SCROLL_PAUSE + _random.uniform(0.3, extra_max))


_CONF_RANK = {'confirmed_city': 3, 'same_country': 2, 'unconfirmed': 1}


def _best_location_confidence(posts: list[dict]) -> Optional[str]:
    """Roll the per-post location_confidence up to the author-level lead: take
    the strongest signal across the author's matched posts (confirmed_city >
    same_country > unconfirmed). Returns None when no post carries a stamp."""
    best = None
    best_rank = 0
    for p in posts:
        rank = _CONF_RANK.get(p.get('location_confidence'), 0)
        if rank > best_rank:
            best_rank = rank
            best = p.get('location_confidence')
    return best


def _location_verdict(text: str, operator_location: Optional[str]) -> tuple[str, bool]:
    """Stamp location_confidence and decide keep/drop for one IG post.

    IG has no groups and its hashtag search is GLOBAL, so without this a search
    pollutes results with wrong-country leads — exactly the problem FB had
    before migration 049. We reuse FB's classifier so both platforms stay
    consistent, fed by the post caption + author handle (the only location
    signal IG exposes without an extra profile fetch).

    Returns (location_confidence, keep):
      • keep=False — a CONFIDENT wrong-country mismatch (caption/handle resolves
        to a different country than the operator's target). Drop it, mirroring
        FB's wrong-country group drop.
      • else (confirmed_city / same_country / unconfirmed, True) — keep, stamped
        honestly. With no operator location we can't gate, so everything is kept
        'unconfirmed'.
    """
    op_country = _extract_country_from_excerpt(operator_location or '')
    txt_country = _extract_country_from_excerpt(text or '')
    if op_country and txt_country and txt_country != op_country:
        return ('wrong_country', False)
    return (_derive_location_confidence(None, text, operator_location), True)


def _filter_consumer_posts(posts: list[dict], *, niche: str, location):
    """Drop posts the Gemini classifier marks non-consumer. Classifier
    None (no key / API fail) => keep everything (IG relies on the LLM
    verdict; there's no substring fallback like Facebook's)."""
    if not posts:
        return posts
    verdicts = classify_consumer_posts_with_gemini(
        [p.get('content_excerpt', '') for p in posts], niche, location=location,
    )
    if verdicts is None or len(verdicts) != len(posts):
        return posts
    return [p for p, keep in zip(posts, verdicts) if keep]


class InstagramScraper(SocialPlatformScraper):
    name = 'instagram'
    base_url = IG_BASE
    requires_proxy = True

    supports_post_search = True
    supports_group_search = False  # IG has no group concept

    filter_schema: list[FilterField] = [
        {'name': 'lead_type', 'type': 'select', 'label': 'Lead type', 'required': True,
         'default': 'businesses',
         'options': [
             {'value': 'businesses', 'label': 'Businesses advertising under a hashtag (SMBs to pitch)'},
             {'value': 'consumers', 'label': 'Consumers asking under a hashtag (intent-filtered)'},
         ]},
        {'name': 'query', 'type': 'text', 'label': 'Niche hashtag (without #)', 'required': True},
        # Optional city — IG hashtag search is global, so this isn't a search
        # filter; it's the target used to STAMP location_confidence and DROP
        # confident wrong-country posts (FB parity, migration 049). Falls back
        # to `country` when blank.
        {'name': 'location', 'type': 'text', 'label': 'Location / city (optional)', 'required': False},
        {'name': 'country', 'type': 'select', 'label': 'Country', 'options_source': 'taxonomy:countries'},
    ]

    # ── Base/social contract ─────────────────────────────────────────
    async def scrape_listing(
        self,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        """Discover business profiles OR hashtag-post authors.

        Consumer mode (default): runs search_posts under the hood and
        reshapes PostStubs into profile-stub form. enrich_profiles
        detects the PostStub shape and pivots to author-enrichment.
        """
        # Both lead types use the same hashtag discovery + author/caption
        # extraction. The only difference (resolved inside search_posts via
        # lead_type): consumer mode keeps only consumer-intent posts; business
        # mode keeps ALL post authors — under a niche hashtag those authors are
        # the advertising SMBs we pitch (same target class as Yelp/Trustpilot).
        query = (filters.get('query') or filters.get('category') or '').strip()
        if not query:
            raise ValueError("Instagram scrapes require a 'query' filter (niche hashtag, without #)")
        post_stubs = await self.search_posts(
            query, filters, max_results=max_results, on_progress=on_progress,
        )
        reshaped: list[dict] = []
        for s in post_stubs:
            author_url = s.get('author_profile_url')
            if not author_url:
                continue
            reshaped.append({
                **s,
                'profile_url': author_url,
                'name': s.get('author_handle') or author_url.rstrip('/').split('/')[-1] or 'Unknown',
                'rating': None,
                'category': query,  # store hashtag/niche for the Lead Matrix
                # Requested country, carried to enrich so a location-confirmed
                # lead can be stamped with it (FB parity). Left off the lead
                # row when the post's location can't be confirmed.
                'target_country': (filters.get('country') or '').strip().upper() or None,
            })
        _emit(on_progress, 'category_done', count=len(reshaped))
        return reshaped

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
        if not profile_stubs:
            return []
        if any('post_url' in s for s in profile_stubs):
            return await asyncio.to_thread(self._sync_enrich_authors, profile_stubs, on_progress)
        return await asyncio.to_thread(self._sync_enrich_pages, profile_stubs, on_progress)

    async def search_posts(
        self,
        query: str,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[PostStub]:
        if not query:
            raise ValueError("search_posts requires a non-empty query (hashtag)")
        # Business mode keeps every post author (the advertising SMBs); consumer
        # mode applies the Gemini consumer-intent filter.
        filter_consumers = (filters.get('lead_type') or 'consumers').lower() != 'businesses'
        # Target location for stamping + the wrong-country gate (city preferred,
        # country as fallback) — mirrors FacebookScraper's operator_location.
        operator_location = (filters.get('location') or filters.get('country') or '').strip()
        return await asyncio.to_thread(
            self._sync_search_hashtag, _normalize_hashtag(query), max_results or 30, on_progress, filter_consumers, operator_location,
        )

    async def search_groups(
        self,
        query: str,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[GroupStub]:
        return []  # IG has no group concept

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
        account = _claim_account('instagram')
        if not account:
            raise RuntimeError(
                "No active Instagram account available. Connect one in Social Accounts "
                "and check daily/hourly caps."
            )
        return account

    def _open_session(self, account: dict) -> '_IGSession':
        """Open a mobile Playwright session through the account's country
        residential proxy (native proxy auth — works on Windows, unlike the
        selenium-wire uc_driver path). Public tag pages need no login; if the
        account carries a stored cookie jar we seed it as a best-effort
        logged-in second layer for deeper content."""
        # The residential proxy is pinned by 2-letter country code (see
        # _proxy_for_country). Use the account's country; fall back to GB if it's
        # missing or not a 2-letter code (IG_PROXY_LOCATION can be a city name,
        # which would corrupt the proxy password — don't use it here).
        country = (account.get('country') or '').strip().upper()
        if len(country) != 2:
            country = 'GB'
        try:
            jar = load_cookies(account['id'])
        except Exception:  # noqa: BLE001
            jar = None
        return _open_ig_playwright(country, cookies=jar)

    def _sync_search_hashtag(self, tag: str, max_results: int, on_progress: ProgressCallback, filter_consumers: bool = True, operator_location: str = '') -> list[PostStub]:
        account = self._claim_or_raise()
        _emit(on_progress, 'search_start', tag=tag)
        session = self._open_session(account)
        page = session.page
        results: list[PostStub] = []
        try:
            page.goto(f'{IG_BASE}/explore/tags/{quote_plus(tag)}/', wait_until='domcontentloaded')
            time.sleep(SCROLL_PAUSE)
            _dismiss_cookie_modal(page)
            time.sleep(1.5)
            if _ig_is_checkpoint_pw(page):
                _flag_checkpoint(account['id'], 'captcha-during-hashtag')
                return results

            seen: set[str] = set()
            for _ in range(MAX_SCROLLS_PER_QUERY):
                try:
                    hrefs = page.eval_on_selector_all(
                        'a[href*="/p/"], a[href*="/reel/"]',
                        'els => els.map(e => e.getAttribute("href"))')
                except Exception:  # noqa: BLE001
                    hrefs = []
                for href in hrefs or []:
                    h = (href or '').split('?')[0]
                    if not h:
                        continue
                    full = h if h.startswith('http') else f'{IG_BASE}{h}'
                    if ('/p/' not in full and '/reel/' not in full) or full in seen:
                        continue
                    seen.add(full)
                    # Hashtag-grid URLs are '/p/<code>/' or '/reel/<code>/' with
                    # no author segment — the real handle comes from the post's
                    # og:description on the visit below.
                    path = full.replace(IG_BASE, '').strip('/').split('/')
                    seg0 = path[0] if path else ''
                    author_handle = seg0 if seg0 and seg0 not in ('p', 'reel', 'reels', 'explore', 'tv', 'stories') else ''
                    author_profile_url = f'{IG_BASE}/{author_handle}/' if author_handle else ''
                    results.append({
                        'platform': 'instagram',
                        'post_url': full,
                        'author_handle': author_handle,
                        'author_profile_url': author_profile_url,
                        'content_excerpt': '',  # caption pulled from og:description on the visit below
                        'posted_at': None,
                        'media_urls': [],
                    })
                    _emit(on_progress, 'post_found', url=full)
                    if len(results) >= max_results:
                        break
                if len(results) >= max_results:
                    break
                try:
                    page.mouse.wheel(0, 5000)
                except Exception:  # noqa: BLE001
                    pass
                _paced_sleep()

            for stub in results:
                try:
                    page.goto(stub['post_url'], wait_until='domcontentloaded')
                    time.sleep(SCROLL_PAUSE)
                    if _ig_is_checkpoint_pw(page):
                        _flag_checkpoint(account['id'], 'captcha-during-caption')
                        break
                    html = page.content()
                    stub['content_excerpt'] = _caption_from_og(html)
                    # Real author handle lives in og:description, NOT the grid URL.
                    handle = _author_handle_from_og(html)
                    if handle:
                        stub['author_handle'] = handle
                        stub['author_profile_url'] = f'{IG_BASE}/{handle}/'
                    _emit(on_progress, 'caption_captured', url=stub['post_url'])
                    _paced_sleep()  # jittered pacing between fetches (IG flags fixed cadences)
                except Exception:  # noqa: BLE001
                    stub['content_excerpt'] = stub.get('content_excerpt', '')

            # Drop stubs with no resolvable author (og:description missing), then
            # the location gate + consumer filter (unchanged logic). IG hashtag
            # search is GLOBAL, so the location gate (migration 049 parity) drops
            # confident wrong-country posts; a caption naming no city stays
            # 'unconfirmed' (kept), never a false-positive drop.
            results = [s for s in results if s.get('author_profile_url')]
            kept: list[PostStub] = []
            for stub in results:
                text = f"{stub.get('content_excerpt', '')} {stub.get('author_handle', '')}"
                conf, keep = _location_verdict(text, operator_location)
                if not keep:
                    _emit(on_progress, 'dropped_wrong_country', url=stub.get('post_url'))
                    continue
                stub['location_confidence'] = conf
                kept.append(stub)
            results = kept
            # Consumer mode keeps only intent-matched posts; business mode keeps
            # ALL post authors (under a niche hashtag they ARE the SMB targets).
            if filter_consumers:
                results = _filter_consumer_posts(results, niche=tag, location=operator_location or None)
            _bump_counters(account['id'], 1, 1)
            _emit(on_progress, 'search_done', total=len(results))
            return results
        finally:
            session.close()

    def _sync_enrich_authors(self, post_stubs: list[PostStub], on_progress: ProgressCallback) -> list[AuthorLead]:
        account = self._claim_or_raise()
        unique_authors: dict[str, list[PostStub]] = {}
        for stub in post_stubs:
            url = stub.get('author_profile_url') or ''
            if not url:
                continue
            unique_authors.setdefault(url, []).append(stub)
        _emit(on_progress, 'enrich_start', total=len(unique_authors))

        session = self._open_session(account)
        page = session.page
        leads: list[AuthorLead] = []
        try:
            for i, (profile_url, posts) in enumerate(unique_authors.items(), 1):
                try:
                    page.goto(profile_url, wait_until='domcontentloaded')
                    time.sleep(SCROLL_PAUSE)
                    _dismiss_cookie_modal(page)
                    if _ig_is_checkpoint_pw(page):
                        _flag_checkpoint(account['id'], 'captcha-during-enrich')
                        break
                    raw_title = page.title() or ''
                    display_name = (raw_title.split('(')[0].split(' on ')[0].strip()
                                    or posts[0].get('author_handle') or 'Unknown')
                    bio_link = _bio_link_from_profile_pw(page)
                    # Roll up the per-post location stamp (migration 049) and,
                    # only when the post's location is actually confirmed to be
                    # in the requested country, stamp that country on the lead —
                    # otherwise leave it NULL (IG hashtag results are global, so
                    # an unconfirmed author's country is genuinely unknown). This
                    # matches FacebookScraper, which writes a country for
                    # confirmed leads and NULL for the rest.
                    conf = _best_location_confidence(posts)
                    lead_country = (
                        posts[0].get('target_country')
                        if conf in ('confirmed_city', 'same_country')
                        else None
                    )
                    leads.append({
                        'platform': 'instagram',
                        'profile_url': profile_url,
                        'author_handle': posts[0].get('author_handle'),
                        'display_name': display_name,
                        'company_name': display_name,
                        'website_url': bio_link,
                        'email': None,
                        'location': None,
                        'location_confidence': conf,
                        # Niche hashtag + confirmed country, so the Lead Matrix
                        # shows them and per-platform filtering works (FB parity).
                        'category': posts[0].get('category'),
                        'country': lead_country,
                        'is_business_profile': True,
                        'follower_count': None,
                        'bio_excerpt': None,
                        'posts': posts,
                    })
                    _emit(on_progress, 'enrich_progress', i=i, total=len(unique_authors))
                except Exception as exc:  # noqa: BLE001
                    _emit(on_progress, 'enrich_failed', url=profile_url, reason=str(exc)[:80])
                if i % COUNTER_FLUSH_EVERY == 0:
                    _bump_counters(account['id'], COUNTER_FLUSH_EVERY, COUNTER_FLUSH_EVERY)
            remainder = len(leads) % COUNTER_FLUSH_EVERY
            if remainder:
                _bump_counters(account['id'], remainder, remainder)
            _emit(on_progress, 'enrich_done', total=len(leads))
            return leads
        finally:
            session.close()

    def _sync_enrich_pages(self, stubs: list[dict], on_progress: ProgressCallback) -> list[dict]:
        # Reuse the author-enrichment for business profiles since IG draws
        # no DOM distinction between personal and business profiles for
        # public visitors.
        account = self._claim_or_raise()
        session = self._open_session(account)
        page = session.page
        out: list[dict] = []
        try:
            for i, stub in enumerate(stubs, 1):
                try:
                    page.goto(stub['profile_url'], wait_until='domcontentloaded')
                    time.sleep(SCROLL_PAUSE)
                    _dismiss_cookie_modal(page)
                    if _ig_is_checkpoint_pw(page):
                        _flag_checkpoint(account['id'], 'captcha-during-page-enrich')
                        break
                    website = _bio_link_from_profile_pw(page)
                    enriched = dict(stub)
                    enriched.update({
                        'platform': 'instagram',
                        'website_url': website,
                        'is_business_profile': True,
                        'follower_count': None,
                    })
                    out.append(enriched)
                    _emit(on_progress, 'enrich_progress', i=i, total=len(stubs))
                except Exception as exc:  # noqa: BLE001
                    _emit(on_progress, 'enrich_failed', url=stub.get('profile_url'), reason=str(exc)[:80])
            _bump_counters(account['id'], len(out), len(out))
            _emit(on_progress, 'enrich_done', total=len(out))
            return out
        finally:
            session.close()
