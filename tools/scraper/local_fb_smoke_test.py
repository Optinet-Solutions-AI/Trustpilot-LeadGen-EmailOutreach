"""Smoke test: does FB still accept the saved Brave session when
accessed (a) headless and (b) through the Enigma PH residential proxy?

If YES — Windows EC2 + Brave + Enigma is a viable architecture for
multi-user 24/7 scraping. We just need to provision and the same
local_fb_login flow ports over.

If NO — datacenter+headless+proxy is fundamentally rejected by FB
regardless of OS. We need behavioral simulation or extension-based
scraping (user's own browser doing the work).

Four runs, each with a distinct config:
  1. headless, direct (no proxy)        — baseline (should work — we already validated this)
  2. headed, proxy=Enigma PH             — does the proxy itself flag the session?
  3. headless, proxy=Enigma PH           — what Windows EC2 would actually be doing
  4. headless, proxy, +stealth fingerprint massaging — last resort if 3 fails

Each run reports: title, URL, presence of login form / feed.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional


PROFILE_DIR = Path.home() / ".scraper-profiles" / "fb-default"
BRAVE_BIN = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

# Enigma PH residential proxy (matches /etc/scraper-worker.env on EC2).
PROXY_HOST = "resi.enigmaproxy.net"
PROXY_PORT = "12321"
PROXY_USER = "0048277fc210"
PROXY_PASS = "58fc5cbc0ebf_country-PH"


def run(config_name: str, headless: bool, use_proxy: bool) -> str:
    import undetected_chromedriver as uc  # noqa: WPS433

    print(f"\n=== {config_name} ===", file=sys.stderr)
    options = uc.ChromeOptions()
    if headless:
        options.add_argument("--headless=new")
    options.add_argument(f"--user-data-dir={PROFILE_DIR}")
    options.add_argument("--window-size=1280,900")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.binary_location = BRAVE_BIN

    seleniumwire_options: Optional[dict] = None
    if use_proxy:
        proxy_url = f"http://{PROXY_USER}:{PROXY_PASS}@{PROXY_HOST}:{PROXY_PORT}"
        seleniumwire_options = {
            "proxy": {
                "http": proxy_url,
                "https": proxy_url,
                "no_proxy": "localhost,127.0.0.1",
            },
            "verify_ssl": False,
            "disable_capture": True,
        }
        options.add_argument("--ignore-certificate-errors")

    driver = None
    try:
        if seleniumwire_options:
            from seleniumwire.undetected_chromedriver import Chrome as WireUCChrome
            driver = WireUCChrome(
                options=options,
                seleniumwire_options=seleniumwire_options,
                use_subprocess=True,
                version_main=148,
            )
        else:
            driver = uc.Chrome(options=options, use_subprocess=True, version_main=148)

        driver.set_page_load_timeout(60)
        driver.get("https://www.facebook.com/")
        time.sleep(7)
        url = driver.current_url
        title = driver.title
        body = driver.find_element("tag name", "body").text[:500]
        login_form_visible = (
            "/login" in url
            or "Log into Facebook" in body
            or "Log in" in body and "Email or mobile number" in body
        )
        feed_visible = any(t in body for t in (
            "What's on your mind",
            "James Optirate",
            "Friends",
            "Memories",
            "Saved",
            "Groups",
        ))
        verdict = "PASS" if feed_visible and not login_form_visible else "FAIL"
        result = f"[{verdict}] {config_name}\n  url={url}\n  title={title!r}\n  body[:200]={body[:200]!r}"
        return result
    except Exception as exc:  # noqa: BLE001
        return f"[ERROR] {config_name}: {exc}"
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass


def main() -> int:
    if not PROFILE_DIR.exists():
        print(f"ERROR: profile dir not found at {PROFILE_DIR}", file=sys.stderr)
        return 1

    results = []
    results.append(run("1. headless, direct (baseline)", headless=True, use_proxy=False))
    results.append(run("2. headed, proxy=Enigma PH", headless=False, use_proxy=True))
    results.append(run("3. headless, proxy=Enigma PH (Windows EC2 simulation)", headless=True, use_proxy=True))

    print("\n\n========== SUMMARY ==========\n")
    for r in results:
        print(r)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
