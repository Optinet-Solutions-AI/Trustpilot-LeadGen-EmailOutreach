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
    """Recover the AdsPower Local API. Returns one of:

      'ok'        — already healthy; nothing done.
      'recovered' — was unreachable; relaunched and it came back up.
      'failed'    — was unreachable; relaunch did not bring it back.
      'unhealthy' — reachable but rejecting calls (config problem, e.g.
                    Security Verification without a key). NOT relaunched, because
                    a relaunch cannot fix it and would thrash the client every
                    watchdog tick.
    """
    state = adspower.probe()
    if state == 'up':
        return 'ok'
    if state == 'error':
        # The client is running; the API just refuses us. Relaunching would kill
        # and reopen a working GUI every few minutes without fixing the cause.
        return 'unhealthy'
    # state == 'unreachable' → the client is down; relaunch is the right fix.
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
    if result == 'unhealthy':
        print('watchdog: AdsPower is running but its Local API is rejecting calls — '
              'check Security Verification / ADSPOWER_API_KEY. Not relaunching.',
              file=sys.stderr, flush=True)
    return 0 if result in ('ok', 'recovered') else 1


if __name__ == '__main__':
    sys.exit(main())
