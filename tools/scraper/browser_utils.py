"""
Shared browser utilities for all scrapers.
Provides stealth Playwright browser launching, popup dismissal, and delay helpers.
Adapted from BannerScrapper browser-launcher.ts and popup-handler.ts patterns.
"""
from __future__ import annotations  # Enables PEP 604 `X | Y` unions on Python 3.9 (Debian Bullseye)

import os
import random
import asyncio
from typing import Optional
from playwright.async_api import async_playwright, Page, Browser, BrowserContext

# User-agent rotation pool (Chrome on Windows/Mac)
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
]

# Cookie/consent selectors adapted from BannerScrapper popup-handler.ts
COOKIE_SELECTORS = [
    '#onetrust-accept-btn-handler',  # Trustpilot uses OneTrust
    'button[id*="accept"]', 'button[class*="accept"]',
    'button[id*="cookie"]', 'button[class*="cookie"]',
    'button[id*="consent"]', 'button[class*="consent"]',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '.cc-accept', '.cookie-accept', '#cookieAccept',
    '[aria-label*="Accept cookies"]', '[aria-label*="accept all"]',
]

MODAL_CLOSE_SELECTORS = [
    'button[aria-label="Close"]', 'button[aria-label="close"]',
    '[class*="modal"] button[class*="close"]',
    '[class*="popup"] button[class*="close"]',
    '.modal-close', '.popup-close',
    'button[data-dismiss="modal"]',
    # Trustpilot-specific overlays seen in production
    '[data-locale-modal-close]',
    'button[name="close-modal"]',
    'button[aria-label="Close locale picker"]',
    'button[data-test-locator*="close"]',
    'button[data-testid*="close"]',
    'button[data-testid*="dismiss"]',
]


def random_user_agent() -> str:
    return random.choice(USER_AGENTS)


async def human_delay(min_s: float = 2.0, max_s: float = 5.0):
    """Randomized sleep to avoid rate limiting."""
    delay = random.uniform(min_s, max_s)
    await asyncio.sleep(delay)


# Platforms whose browser runs may be routed through the UNBLOCKER proxy.
#
# Deliberately an ALLOWLIST. Naming the exceptions instead is how the
# ScrapingBee gate was broken five times: every new platform silently inherited
# a behaviour nobody chose for it. A scraper added tomorrow gets no proxy, and
# therefore no bill, until someone puts it here on purpose.
#
# Facebook and Instagram must NEVER appear here. They carry logged-in cookies,
# and a session minted on one IP then used from another is how an account gets
# checkpointed.
_PROXYABLE = {'trustpilot'}


def browser_proxy_for(platform: str) -> Optional[dict]:
    """Proxy config for this platform's browser run, or None to go direct.

    THE PROBLEM THIS SOLVES

    AWS WAF fronts Trustpilot. Measured 2026-09-04, only a stealth HEADED
    browser on a residential IP cleared it, which pinned Trustpilot to the
    owner's laptop while every other platform moved to the server - so no
    Trustpilot scrape could run while that laptop was off.

    Measured 2026-09-28, Apify UNBLOCKER clears that WAF: a headless browser
    through it read a real profile (bet365, TrustScore 1.3) and a real category
    page (20 businesses) using the scraper's own __NEXT_DATA__ evaluation.

    THE DEFAULT IS THE DECISION

    Headless means a server, and a server is exactly where the wall refuses us,
    so headless + a token opts in automatically. Headed means the owner's
    machine on a residential line, which already clears the wall for nothing -
    paying the proxy there would be spending money to run slower. This mirrors
    the screenshot dispatcher, which defaults to Apify whenever a token exists
    rather than to a vendor that would silently fail.

    TRUSTPILOT_FETCH ('unblocker' or 'browser') overrides either way.
    """
    if platform not in _PROXYABLE:
        return None

    choice = (os.getenv('TRUSTPILOT_FETCH', '') or '').strip().lower()
    if choice == 'browser':
        return None

    headless = os.getenv('PLAYWRIGHT_HEADLESS', 'true').lower() == 'true'
    if choice != 'unblocker' and not headless:
        return None

    try:
        from tools.scraper.shared.apify_screenshot import unblocker_proxy
    except ImportError:
        return None
    return unblocker_proxy()


# Set by launch_browser when it is given a proxy, read by safe_goto so each
# navigation is charged.
#
# Module-level is safe HERE specifically because scrape-runner spawns a fresh
# Python process per scrape job, so one process means one browser. It would be
# wrong in a library shared by concurrent browsers.
_BILLED_PROXY_PLATFORM: Optional[str] = None


def _bill_proxy_page(url: str) -> None:
    """Charge one UNBLOCKER page load, if this run is going through it.

    Trustpilot used to be free: the owner's own browser on his own line. Moving
    it to the server makes every page load cost real money, and a scraper that
    spends without saying so is the exact fault just fixed in the screenshot
    path, where challenged pages were recorded as free.
    """
    if not _BILLED_PROXY_PLATFORM:
        return
    try:
        from tools.scraper.shared.apify_screenshot import USD_PER_SCREENSHOT
        from tools.scraper.shared.cost_report import report_cost
    except ImportError:
        return
    report_cost(_BILLED_PROXY_PLATFORM, 'apify-unblocker', units=1,
                unit_label='pages', usd=USD_PER_SCREENSHOT)


