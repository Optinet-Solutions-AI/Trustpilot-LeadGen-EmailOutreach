"""Fleet watchdog — keeps the AdsPower desktop client alive on the EC2 host.

AdsPower is a GUI app, not a Windows service: if it crashes or its Local API
stops answering, the whole fleet goes dark silently. A Task Scheduler job runs
this every few minutes; it pings the Local API and relaunches the client if it
is down. The relaunch loop polls a fixed number of times (wait/poll) rather
than reading the wall clock, so tests stay deterministic with sleep mocked.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time

from tools.scraper.shared import adspower

# AdsPower's installed executable on Windows (client 8.7.x). Override with
# ADSPOWER_EXE if a future build changes the path.
DEFAULT_ADSPOWER_EXE = r'C:\Program Files\adspower_global\AdsPower Global.exe'


def check_and_recover(launch_command: list[str], *, wait_seconds: float = 90.0, poll_interval: float = 5.0) -> str:
    """Return 'ok' if the Local API is already up. Otherwise launch AdsPower via
    launch_command and poll up to wait_seconds; return 'recovered' or 'failed'."""
    if adspower.health_check():
        return 'ok'
    try:
        subprocess.Popen(launch_command, close_fds=True)
    except OSError:
        return 'failed'
    attempts = max(1, int(wait_seconds / poll_interval))
    for _ in range(attempts):
        time.sleep(poll_interval)
        if adspower.health_check():
            return 'recovered'
    return 'failed'


def main() -> int:
    ap = argparse.ArgumentParser(description='Relaunch AdsPower if its Local API is down.')
    ap.add_argument('--exe', default=os.environ.get('ADSPOWER_EXE', DEFAULT_ADSPOWER_EXE),
                    help='Path to the AdsPower desktop executable.')
    ap.add_argument('--wait', type=float, default=90.0, help='Seconds to wait for the API after a relaunch.')
    args = ap.parse_args()
    result = check_and_recover([args.exe], wait_seconds=args.wait)
    print(f'watchdog: {result}', file=sys.stderr, flush=True)
    return 0 if result in ('ok', 'recovered') else 1


if __name__ == '__main__':
    sys.exit(main())
