"""Screenshots through Apify's UNBLOCKER proxy — the ScrapingBee replacement.

WHY THIS EXISTS

  ScrapingBee is out of credits and is not being renewed, but screenshots are
  load-bearing: campaigns embed them (`include_screenshot`), and the "here is
  your rating" pitch is the screenshot.

  The free path — undetected-chromedriver on the owner's residential IP —
  clears both walls, but only HEADED. Measured 2026-09-24 on the same
  connection: headed cleared TripAdvisor and produced an 880KB page; headless
  was refused with "Access is temporarily restricted ... Automated (bot)
  activity ... Use of developer or inspection tools". So it cannot run on the
  EC2 worker, where real jobs execute.

  Apify's UNBLOCKER proxy group solves the challenge server-side the way
  ScrapingBee did, and it works HEADLESS. Verified 2026-09-24:

      TripAdvisor  77s   976KB   full profile page, rating and review count
      Yelp        100s   108KB   full profile page, rating and review count

  This is a PROXY, not an actor. That is deliberate: `apify/puppeteer-scraper`
  refuses to run until its full-account permission is approved by hand in the
  console (403 full-permission-actor-not-approved), and an actor would bill
  per run on top. The proxy needs no approval and reuses the browser we
  already ship.

COST

  Billed as PROXY_UNBLOCKER_UNITS, $0.06 per 400 units, and a page load
  measured at roughly 80-100 units — about **$0.012-0.015 per screenshot**.
  Reported through the usual COST: line so it lands on the job.

THE TWO THINGS THAT WILL BITE

  1. UNBLOCKER terminates TLS itself, so its certificate is not one the
     browser trusts. Without `ignore_https_errors` every page fails with
     ERR_CERT_AUTHORITY_INVALID.
  2. It is SLOW — 77-100s a page against ScrapingBee's few seconds. Callers
     must run these concurrently or a 50-lead scrape takes over an hour.

ENV
    APIFY_API_TOKEN       required (already set for the Yelp/Booking actors)
    SCREENSHOT_SOURCE     `apify` (this) or `scrapingbee` (legacy)
    APIFY_SHOT_TIMEOUT_S  per-page ceiling, default 180
"""
from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from typing import Optional

from tools.scraper.shared.cost_report import report_cost

PROXY_SERVER = 'http://proxy.apify.com:8000'
PROXY_GROUP_USER = 'groups-UNBLOCKER'
# $0.06 per 400 units, ~90 units a page load. An estimate, and labelled as one
# on the job — the authoritative figure is Apify's own usage page.
USD_PER_SCREENSHOT = 0.06 / 400 * 90

_password_cache: Optional[str] = None


def apify_screenshot_enabled() -> bool:
    return bool(os.environ.get('APIFY_API_TOKEN', '').strip())


def screenshot_source() -> str:
    """Which backend takes screenshots. Defaults to Apify when a token exists.

    ScrapingBee is out of credits and not being renewed, so defaulting to it
    would mean every screenshot silently fails on a fresh deployment.
    """
    explicit = os.environ.get('SCREENSHOT_SOURCE', '').strip().lower()
    if explicit:
        return explicit
    return 'apify' if apify_screenshot_enabled() else 'scrapingbee'


def _proxy_password() -> Optional[str]:
    """Apify's proxy password, fetched once per process."""
    global _password_cache
    if _password_cache:
        return _password_cache
    token = os.environ.get('APIFY_API_TOKEN', '').strip()
    if not token:
        return None
    try:
        req = urllib.request.Request(
            'https://api.apify.com/v2/users/me',
            headers={'Authorization': f'Bearer {token}'},
        )
        data = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
        _password_cache = data['data']['proxy']['password']
        return _password_cache
    except Exception as e:
        print(f"[apify-shot] could not read proxy password: {type(e).__name__}: {e}", flush=True)
        return None


# Signs the page is a challenge rather than the business. The interstitial
# renders almost NO text, which is why an empty body counts: a check that only
# looked for these phrases scored a blank challenge page as a success.
_BLOCK_SIGNS = (
    'access is temporarily restricted',
    'unusual activity',
    'verifying you are human',
    'checking your browser',
    'just a moment',
    'access to this page has been denied',
    'attention required',
)
_MIN_BODY_CHARS = 80


