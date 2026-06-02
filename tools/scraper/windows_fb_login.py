"""Windows EC2 worker FB login (Phase 1, 2026-06-02).

Mirrors tools/scraper/local_fb_login.py but takes a social_account_id
argument and stores the profile at C:\\fb-profiles\\<account_id>\\
instead of the operator's home dir. This is what the Windows EC2
worker daemon will spawn per operator (each social_accounts row gets
its own Brave profile dir on the EC2 host).

USAGE (run as Administrator in PowerShell, inside an RDP session
so the operator can see the Brave window):

    cd C:\\scraper
    .venv\\Scripts\\python.exe -m tools.scraper.windows_fb_login <account_id>

Example:
    .venv\\Scripts\\python.exe -m tools.scraper.windows_fb_login 0eec969c-a888-4e54-bdfe-057ca11c2af5

A Brave window opens at facebook.com. Log in normally. When the
homepage shows the feed, close the Brave window. The profile auto-
saves to disk; subsequent headless scrapes use the same dir.

NOTE: Brave's singleton can route the URL to an existing Brave
process if one is already running. The script kills any prior
Brave instances before launching to prevent this.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path


def _find_brave() -> Path:
    """Brave's install path varies — Chocolatey on Windows Server often
    drops it per-user under %LOCALAPPDATA% instead of Program Files.
    Try the common locations in order until we find brave.exe."""
    import os
    candidates = [
        Path(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
        Path(r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
        Path.home() / "AppData" / "Local" / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
    ]
    for c in candidates:
        if c.exists():
            return c
    # Last resort: PATH lookup
    import shutil
    on_path = shutil.which("brave")
    if on_path:
        return Path(on_path)
    return Path(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe")  # default for error message


BRAVE_EXE = _find_brave()
PROFILE_ROOT = Path(r"C:\fb-profiles")
LOGIN_URL = "https://www.facebook.com/"

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def kill_existing_brave() -> None:
    """Kill any running Brave processes — Brave's singleton will hijack
    our --user-data-dir launch otherwise, sending the URL to whichever
    Brave was already running (likely the operator's main profile)."""
    subprocess.run(
        ["taskkill", "/F", "/IM", "brave.exe"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    time.sleep(2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("account_id", help="social_accounts.id UUID")
    args = parser.parse_args()

    if not UUID_RE.match(args.account_id):
        print(f"ERROR: account_id must be a UUID, got: {args.account_id!r}", file=sys.stderr)
        return 1

    if not BRAVE_EXE.exists():
        print(f"ERROR: Brave not found at {BRAVE_EXE}", file=sys.stderr)
        print("Run scripts/ec2-windows-setup.ps1 first.", file=sys.stderr)
        return 1

    profile_dir = PROFILE_ROOT / args.account_id
    profile_dir.mkdir(parents=True, exist_ok=True)

    print(f"INFO: profile dir = {profile_dir}", file=sys.stderr)
    print("INFO: killing any existing Brave processes (singleton avoidance)...", file=sys.stderr)
    kill_existing_brave()

    print(f"INFO: launching Brave at {BRAVE_EXE}", file=sys.stderr)
    print("INFO: log in to Facebook in the window that opens.", file=sys.stderr)
    print("INFO: when the homepage looks right, close the window normally (X button).", file=sys.stderr)

    cmd = [
        str(BRAVE_EXE),
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
        LOGIN_URL,
    ]

    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f"WARN: Brave exited with code {result.returncode}", file=sys.stderr)

    print(f"INFO: Brave closed. Profile saved at {profile_dir}", file=sys.stderr)

    # Sanity: Brave 121+ writes cookies under Default/Network/Cookies.
    for candidate in (
        profile_dir / "Default" / "Network" / "Cookies",
        profile_dir / "Default" / "Cookies",
    ):
        if candidate.exists():
            print(f"INFO: Cookies file: {candidate} ({candidate.stat().st_size} bytes)", file=sys.stderr)
            break
    else:
        print(f"WARN: no Cookies file under {profile_dir} — login may not have completed.", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
