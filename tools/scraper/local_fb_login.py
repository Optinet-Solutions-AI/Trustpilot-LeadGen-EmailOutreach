"""Local Windows operator login for Facebook (Plan D, 2026-06-01).

After hours of trying to make EC2's Chrome look like a real consumer
device to Facebook, we proved with creepjs that Linux+Xvfb+datacenter
fingerprints irreducibly differ from real Windows Brave/Chrome. FB's
risk engine reads dozens of signals beyond cookies and rejects EC2
sessions even with valid credentials + Meta verification + captcha
solved.

This script runs ON THE OPERATOR'S WINDOWS MACHINE using Brave
(which the operator just confirmed works for FB login at home). It
opens Brave headful with a DEDICATED user-data-dir (separate from
the operator's main Brave profile so we don't interfere with their
personal browsing), idles until the operator closes the window, and
the resulting profile is reusable for headless scraping later.

WHY BRAVE: Brave is Chromium-based (same DevTools API as Chrome) so
selenium / undetected-chromedriver work identically. AND Brave's
default privacy settings (canvas fingerprint randomization, WebRTC
IP masking) make FB's fingerprinting LESS effective, not more. The
operator's home Brave already passed FB's checks; this script uses
the same binary.

USAGE:
    .venv/Scripts/python.exe -m tools.scraper.local_fb_login

After running, the profile lives at:
    C:\\Users\\<user>\\.scraper-profiles\\fb-default\\

Subsequent scrape calls will reuse this profile.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


BRAVE_EXE = Path(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe")
PROFILE_BASE = Path.home() / ".scraper-profiles"
DEFAULT_PROFILE = PROFILE_BASE / "fb-default"

LOGIN_URL = "https://www.facebook.com/"


def main() -> int:
    if not BRAVE_EXE.exists():
        print(f"ERROR: Brave not found at {BRAVE_EXE}", file=sys.stderr)
        return 1

    DEFAULT_PROFILE.mkdir(parents=True, exist_ok=True)
    print(f"INFO: profile dir = {DEFAULT_PROFILE}", file=sys.stderr)
    print(f"INFO: launching Brave at {BRAVE_EXE}", file=sys.stderr)
    print("INFO: log in to Facebook in the window that opens.", file=sys.stderr)
    print("INFO: when the homepage looks right, close the window normally (X button).", file=sys.stderr)
    print("INFO: the profile auto-saves; subsequent scrapes will reuse the session.", file=sys.stderr)

    cmd = [
        str(BRAVE_EXE),
        f"--user-data-dir={DEFAULT_PROFILE}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
        LOGIN_URL,
    ]

    # Run Brave in the foreground; block until the operator closes the
    # window. Brave's process exits when ALL its windows are closed.
    result = subprocess.run(cmd)

    if result.returncode != 0:
        print(f"WARN: Brave exited with code {result.returncode}", file=sys.stderr)

    print(f"INFO: Brave closed. Profile saved at {DEFAULT_PROFILE}", file=sys.stderr)

    # Quick sanity: did Brave actually write a Cookies file?
    # Brave/Chromium 121+ stores cookies under Default/Network/Cookies
    # instead of the legacy Default/Cookies path.
    for candidate in (
        DEFAULT_PROFILE / "Default" / "Network" / "Cookies",
        DEFAULT_PROFILE / "Default" / "Cookies",
    ):
        if candidate.exists():
            size = candidate.stat().st_size
            print(f"INFO: Cookies file: {candidate} ({size} bytes)", file=sys.stderr)
            break
    else:
        print(f"WARN: no Cookies file under {DEFAULT_PROFILE} — session may not have saved", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
