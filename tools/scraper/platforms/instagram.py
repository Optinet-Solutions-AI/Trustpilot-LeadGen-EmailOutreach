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
)
from tools.scraper.shared.session_store import load_cookies
from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini

IG_BASE = 'https://www.instagram.com'
MOBILE_UA = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) '
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
)

import re as _re
_OG_DESC_RE = _re.compile(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']*)["\']', _re.I)


def _caption_from_og(html: str) -> str:
    """Pull the post caption out of the og:description meta tag — robust to
    IG's React DOM churn (the meta tag is server-rendered). Strips the
    leading 'N likes - author:' prefix IG prepends."""
    m = _OG_DESC_RE.search(html or '')
    if not m:
        return ''
    raw = m.group(1)
    return raw.split(':', 1)[1].strip() if ':' in raw else raw.strip()


def _open_ig_driver():
    """Mobile-flavored driver with the SAME proxy + persistent-profile
    stack Facebook uses. IG_PROFILE_DIR holds the logged-in profile."""
    from tools.scraper.shared.uc_driver import open_uc_driver
    return open_uc_driver(
        'IG_PROFILE_DIR',
        user_agent=MOBILE_UA,
        window_size=(414, 896),
        proxy_location=os.environ.get('IG_PROXY_LOCATION'),
    )


