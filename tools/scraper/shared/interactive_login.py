"""Operator-driven interactive Facebook login through a persistent
Chrome profile (Plan B, 2026-05-30).

Unlike `tools/scraper/shared/login_flows.py` (which captures cookies
into the DB), this script keeps the cookies on disk inside the
Chrome user-data-dir, then the scraping path reads that same dir.
Because the SAME Chrome binary on the SAME machine performs the
login and the scrape, the device fingerprint stays self-consistent
and FB doesn't trip the "trusted session, unknown device" gate that
killed every cross-machine cookie transplant we tried.

INVOCATION (run as the scraper user on EC2, with Xvfb already
running on :99 and the residential proxy env vars exported):

    DISPLAY=:99 FB_PROFILE_DIR=/srv/fb-profiles/<account_id> \\
    FB_PROFILE_HEADFUL=true \\
    .venv/bin/python -m tools.scraper.shared.interactive_login

The script opens a headful Chrome through selenium-wire (so proxy
auth happens silently in Python, no popup dialog), navigates to
the Facebook login page, then idles until the operator closes the
window. Closing the window quits the driver gracefully so the
profile dir is flushed cleanly to disk.

The proxy is the SAME proxy the eventual scrape runs use. Same
selenium-wire TLS fingerprint, same proxy egress IP class — FB
sees one consistent device across login and every later scrape.
"""

from __future__ import annotations

import os
import sys
import time

# Re-use the same driver factory the scraper uses. _open_driver()
# already honors FB_PROFILE_DIR + FB_PROFILE_HEADFUL (added in the
# same patch as this file).
from tools.scraper.platforms import facebook as fb


LOGIN_URL = 'https://www.facebook.com/login'
IDLE_POLL_SECONDS = 3


def main() -> int:
    profile_dir = os.environ.get('FB_PROFILE_DIR')
    if not profile_dir:
        print('ERROR: FB_PROFILE_DIR must be set', file=sys.stderr)
        return 1
    os.environ.setdefault('FB_PROFILE_HEADFUL', 'true')

    # Some operator setups (proxy regions other than PH) want to override.
    # Default to PH because that's where the rest of the stack is tuned today.
    fb._CURRENT_LOCATION = os.environ.get('FB_LOGIN_CITY', 'Cebu')

    print(f'INFO: launching Chrome with persistent profile at {profile_dir}', file=sys.stderr)
    print('INFO: waiting for operator to log in via VNC...', file=sys.stderr)
    print('INFO: close the Chrome window when finished to save the profile.', file=sys.stderr)

    driver = fb._open_driver()
    try:
        driver.get(LOGIN_URL)
        # Idle loop: poll the driver. When the operator closes Chrome the
        # session goes invalid and current_url raises — that's our exit
        # signal. Use a short sleep so Ctrl-C from the bash wrapper also
        # interrupts promptly.
        while True:
            try:
                _ = driver.current_url
            except Exception:  # noqa: BLE001 — any WebDriver error means window gone
                break
            time.sleep(IDLE_POLL_SECONDS)
    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass

    print('INFO: Chrome closed; profile saved to disk.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
