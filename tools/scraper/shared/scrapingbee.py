"""
Python ScrapingBee helper — mirrors server/src/services/scrapers/tier5-scrapingbee.ts
so the Python scraper plugins (TripAdvisor and any future CF-protected platform)
can share the same defaults and credit-cost trade-offs.

WHY THIS EXISTS

  TripAdvisor fronts every page with Cloudflare + fingerprint detection. Even
  Playwright with stealth from a residential IP got 403'd. The only path that
  consistently works is letting ScrapingBee handle the CF challenge server-side
  and return us the rendered HTML. Same pattern as the existing TS tier5 used
  by the website enricher; this is the Python twin.

CREDIT COST (per call, against ScrapingBee's pricing)

  render_js=true                    : 5 credits
  premium_proxy=true                : 10 credits (residential IPs)
  stealth_proxy=true                : 75 credits (highest tier; overrides premium)
  screenshot=true                   : free (added to whatever proxy tier you chose)

  TripAdvisor needs stealth_proxy + render_js for both listing AND profile
  pages — premium_proxy alone gets through their homepage but listing pages
  routinely 403 on the premium pool. Cost: ~75 credits per page.

  At 1000 free credits/mo this is ~13 listing scrapes per month with profile
  enrichment included. Real production volume needs a paid tier or fewer pages.
"""
from __future__ import annotations

import os
import urllib.parse
from typing import Optional

import requests


SCRAPINGBEE_BASE = 'https://app.scrapingbee.com/api/v1/'
# ScrapingBee server-side render timeout. Cloudflare-protected sites with
# premium/stealth proxy + JS render routinely take 30–60s on their backend.
# Match the TS tier5's 70_000 ceiling.
SCRAPINGBEE_TIMEOUT_MS = 70_000
# Local socket timeout — SB timeout + buffer for network roundtrip.
SOCKET_TIMEOUT_S = 90
# Cap response body so a 10MB SPA download can't blow up memory.
MAX_BYTES = 5_000_000


def scrapingbee_enabled() -> bool:
    return bool(os.environ.get('SCRAPINGBEE_API_KEY'))


def fetch_via_scrapingbee(
    target_url: str,
    *,
    render_js: bool = True,
    premium_proxy: bool = True,
    stealth_proxy: bool = False,
    block_resources: bool = False,
    country_code: Optional[str] = None,
    extra_params: Optional[dict[str, str]] = None,
) -> Optional[str]:
    """
    Fetch a URL through ScrapingBee and return the rendered HTML as a string.

    Returns None on any failure (no API key, network error, ScrapingBee 4xx/5xx).
    Caller is expected to handle None as "couldn't fetch — proceed with empty
    extraction" rather than raising. Matches the TS tier5 fallback semantics.

    Pass stealth_proxy=True for Cloudflare-protected targets. It supersedes
    premium_proxy (they're mutually exclusive on ScrapingBee's side).
    """
    api_key = os.environ.get('SCRAPINGBEE_API_KEY')
    if not api_key:
        return None

    params: dict[str, str] = {
        'api_key': api_key,
        'url': target_url,
        'render_js': str(render_js).lower(),
        'block_resources': str(block_resources).lower(),
        'timeout': str(SCRAPINGBEE_TIMEOUT_MS),
    }
    if stealth_proxy:
        params['stealth_proxy'] = 'true'
    else:
        params['premium_proxy'] = str(premium_proxy).lower()
    if country_code:
        params['country_code'] = country_code
    if render_js:
        # Hold render until network is idle so client-side widgets fully paint
        # before we extract HTML. Matches TS tier5's networkidle0 default.
        params['wait_browser'] = 'networkidle0'
    if extra_params:
        params.update(extra_params)

    proxy_tier = 'stealth' if stealth_proxy else 'premium'

    try:
        resp = requests.get(SCRAPINGBEE_BASE, params=params, timeout=SOCKET_TIMEOUT_S, stream=True)
    except requests.exceptions.RequestException as e:
        print(f"[scrapingbee:{proxy_tier}] transport error: {e}")
        return None

    status = resp.status_code
    if status == 401 or status == 403:
        print(f"[scrapingbee:{proxy_tier}] API auth/quota error {status} — check SCRAPINGBEE_API_KEY")
        resp.close()
        return None
    if status == 429:
        print(f"[scrapingbee:{proxy_tier}] credit pool depleted or rate limited (429)")
        resp.close()
        return None
    if status < 200 or status >= 300:
        # ScrapingBee returns useful diagnostics in the body — log a snippet so
        # the operator can spot patterns like "Cloudflare challenge unresolved".
        try:
            snippet = resp.text[:300]
        except Exception:
            snippet = '<unreadable body>'
        print(f"[scrapingbee:{proxy_tier}] non-2xx {status}: {snippet}")
        resp.close()
        return None

    # Stream-read with a hard cap.
    body_chunks: list[bytes] = []
    total = 0
    for chunk in resp.iter_content(chunk_size=65536):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_BYTES:
            print(f"[scrapingbee:{proxy_tier}] body exceeded {MAX_BYTES} bytes; truncating")
            break
        body_chunks.append(chunk)
    resp.close()
    try:
        return b''.join(body_chunks).decode('utf-8', errors='replace')
    except Exception as e:
        print(f"[scrapingbee:{proxy_tier}] decode error: {e}")
        return None


