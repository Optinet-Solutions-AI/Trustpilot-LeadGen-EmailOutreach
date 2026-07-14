"""
Local headed undetected-chromedriver fetcher.

WHY THIS EXISTS
  Cloudflare-protected sites (TripAdvisor) 403 datacenter IPs and even
  detect headless browsers — so the production scrapers route through
  ScrapingBee (paid). But from a residential IP a HEADED real-Chrome session
  passes Cloudflare's JS challenge for free. Empirically (2026-06-18):

      curl_cffi (Chrome TLS fp)        -> 403
      undetected-chromedriver headless -> Cloudflare wall (~1.5 KB)
      undetected-chromedriver HEADED   -> full page, no challenge

  This drives ONE reused headed session so Cloudflare's clearance cookie
  persists across page loads — only the first navigation pays the challenge,
  every subsequent fetch is fast. Use ONLY on the owner's residential IP for
  one-off jobs (e.g. seeding tripadvisor_cities) — it is NOT a server path.

USAGE
    with LocalBrowserFetcher() as fetch:
        html = fetch("https://www.tripadvisor.com/Tourism-g190311-Malta-Vacations.html")
"""
from __future__ import annotations

import random
import time
from typing import Optional


# Substrings that mean TripAdvisor has rate-flagged this IP. When seen there is
# no point continuing — every further fetch returns the same wall — so the
# fetcher raises BrowserBlocked and the caller aborts the run cleanly.
BLOCK_MARKERS = (
    'Access is temporarily restricted',
    'unusual activity from your device',
)


class BrowserBlocked(Exception):
    """Raised when the site serves a rate-limit / bot-detection wall."""


def _chrome_major() -> Optional[int]:
    """Best-effort local Chrome major version so UC grabs a matching driver."""
    try:
        from tools.scraper.shared.uc_driver import _detect_chrome_major_version
        return _detect_chrome_major_version()
    except Exception:
        return None


