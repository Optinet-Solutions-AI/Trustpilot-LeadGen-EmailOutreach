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
    # /search/, /reel/, /events/). FB's new search results encrypt actual
    # post permalinks behind `__cft__` tokens, so there's no clean post URL
    # to extract — we synthesize one from author + content hash for dedup.
    NON_AUTHOR_PREFIXES = (
        '/groups/', '/photo/', '/photo.php', '/watch/', '/search/', '/reel/',
        '/events/', '/marketplace/', '/share/', '/permalink', '/story.php',
        '/messages/', '/help/', '/policies/', '/privacy/', '/terms/',
    )

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
            for a in all_links:
                href = (a.get_attribute('href') or '')
                if _is_author_link(href):
                    # Strip FB tracking params but keep ?id= for profile.php
                    if '/profile.php' in href:
                        m = re.search(r'/profile\.php\?id=(\d+)', href)
                        author_url = f'https://www.facebook.com/profile.php?id={m.group(1)}' if m else href.split('&')[0]
                    else:
                        author_url = href.split('?')[0]
                    break

            if not author_url:
                continue

            excerpt = (article.text or '').strip()[:500]
            if not excerpt:
                continue

            # Synthesize a stable post_url from author + first 12 chars of
            # excerpt SHA1. This keeps (platform, post_url) unique while
            # also being idempotent on re-scrape (same author + same text
            # = same hash, no duplicate row).
            digest = hashlib.sha1(excerpt[:200].encode('utf-8')).hexdigest()[:12]
            synthetic_post_url = f'{author_url}#post-{digest}'

            # Handle: /<handle>/ → handle; /profile.php?id=N → profile.php:N
            # (keep the numeric id so distinct profile.php leads don't collapse)
            if '/profile.php' in author_url:
                m = re.search(r'[?&]id=(\d+)', author_url)
                author_handle = f'profile.php:{m.group(1)}' if m else 'profile.php'
            else:
                author_handle = author_url.rstrip('/').split('/')[-1].split('?')[0]
            posts.append({
                'post_url': synthetic_post_url,
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
        # Consumer mode fields
        {'name': 'query', 'type': 'text', 'label': 'Keyword / phrase'},
        {'name': 'groups_only', 'type': 'boolean', 'label': 'Search inside groups only', 'default': False},
        {'name': 'date_from', 'type': 'text', 'label': 'Date from (YYYY-MM-DD)'},
        {'name': 'date_to', 'type': 'text', 'label': 'Date to (YYYY-MM-DD)'},
        # Business mode fields
        {'name': 'category', 'type': 'text', 'label': 'Page category (slug)'},
        {'name': 'country', 'type': 'select', 'label': 'Country', 'options_source': 'taxonomy:countries'},
    ]

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
            query = (filters.get('query') or '').strip()
            if not query:
                raise ValueError("Consumer-mode Facebook scrapes require a 'query' filter")
            post_stubs = await self.search_posts(
                query, filters, max_results=max_results, on_progress=on_progress,
            )
            # Reshape PostStubs into profile-stub form so the list→enrich
            # orchestrator can drive them. We keep the original PostStub
            # fields intact (post_url, content_excerpt, …) so enrich_profiles
            # can detect this and pivot to enrich_authors.
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
                })
            # Mirror the legacy listing-done signal so the existing UI counter
            # increments — it listens for PROGRESS:category_done.
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

                    # Display name. The page <title> is usually "Name | Facebook"
                    # but on private/blocked/just-logged-in profiles it can be
                    # just "Facebook" or "(N) Facebook" — useless. Fall back to
                    # the <h1> tag, then to the author_handle from the URL.
                    raw_title = driver.title or ''
                    display_name = raw_title.split(' | ')[0].split(' - ')[0].strip()
                    bad_titles = {'facebook', '', 'log in to facebook', 'log into facebook'}
                    if display_name.lower() in bad_titles or 'facebook' == display_name.lower().rstrip(')').lstrip('(0123456789 '):
                        try:
                            h1 = driver.find_elements('css selector', 'h1')
                            for el in h1:
                                txt = (el.text or '').strip()
                                if txt and txt.lower() not in bad_titles:
                                    display_name = txt
                                    break
                        except Exception:
                            pass
                    if display_name.lower() in bad_titles:
                        # Last-resort: pull a handle out of the profile URL.
                        # /<handle>/ → handle; /profile.php?id=X → "user X"
                        if '/profile.php' in profile_url:
                            import re as _re
                            m = _re.search(r'[?&]id=(\d+)', profile_url)
                            display_name = f'User {m.group(1)}' if m else 'Unknown'
                        else:
                            tail = profile_url.rstrip('/').split('/')[-1]
                            display_name = tail.replace('.', ' ').replace('_', ' ').title() if tail else 'Unknown'
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