def _normalize_hashtag(q: str) -> str:
    """Strip the leading '#' and any whitespace; lowercase."""
    return q.strip().lstrip('#').lower()


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
         'default': 'consumers',
         'options': [
             {'value': 'consumers', 'label': 'People posting under a hashtag (post authors)'},
             {'value': 'businesses', 'label': 'Business profiles by category (explore feed)'},
         ]},
        {'name': 'query', 'type': 'text', 'label': 'Hashtag (without #)'},
        {'name': 'category', 'type': 'text', 'label': 'Explore category'},
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
        lead_type = (filters.get('lead_type') or 'consumers').lower()

        if lead_type == 'consumers':
            query = (filters.get('query') or '').strip()
            if not query:
                raise ValueError("Consumer-mode Instagram scrapes require a 'query' filter (hashtag)")
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
                    'category': query,  # store hashtag/keyword for the Lead Matrix
                })
            _emit(on_progress, 'category_done', count=len(reshaped))
            return reshaped

        category = filters.get('category')
        if not category:
            raise ValueError("Business-mode Instagram scrapes require 'category' filter")
        return await asyncio.to_thread(self._sync_scrape_business_profiles, category, max_results or 30, on_progress)

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
        return await asyncio.to_thread(
            self._sync_search_hashtag, _normalize_hashtag(query), max_results or 30, on_progress,
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

    def _open_session(self, account: dict):
        # Session layering (mirrors Facebook): the persistent IG_PROFILE_DIR
        # profile loaded by _open_ig_driver() is the PRIMARY logged-in state
        # (cookies + localStorage minted on the proxy IP at connect time).
        # The injected sessionid jar below is a SECOND-layer fallback for a
        # first-run/empty profile; if both fail, IG redirects to
        # /accounts/login and we flag a checkpoint for operator re-connect.
        driver = _open_ig_driver()
        driver.get(IG_BASE)
        jar = load_cookies(account['id'])
        if jar:
            _inject_cookies(driver, jar)
            driver.get(IG_BASE)
        if '/accounts/login' in driver.current_url:
            driver.quit()
            _flag_checkpoint(account['id'], 'cookies-rejected-redirected-to-login')
            raise RuntimeError(f"Instagram rejected cookies for {account['handle']} — needs re-connect")
        return driver

    def _sync_search_hashtag(self, tag: str, max_results: int, on_progress: ProgressCallback) -> list[PostStub]:
        account = self._claim_or_raise()
        _emit(on_progress, 'search_start', tag=tag)
        driver = self._open_session(account)
        results: list[PostStub] = []
        try:
            driver.get(f'{IG_BASE}/explore/tags/{quote_plus(tag)}/')
            time.sleep(SCROLL_PAUSE)
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], 'captcha-during-hashtag')
                return results

            seen: set[str] = set()
            for _ in range(MAX_SCROLLS_PER_QUERY):
                try:
                    anchors = driver.find_elements('css selector', 'a[href*="/p/"]')
                except Exception:
                    anchors = []
                for a in anchors:
                    try:
                        href = (a.get_attribute('href') or '').split('?')[0]
                        if '/p/' not in href or href in seen:
                            continue
                        seen.add(href)
                        # Author handle is the segment before /p/.
                        path = href.replace(IG_BASE, '').strip('/').split('/')
                        author_handle = path[0] if path else ''
                        author_profile_url = f'{IG_BASE}/{author_handle}/' if author_handle else ''
                        results.append({
                            'platform': 'instagram',
                            'post_url': href,
                            'author_handle': author_handle,
                            'author_profile_url': author_profile_url,
                            'content_excerpt': '',  # caption requires a click; left to enrich pass
                            'posted_at': None,
                            'media_urls': [],
                        })
                        _emit(on_progress, 'post_found', url=href)
                        if len(results) >= max_results:
                            break
                    except Exception:
                        continue
                if len(results) >= max_results:
                    break
                driver.execute_script('window.scrollTo(0, document.body.scrollHeight);')
                time.sleep(SCROLL_PAUSE)
            for stub in results:
                try:
                    driver.get(stub['post_url'])
                    time.sleep(SCROLL_PAUSE)
                    if _is_checkpoint(driver):
                        _flag_checkpoint(account['id'], 'captcha-during-caption')
                        break
                    stub['content_excerpt'] = _caption_from_og(driver.page_source)
                    _emit(on_progress, 'caption_captured', url=stub['post_url'])
                except Exception:
                    stub['content_excerpt'] = ''
            results = _filter_consumer_posts(results, niche=tag, location=None)
            _bump_counters(account['id'], 1, 1)
            _emit(on_progress, 'search_done', total=len(results))
            return results
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_enrich_authors(self, post_stubs: list[PostStub], on_progress: ProgressCallback) -> list[AuthorLead]:
        account = self._claim_or_raise()
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
                    raw_title = driver.title or ''
                    display_name = raw_title.split('(')[0].split(' on ')[0].strip()
                    bio_link = None
                    try:
                        anchors = driver.find_elements(
                            'css selector', 'a[href^="https://"]:not([href*="instagram.com"])',
                        )
                        if anchors:
                            bio_link = anchors[0].get_attribute('href')
                    except Exception:
                        pass
                    leads.append({
                        'platform': 'instagram',
                        'profile_url': profile_url,
                        'author_handle': posts[0].get('author_handle'),
                        'display_name': display_name,
                        'company_name': display_name,
                        'website_url': bio_link,
                        'email': None,
                        'location': None,
                        'is_business_profile': False,
                        'follower_count': None,
                        'bio_excerpt': None,
                        'posts': posts,
                    })
                    _emit(on_progress, 'enrich_progress', i=i, total=len(unique_authors))
                except Exception as exc:
                    _emit(on_progress, 'enrich_failed', url=profile_url, reason=str(exc)[:80])
                if i % COUNTER_FLUSH_EVERY == 0:
                    _bump_counters(account['id'], COUNTER_FLUSH_EVERY, COUNTER_FLUSH_EVERY)
            remainder = len(leads) % COUNTER_FLUSH_EVERY
            if remainder:
                _bump_counters(account['id'], remainder, remainder)
            _emit(on_progress, 'enrich_done', total=len(leads))
            return leads
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_scrape_business_profiles(self, category: str, max_results: int, on_progress: ProgressCallback) -> list[dict]:
        account = self._claim_or_raise()
        _emit(on_progress, 'search_start', category=category)
        driver = self._open_session(account)
        try:
            # IG's explore endpoint is fuzzy; treat the input as a search query.
            driver.get(f'{IG_BASE}/explore/search/keyword/?q={quote_plus(category)}')
            time.sleep(SCROLL_PAUSE)
            if _is_checkpoint(driver):
                _flag_checkpoint(account['id'], 'captcha-during-explore')
                return []
            try:
                anchors = driver.find_elements('css selector', 'a[role="link"][href^="/"]')
            except Exception:
                anchors = []
            out: list[dict] = []
            seen = set()
            for a in anchors:
                try:
                    href = (a.get_attribute('href') or '').split('?')[0]
                    if not href.startswith(IG_BASE) or '/p/' in href or '/reel/' in href:
                        continue
                    handle = href.replace(IG_BASE, '').strip('/').split('/')[0]
                    if not handle or handle in seen:
                        continue
                    seen.add(handle)
                    out.append({
                        'name': handle,
                        'profile_url': href,
                        'rating': None,
                    })
                    if len(out) >= max_results:
                        break
                except Exception:
                    continue
            _bump_counters(account['id'], 1, 1)
            _emit(on_progress, 'category_done', count=len(out))
            return out
        finally:
            try: driver.quit()
            except Exception: pass

    def _sync_enrich_pages(self, stubs: list[dict], on_progress: ProgressCallback) -> list[dict]:
        # Reuse the author-enrichment for business profiles since IG draws
        # no DOM distinction between personal and business profiles for
        # public visitors.
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
                    website = None
                    try:
                        anchors = driver.find_elements(
                            'css selector', 'a[href^="https://"]:not([href*="instagram.com"])',
                        )
                        if anchors:
                            website = anchors[0].get_attribute('href')
                    except Exception:
                        pass
                    enriched = dict(stub)
                    enriched.update({
                        'platform': 'instagram',
                        'website_url': website,
                        'is_business_profile': True,
                        'follower_count': None,
                    })
                    out.append(enriched)
                    _emit(on_progress, 'enrich_progress', i=i, total=len(stubs))
                except Exception as exc:
                    _emit(on_progress, 'enrich_failed', url=stub.get('profile_url'), reason=str(exc)[:80])
            _bump_counters(account['id'], len(out), len(out))
            _emit(on_progress, 'enrich_done', total=len(out))
            return out
        finally:
            try: driver.quit()
            except Exception: pass
