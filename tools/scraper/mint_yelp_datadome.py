"""Mint a Yelp DataDome cookie (human-in-the-loop, once) for YELP_LISTING_SOURCE=relay.

Yelp /search is guarded by DataDome, which serves an interactive slider to every
fresh cookieless session. A human solves it ONCE in a visible browser; the
resulting `datadome` cookie (bound to the sticky exit IP) is then replayed by the
relay listing source for headed server-side scrapes until it expires or the exit
IP drifts — the same checkpoint-recovery pattern used for Facebook.

Run it on a machine with a visible display (owner desktop, or EC2 under
xvfb/noVNC):

    PYTHONUTF8=1 .venv/Scripts/python.exe -m tools.scraper.mint_yelp_datadome

Env (all optional; must match the values the scraper will later use):
    YELP_PROXY_COUNTRY        exit country ISO-2           (default US)
    YELP_STICKY_SESSION       Enigma session token         (default optirate-yelp)
    YELP_PROXY_PROFILE_DIR    persistent Chrome profile    (default .tmp/yelp_profile)
    YELP_DATADOME_COOKIE_FILE where to write the bundle    (default tools/scraper/data/yelp_datadome_cookie.json)

When the cookie later stops working the relay source emits
FAILED:listing|yelp|datadome_challenge — just re-run this script.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time

from tools.scraper.shared.proxy_relay import RelayServer
from tools.scraper.shared.uc_driver import _detect_chrome_major_version
from tools.scraper.platforms.yelp import _parse_yelp_search_cards, _DATADOME_COOKIE_PATH

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MINT_URL = 'https://www.yelp.com/search?find_desc=plumbers&find_loc=Chicago%2C+IL&start=0'
_SOLVE_TIMEOUT = 240


def main() -> int:
    country = os.environ.get('YELP_PROXY_COUNTRY', 'US')
    session = os.environ.get('YELP_STICKY_SESSION', 'optirate-yelp')
    profile_dir = os.environ.get('YELP_PROXY_PROFILE_DIR') or os.path.join(
        _REPO_ROOT, '.tmp', 'yelp_profile')
    cookie_file = os.environ.get('YELP_DATADOME_COOKIE_FILE', _DATADOME_COOKIE_PATH)
    os.makedirs(profile_dir, exist_ok=True)
    os.makedirs(os.path.dirname(cookie_file), exist_ok=True)

    import undetected_chromedriver as uc

    with RelayServer(country=country, session=session) as relay:
        print(f"[mint] relay 127.0.0.1:{relay.port} exit={country} session={session}", flush=True)
        opts = uc.ChromeOptions()
        for c in (r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                  r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'):
            if os.path.exists(c):
                opts.binary_location = c
                break
        opts.add_argument(f'--proxy-server=http://127.0.0.1:{relay.port}')
        opts.add_argument(f'--user-data-dir={profile_dir}')
        opts.add_argument('--window-size=1366,900')
        opts.add_argument('--lang=en-US,en')
        driver = uc.Chrome(options=opts, headless=False,
                           version_main=_detect_chrome_major_version())
        driver.set_page_load_timeout(50)
        try:
            driver.get('https://ipinfo.io/json')
            time.sleep(2)
            m = re.search(r'\{.*\}', driver.page_source, re.S)
            exit_ip = json.loads(m.group(0)) if m else {}
            print(f"[mint] exit IP: {exit_ip.get('ip')} {exit_ip.get('city')} {exit_ip.get('country')}", flush=True)

            driver.get(_MINT_URL)
            time.sleep(4)
            print('\n' + '=' * 68, flush=True)
            print('>>> HUMAN: SOLVE THE DATADOME SLIDER IN THE CHROME WINDOW NOW <<<', flush=True)
            print('=' * 68 + '\n', flush=True)

            cards: list = []
            deadline = time.time() + _SOLVE_TIMEOUT
            while time.time() < deadline:
                time.sleep(4)
                cards = _parse_yelp_search_cards(driver.page_source or '')
                if cards:
                    break
                print(f"[mint] waiting for solve... {int(deadline - time.time())}s left", flush=True)

            if not cards:
                print('[mint] FAILED: no results after solve window. Cookie NOT saved.', flush=True)
                return 1

            cookies = driver.get_cookies()
            dd = next((c for c in cookies if c.get('name') == 'datadome'), None)
            if not dd:
                print('[mint] FAILED: cleared but no datadome cookie present.', flush=True)
                return 1
            bundle = {
                'datadome_cookie': dd,
                'exit_ip': exit_ip,
                'sticky_session': session,
                'proxy_country': country,
                'minted_at': time.time(),
                'card_count': len(cards),
            }
            with open(cookie_file, 'w', encoding='utf-8') as f:
                json.dump(bundle, f, indent=2)
            print(f"[mint] OK: {len(cards)} cards, cookie saved to {cookie_file}", flush=True)
            print(f"[mint] set YELP_LISTING_SOURCE=relay YELP_STICKY_SESSION={session} "
                  f"YELP_PROXY_COUNTRY={country} to use it (headed / xvfb).", flush=True)
            return 0
        finally:
            try:
                driver.quit()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