class LocalBrowserFetcher:
    """
    A reusable headed Chrome session exposing a `fetch(url) -> html|None`
    callable (returned by __enter__). Real content is distinguished from a
    Cloudflare interstitial by a size floor plus a content marker.
    """

    def __init__(
        self,
        *,
        min_bytes: int = 30_000,
        # 'BreadcrumbList' (JSON-LD) only appears once the real content renders
        # AND is exactly what the containment check needs — so it's the single
        # reliable "page is done, not a Cloudflare interstitial" signal. A loose
        # marker like 'Tourism-g' can appear on a half-hydrated page and let a
        # useless snapshot through.
        markers: tuple[str, ...] = ('BreadcrumbList',),
        max_wait: float = 60.0,
        poll: float = 2.0,
        # Randomised gap between page loads. A fixed fast tick reads as a bot;
        # jittered 5-12s pacing is what keeps the residential IP off the
        # rate-limit wall. Override via the seeder's --min-pace/--max-pace.
        min_pace: float = 5.0,
        max_pace: float = 12.0,
        reloads: int = 1,
        page_timeout: int = 70,
        block_markers: tuple[str, ...] = BLOCK_MARKERS,
        # ── Opt-in residential-proxy path (Yelp DataDome). All default to the
        # legacy owner-local, no-proxy, headed behaviour so TripAdvisor and the
        # existing Yelp browser source are unaffected. ──
        # Port of a running non-MITM CONNECT relay (see proxy_relay.RelayServer);
        # when set, Chrome is launched with --proxy-server=http://127.0.0.1:port
        # so its REAL TLS reaches the origin (no selenium-wire / no MITM).
        proxy_relay_port: Optional[int] = None,
        # Persistent user-data-dir (carries the solved-DataDome browser state).
        profile_dir: Optional[str] = None,
        # CDP Network.setCookie payloads injected before the first navigation
        # (used to replay a minted `datadome` cookie into a fresh profile).
        inject_cookies: Optional[list] = None,
        # None → legacy headed. DataDome re-challenges headless, so the server
        # path is headed-under-xvfb; keep this False/None in production.
        headless: bool = False,
    ):
        self._driver = None
        self.min_bytes = min_bytes
        self.markers = markers
        self.max_wait = max_wait
        self.poll = poll
        self.min_pace = min_pace
        self.max_pace = max_pace
        self.reloads = reloads
        self.page_timeout = page_timeout
        self.block_markers = block_markers
        self.proxy_relay_port = proxy_relay_port
        self.profile_dir = profile_dir
        self.inject_cookies = inject_cookies or []
        self.headless = headless
        self._last_load = 0.0

    def __enter__(self):
        import os
        import undetected_chromedriver as uc

        opts = uc.ChromeOptions()
        opts.add_argument('--window-size=1366,900')
        opts.add_argument('--no-sandbox')
        opts.add_argument('--disable-dev-shm-usage')
        opts.add_argument('--lang=en-US,en')
        if self.proxy_relay_port:
            opts.add_argument(f'--proxy-server=http://127.0.0.1:{self.proxy_relay_port}')
        if self.profile_dir:
            os.makedirs(self.profile_dir, exist_ok=True)
            # Clear stale singleton locks left by a prior crashed session.
            for stale in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
                try:
                    os.remove(os.path.join(self.profile_dir, stale))
                except OSError:
                    pass
            opts.add_argument(f'--user-data-dir={self.profile_dir}')
        major = _chrome_major()
        # headless=False is REQUIRED for TripAdvisor (Cloudflare walls UC
        # headless) AND for Yelp/DataDome (headless is re-challenged even with a
        # valid cookie). Only overridden under a virtual display (xvfb) on Linux.
        self._driver = uc.Chrome(options=opts, headless=self.headless, version_main=major)
        self._driver.set_page_load_timeout(self.page_timeout)
        for cookie in self.inject_cookies:
            try:
                self._driver.execute_cdp_cmd('Network.setCookie', cookie)
            except Exception as e:
                print(f"[local_browser] cookie inject failed: {e}")
        return self.get

    def __exit__(self, *exc):
        try:
            if self._driver:
                self._driver.quit()
        except Exception:
            pass
        self._driver = None
        return False

    def _ready(self, html: str) -> bool:
        return len(html) >= self.min_bytes and any(m in html for m in self.markers)

    def _page_source(self) -> str:
        # A dead/crashed session raises here — swallow it so one bad page can't
        # take down a whole multi-country run.
        try:
            return self._driver.page_source or ''
        except Exception:
            return ''

    def _is_block(self, html: str) -> bool:
        return any(m in html for m in self.block_markers)

    def get(self, url: str) -> Optional[str]:
        d = self._driver
        if d is None:
            raise RuntimeError('LocalBrowserFetcher used outside its context manager')

        # Jittered pacing between loads — avoids tripping the rate-limit wall.
        gap = random.uniform(self.min_pace, self.max_pace) - (time.monotonic() - self._last_load)
        if gap > 0:
            time.sleep(gap)

        html = ''
        # Initial navigation + up to `reloads` retries. Cloudflare's JS
        # challenge usually clears within the wait, but the very first hit of a
        # session sometimes needs a reload to get past it.
        for attempt in range(self.reloads + 1):
            try:
                d.get(url)
            except Exception as e:
                print(f"[local_browser] navigation error for {url}: {e}")

            waited = 0.0
            html = self._page_source()
            while not self._ready(html) and waited < self.max_wait:
                if self._is_block(html):
                    self._last_load = time.monotonic()
                    raise BrowserBlocked(url)
                time.sleep(self.poll)
                waited += self.poll
                html = self._page_source()

            if self._is_block(html):
                self._last_load = time.monotonic()
                raise BrowserBlocked(url)
            if self._ready(html):
                self._last_load = time.monotonic()
                return html
            print(f"[local_browser] page not ready after {self.max_wait:.0f}s "
                  f"(bytes={len(html)}, attempt {attempt + 1}/{self.reloads + 1}) — {url}")

        # Never cleared the challenge — return None so the caller logs it as an
        # empty fetch rather than silently producing zero in-country cities.
        self._last_load = time.monotonic()
        return None
