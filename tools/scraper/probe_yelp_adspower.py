"""One-shot probe: can the AdsPower fleet browser screenshot a Yelp /biz page
past DataDome? (The "long shot" after Apify + plain Playwright both got 403'd.)

Runs on the fleet box, where the AdsPower desktop client + local API are
reachable. It starts an AdsPower profile, attaches Playwright over CDP (same
path the IG scraper uses), navigates to a Yelp /biz page, and reports whether
DataDome let it through — printing a clear PASS/FAIL plus saving a screenshot
you can eyeball.

    cd C:\\scraper
    git pull
    .venv\\Scripts\\python.exe -m tools.scraper.probe_yelp_adspower --profile k1fxhgyc

Make sure the chosen AdsPower profile is CLOSED in the AdsPower GUI first, and
that no Instagram browse session is running (it uses the same profile).
"""
from __future__ import annotations

import argparse
import os
import time


def _load_dotenv() -> None:
    env = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    if not os.path.isfile(env):
        return
    for raw in open(env, encoding='utf-8'):
        line = raw.strip()
        if line and not line.startswith('#') and '=' in line:
            k, _, v = line.partition('=')
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


DEFAULT_URL = "https://www.yelp.com/biz/miller-mechanical-heating-and-air-san-diego"


def main() -> int:
    _load_dotenv()
    ap = argparse.ArgumentParser(description="Probe AdsPower vs Yelp DataDome (screenshot test).")
    ap.add_argument('--profile', required=True, help='AdsPower profile id, e.g. k1fxhgyc')
    ap.add_argument('--url', default=DEFAULT_URL, help='Yelp /biz URL to test')
    args = ap.parse_args()

    from tools.scraper.shared import adspower
    from playwright.sync_api import sync_playwright

    print(f"Starting AdsPower profile {args.profile} ...", flush=True)
    info = adspower.start_profile(args.profile)
    dbg = (info or {}).get('debugger_address', '').strip()
    if not dbg:
        print("FAIL: AdsPower returned no CDP debug address (is the client running? profile closed?)")
        return 1
    print(f"Attached to CDP at {dbg}", flush=True)

    pw = sync_playwright().start()
    try:
        browser = pw.chromium.connect_over_cdp(f"http://{dbg}")
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()
        page = ctx.new_page()
        page.set_default_timeout(60000)

        status = None
        try:
            resp = page.goto(args.url, wait_until='domcontentloaded', timeout=60000)
            status = resp.status if resp else None
        except Exception as e:  # noqa: BLE001
            print("goto error:", str(e)[:140])
        time.sleep(8)  # let DataDome's JS challenge resolve if it's going to

        title = ''
        try:
            title = page.title()
        except Exception:  # noqa: BLE001
            pass
        body = ''
        try:
            body = page.inner_text('body')[:2000].lower()
        except Exception:  # noqa: BLE001
            pass

        blocked = (
            status in (403, 429)
            or 'you have been blocked' in body
            or 'access to this page has been denied' in body
            or 'unusual activity' in body
            or 'verify you are a human' in body
            or 'datadome' in body
        )

        out = os.path.join(os.path.dirname(__file__), '..', '..', '.tmp', 'yelp_adspower_probe.png')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        try:
            page.screenshot(path=out, full_page=False)
        except Exception as e:  # noqa: BLE001
            print("screenshot error:", str(e)[:140])

        print("=" * 54)
        print(f"HTTP_STATUS = {status}")
        print(f"TITLE       = {title[:90]}")
        print(f"BLOCKED     = {blocked}")
        print(f"VERDICT     = {'FAIL - DataDome blocked it' if blocked else 'PASS - page rendered, screenshot usable!'}")
        print(f"SCREENSHOT  = {os.path.abspath(out)}")
        print(f"BODY SAMPLE = {body[:200].strip()}")
        print("=" * 54)

        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass
        return 0 if not blocked else 2
    finally:
        try:
            adspower.stop_profile(args.profile)
        except Exception:  # noqa: BLE001
            pass
        try:
            pw.stop()
        except Exception:  # noqa: BLE001
            pass


if __name__ == '__main__':
    raise SystemExit(main())