async def launch_browser(
    proxy: Optional[dict] = None,
) -> tuple[Browser, BrowserContext, Page]:
    """
    Launch a stealth-configured Chromium browser.
    Returns (browser, context, page).

    `proxy` routes the browser through UNBLOCKER (see browser_proxy_for). The
    context already sets ignore_https_errors, which that proxy requires.
    """
    headless = os.getenv('PLAYWRIGHT_HEADLESS', 'true').lower() == 'true'

    global _BILLED_PROXY_PLATFORM
    _BILLED_PROXY_PLATFORM = 'trustpilot' if proxy else None

    pw = await async_playwright().start()

    browser = await pw.chromium.launch(
        headless=headless,
        **({'proxy': proxy} if proxy else {}),
        args=[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--dns-prefetch-disable',
        ],
    )

    # Randomized viewport to avoid fingerprinting
    width = 1280 + random.randint(0, 200)
    height = 800 + random.randint(0, 100)

    context = await browser.new_context(
        viewport={'width': width, 'height': height},
        user_agent=random_user_agent(),
        ignore_https_errors=True,
        locale='en-US',
        extra_http_headers={'Accept-Language': 'en-US,en;q=0.9'},
    )

    # Block heavy resources to speed up scraping
    await context.route('**/*.{woff,woff2,ttf,otf}', lambda route: route.abort())
    await context.route('**/analytics**', lambda route: route.abort())
    await context.route('**/gtag**', lambda route: route.abort())
    await context.route('**/google-analytics**', lambda route: route.abort())

    # Apply stealth patches
    try:
        from playwright_stealth import stealth_async
        page = await context.new_page()
        await stealth_async(page)
    except ImportError:
        page = await context.new_page()

    return browser, context, page


async def dismiss_popups(page: Page):
    """Try to dismiss cookie banners and modals. Non-blocking — ignores failures."""
    for selector in COOKIE_SELECTORS:
        try:
            el = page.locator(selector).first
            if await el.is_visible(timeout=500):
                await el.click(timeout=1000)
                await asyncio.sleep(0.5)
                return
        except Exception:
            continue

    for selector in MODAL_CLOSE_SELECTORS:
        try:
            el = page.locator(selector).first
            if await el.is_visible(timeout=300):
                await el.click(timeout=1000)
                return
        except Exception:
            continue


# Max seconds we'll ever honor from a server-supplied Retry-After. Keeps a
# misbehaving / hostile header from stalling the whole scrape indefinitely.
_MAX_RETRY_AFTER_S = 120


def _parse_retry_after(value: str | None) -> float | None:
    """Return a seconds-delay parsed from a Retry-After header, or None."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    # HTTP-date form — fall back to email.utils
    try:
        from email.utils import parsedate_to_datetime
        from datetime import datetime, timezone
        when = parsedate_to_datetime(value)
        if when is None:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
    except Exception:
        return None


# A direct page load is quick. One through UNBLOCKER is not: the proxy solves
# the challenge server-side before it answers, measured at 20s for raw HTML and
# 70-115s for a full browser page. The 30s default spent two whole attempts
# timing out before the third succeeded — paying for traffic each time and
# taking longer than simply waiting would have.
_PROXY_NAV_TIMEOUT_MS = 120_000


async def safe_goto(page: Page, url: str, retries: int = 3, timeout: int | None = None) -> bool:
    """Navigate to URL with retry logic, exponential backoff, and 429/Retry-After handling."""
    if timeout is None:
        timeout = _PROXY_NAV_TIMEOUT_MS if _BILLED_PROXY_PLATFORM else 30000
    for attempt in range(retries):
        try:
            response = await page.goto(url, wait_until='domcontentloaded', timeout=timeout)
            status = response.status if response else None
            # Charged on every navigation that reached the proxy, including the
            # ones that come back 429 or blocked — the traffic is billed either
            # way, and recording only successes under-reports the run.
            _bill_proxy_page(url)

            # 429 Too Many Requests — honor Retry-After when present, else exp backoff
            if status == 429:
                retry_after_header = None
                try:
                    retry_after_header = await response.header_value('retry-after')
                except Exception:
                    pass
                parsed = _parse_retry_after(retry_after_header)
                if parsed is not None:
                    wait = min(parsed, _MAX_RETRY_AFTER_S)
                    print(f"  429 on {url} — Retry-After={retry_after_header!r}, waiting {wait:.1f}s (attempt {attempt + 1}/{retries})")
                else:
                    wait = min((2 ** attempt) * 10, _MAX_RETRY_AFTER_S)
                    print(f"  429 on {url} — no Retry-After, waiting {wait}s (attempt {attempt + 1}/{retries})")
                await asyncio.sleep(wait)
                continue

            if status == 403:
                wait = (2 ** attempt) * 5
                print(f"  403 on {url} — retrying in {wait}s (attempt {attempt + 1}/{retries})")
                await asyncio.sleep(wait)
                continue

            # 5xx — transient server error, back off and retry
            if status is not None and 500 <= status < 600:
                wait = (2 ** attempt) * 5
                print(f"  {status} on {url} — retrying in {wait}s (attempt {attempt + 1}/{retries})")
                await asyncio.sleep(wait)
                continue

            await dismiss_popups(page)
            return True
        except Exception as e:
            # The request reached the proxy before it failed, so that traffic is
            # billed whether or not a page came back. Recording only the
            # navigations that succeeded under-reports the run.
            _bill_proxy_page(url)
            if attempt < retries - 1:
                wait = (2 ** attempt) * 3
                print(f"  Error navigating to {url}: {e} — retrying in {wait}s")
                await asyncio.sleep(wait)
            else:
                print(f"  Failed to load {url} after {retries} attempts: {e}")
                return False
    return False