def looks_blocked(body_text: str) -> bool:
    """Is this a challenge page? Empty counts — the interstitial has no text."""
    text = (body_text or '').strip()
    if len(text) < _MIN_BODY_CHARS:
        return True
    lowered = text.lower()
    return any(sign in lowered for sign in _BLOCK_SIGNS)


def fetch_screenshot_via_apify(
    target_url: str,
    *,
    full_page: bool = False,
    platform: Optional[str] = None,
    wait_selector: Optional[str] = None,
) -> Optional[bytes]:
    """PNG bytes for a page, or None on any failure.

    Same contract as fetch_screenshot_via_scrapingbee: never raises, so a
    screenshot problem costs a screenshot rather than the whole lead.
    """
    password = _proxy_password()
    if not password:
        return None

    timeout_s = int(os.environ.get('APIFY_SHOT_TIMEOUT_S', '180') or 180)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('[apify-shot] playwright is not installed', flush=True)
        return None

    browser = None
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True,
                proxy={'server': PROXY_SERVER, 'username': PROXY_GROUP_USER,
                       'password': password},
                args=['--disable-blink-features=AutomationControlled'],
            )
            ctx = browser.new_context(
                # UNBLOCKER terminates TLS itself, so its certificate is not
                # trusted. Refusing it is right in general and wrong here.
                ignore_https_errors=True,
                locale='en-US',
                viewport={'width': 1400, 'height': 1800},
                user_agent=('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                            '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'),
            )
            page = ctx.new_page()
            page.goto(target_url, timeout=timeout_s * 1000, wait_until='domcontentloaded')

            # Wait for real content rather than a fixed sleep — Yelp took 100s
            # against TripAdvisor's 77s, and a fixed wait either wastes time or
            # captures a half-rendered page.
            try:
                page.wait_for_selector(wait_selector or 'h1', timeout=min(90, timeout_s) * 1000)
            except Exception:
                pass
            page.wait_for_timeout(3000)

            body = ''
            try:
                body = page.inner_text('body')[:600]
            except Exception:
                pass
            if looks_blocked(body):
                print(f"FAILED:screenshot|{target_url}|unblocker_challenge|"
                      f"Apify UNBLOCKER returned a challenge page, not the profile.",
                      flush=True)
                return None

            shot = page.screenshot(full_page=full_page)
            # Charged whether or not the bytes are usable — the page was
            # fetched either way.
            report_cost(platform, 'apify-unblocker', units=1,
                        unit_label='screenshots', usd=USD_PER_SCREENSHOT)
            return shot
    except Exception as e:
        print(f"[apify-shot] {target_url}: {type(e).__name__}: {str(e)[:160]}", flush=True)
        return None
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass


async def fetch_screenshots_via_apify(
    urls: list[str],
    *,
    platform: Optional[str] = None,
    concurrency: int = 4,
    full_page: bool = False,
) -> dict[str, Optional[bytes]]:
    """Several screenshots at once.

    Concurrency is not a nicety here: at 77-100s a page, a 50-lead scrape
    takes over an hour serially. Each call launches its own browser, so the
    limit is memory — 4 is comfortable on the 2GB worker.
    """
    sem = asyncio.Semaphore(max(1, concurrency))
    out: dict[str, Optional[bytes]] = {}

    async def one(url: str) -> None:
        async with sem:
            out[url] = await asyncio.to_thread(
                fetch_screenshot_via_apify, url, full_page=full_page, platform=platform,
            )

    await asyncio.gather(*(one(u) for u in urls))
    return out


def fetch_profile_screenshot(
    target_url: str,
    *,
    platform: Optional[str] = None,
    full_page: bool = False,
    wait_selector: Optional[str] = None,
) -> Optional[bytes]:
    """The single decision about which backend takes a screenshot.

    One seam rather than the same if/else copied into every platform plugin:
    both call sites were byte-identical, and a divergence between them is how
    one platform quietly keeps calling a vendor that has been switched off.
    """
    source = screenshot_source()

    if source == 'apify':
        return fetch_screenshot_via_apify(
            target_url, full_page=full_page, platform=platform, wait_selector=wait_selector,
        )

    # Legacy path. Imported lazily so a deployment with no ScrapingBee key —
    # which is now the normal case — does not pay for the import.
    from tools.scraper.shared.scrapingbee import fetch_screenshot_via_scrapingbee
    return fetch_screenshot_via_scrapingbee(
        target_url, full_page=full_page, stealth_proxy=True, render_js=True,
    )
