"""
Shared browser utilities for all scrapers.
Provides stealth Playwright browser launching, popup dismissal, and delay helpers.
Adapted from BannerScrapper browser-launcher.ts and popup-handler.ts patterns.
"""

import os
import random
import asyncio
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
]


def random_user_agent() -> str:
    return random.choice(USER_AGENTS)


async def human_delay(min_s: float = 2.0, max_s: float = 5.0):
    """Randomized sleep to avoid rate limiting."""
    delay = random.uniform(min_s, max_s)
    await asyncio.sleep(delay)


async def launch_browser() -> tuple[Browser, BrowserContext, Page]:
    """
    Launch a stealth-configured Chromium browser.
    Returns (browser, context, page).
    """
    headless = os.getenv('PLAYWRIGHT_HEADLESS', 'true').lower() == 'true'

    pw = await async_playwright().start()

    browser = await pw.chromium.launch(
        headless=headless,
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


async def safe_goto(page: Page, url: str, retries: int = 3, timeout: int = 30000) -> bool:
    """Navigate to URL with retry logic and exponential backoff."""
    for attempt in range(retries):
        try:
            response = await page.goto(url, wait_until='domcontentloaded', timeout=timeout)
            if response and response.status == 403:
                wait = (2 ** attempt) * 5
                print(f"  403 on {url} — retrying in {wait}s (attempt {attempt + 1}/{retries})")
                await asyncio.sleep(wait)
                continue
            await dismiss_popups(page)
            return True
        except Exception as e:
            if attempt < retries - 1:
                wait = (2 ** attempt) * 3
                print(f"  Error navigating to {url}: {e} — retrying in {wait}s")
                await asyncio.sleep(wait)
            else:
                print(f"  Failed to load {url} after {retries} attempts: {e}")
                return False
    return False
