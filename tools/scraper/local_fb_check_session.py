"""Validate the FB login profile minted by local_fb_login.py is still
valid by opening facebook.com HEADLESS via the same profile and
reading what FB returns.

This proves the scrape path works end-to-end: same profile, same
binary, same machine, just running headless. If this prints feed
content (groups, friends, "What's on your mind"), every subsequent
scrape will work the same way.

USAGE:
    .venv/Scripts/python.exe -m tools.scraper.local_fb_check_session
"""

from __future__ import annotations

import sys
import time
from pathlib import Path


PROFILE_DIR = Path.home() / ".scraper-profiles" / "fb-default"


def main() -> int:
    if not PROFILE_DIR.exists():
        print(f"ERROR: profile dir not found at {PROFILE_DIR}", file=sys.stderr)
        print("Run tools/scraper/local_fb_login.py first to mint the profile.", file=sys.stderr)
        return 1

    import undetected_chromedriver as uc  # noqa: WPS433 — lazy import

    print(f"INFO: opening headless Brave via profile {PROFILE_DIR}", file=sys.stderr)

    options = uc.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument(f"--user-data-dir={PROFILE_DIR}")
    options.add_argument("--window-size=1280,900")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    # Brave's path. undetected-chromedriver defaults to Chrome; override.
    options.binary_location = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

    # Pin chromedriver to Brave's bundled Chromium major version. Brave
    # 1.x ships Chromium 148 right now; undetected-chromedriver auto-
    # downloads the latest stable (149), so we have to lock it down.
    driver = uc.Chrome(options=options, use_subprocess=True, version_main=148)
    try:
        driver.set_page_load_timeout(60)
        driver.get("https://www.facebook.com/")
        time.sleep(6)
        print(f"URL: {driver.current_url}")
        print(f"TITLE: {driver.title}")
        body = driver.find_element("tag name", "body").text
        print("BODY (first 800):")
        print(body[:800])
    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