def fetch_screenshot_via_scrapingbee(
    target_url: str,
    *,
    full_page: bool = False,
    stealth_proxy: bool = True,
    render_js: bool = True,
    country_code: Optional[str] = None,
) -> Optional[bytes]:
    """
    Capture a screenshot of a page through ScrapingBee. Returns raw PNG bytes
    or None on any failure.

    Screenshots are FREE on ScrapingBee (charged only for the underlying
    proxy + render). full_page=True captures the full scrollable height;
    default is just the viewport (1280x800 ish), which is what we want for
    TripAdvisor profile headers.

    `screenshot=true` and `screenshot_full_page=true` are mutually exclusive
    parameters per their API. ScrapingBee returns the PNG as the response
    body when either flag is set.
    """
    api_key = os.environ.get('SCRAPINGBEE_API_KEY')
    if not api_key:
        return None

    params: dict[str, str] = {
        'api_key': api_key,
        'url': target_url,
        'render_js': str(render_js).lower(),
        'timeout': str(SCRAPINGBEE_TIMEOUT_MS),
    }
    if full_page:
        params['screenshot_full_page'] = 'true'
    else:
        params['screenshot'] = 'true'
    if stealth_proxy:
        params['stealth_proxy'] = 'true'
    else:
        params['premium_proxy'] = 'true'
    if country_code:
        params['country_code'] = country_code
    if render_js:
        params['wait_browser'] = 'networkidle0'

    try:
        resp = requests.get(SCRAPINGBEE_BASE, params=params, timeout=SOCKET_TIMEOUT_S)
    except requests.exceptions.RequestException as e:
        print(f"[scrapingbee:screenshot] transport error: {e}")
        return None
    if resp.status_code != 200:
        print(f"[scrapingbee:screenshot] non-200 {resp.status_code}: {resp.text[:200]}")
        return None
    body = resp.content
    if len(body) > MAX_BYTES:
        print(f"[scrapingbee:screenshot] response > {MAX_BYTES} bytes; discarding")
        return None
    return body


def build_target_url(base: str, query: Optional[dict[str, str]] = None) -> str:
    """Convenience: build a target URL with query params for SB to fetch."""
    if not query:
        return base
    qs = urllib.parse.urlencode(query)
    sep = '&' if '?' in base else '?'
    return f"{base}{sep}{qs}"


def fetch_via_scrapingbee_tiered(
    target_url: str,
    *,
    render_js: bool = True,
    block_resources: bool = False,
    country_code: Optional[str] = None,
) -> Optional[str]:
    """
    Cost-optimized fetch with automatic proxy escalation.

      1. Try premium_proxy first  (~15 credits with render_js)
      2. If we get HTTP 403 or empty body, retry with stealth_proxy (~75 credits)

    For sites that don't actively block ScrapingBee's premium residential
    pool — most of the web — premium is enough and we save ~60 credits per
    call. For Cloudflare-and-Datadome-hardened sites like TripAdvisor that
    refuse premium, the fallback adds latency (one extra round trip) but
    no net new cost compared to going straight to stealth.

    Mirrors the proxy-tier ladder in
    server/src/services/scrapers/website-enricher.ts (Trustpilot upstream
    has done the same thing for casino operators that blocked premium).
    """
    # Attempt 1: premium_proxy
    html = fetch_via_scrapingbee(
        target_url,
        render_js=render_js,
        premium_proxy=True,
        stealth_proxy=False,
        block_resources=block_resources,
        country_code=country_code,
    )
    if html and len(html) > 1000:
        # Heuristic: a successful TripAdvisor page is hundreds of KB.
        # A 403 challenge page through premium_proxy fits in well under 1KB.
        # Trustpilot's "Just a moment..." CF interstitial is also small.
        return html
    if html and 'cloudflare' in html.lower()[:5000] and 'challenge' in html.lower()[:5000]:
        # Got the CF challenge page rather than the real content. Escalate.
        print(f"[scrapingbee:tiered] premium returned CF challenge page; escalating to stealth")
        html = None
    if not html:
        print(f"[scrapingbee:tiered] premium attempt empty; retrying with stealth_proxy")
    # Attempt 2: stealth_proxy
    return fetch_via_scrapingbee(
        target_url,
        render_js=render_js,
        stealth_proxy=True,
        block_resources=block_resources,
        country_code=country_code,
    )
