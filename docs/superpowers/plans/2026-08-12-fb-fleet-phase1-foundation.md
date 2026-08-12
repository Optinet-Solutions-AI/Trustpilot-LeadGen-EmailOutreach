# FB Fleet — Phase 1: Fleet Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Windows EC2 box reliably host AdsPower and, on demand, open any FB account's secured profile and return its CDP address — the keystone the rest of the hosted fleet plugs into.

**Architecture:** Reuse the existing AdsPower Local API client (`tools/scraper/shared/adspower.py`) and profiles. Add three small Python units — a health check, a watchdog, and a session opener — plus one Windows setup script that keeps the AdsPower desktop client alive (auto-logon to the console session + a scheduled watchdog). No browser driving and no CDP relay yet (those are Phase 2); no queue wiring yet (Phase 3). The session opener is the seam Phase 3 will call.

**Tech Stack:** Python 3 (repo `.venv`), `requests`, pytest, Windows Task Scheduler + PowerShell, Sysinternals Autologon, AdsPower desktop client (paid Local API).

## Global Constraints

- **Fleet host is Windows only.** AdsPower is a desktop GUI app; its Local API is loopback-bound at `http://local.adspower.com:50325` (`.com`, not `.net` — verified live). It cannot run on Cloud Run/Linux.
- **AdsPower Local API is paid-only and rate-limited to 1 request/second.** Throttling is already handled inside `adspower._throttle`; never bypass `adspower._call`.
- **Reuse, do not reimplement, the AdsPower client.** `adspower.start_profile(profile_id)` and `adspower.stop_profile(profile_id)` already exist and return `{'debugger_address', 'webdriver_path'}`. The provisioner `tools/scraper/provision_adspower_profile.py` already creates country-pinned profiles.
- **Fail closed on account safety.** Never return a half-open session; if the API is down or the account has no bound profile, raise.
- **Tests live in `tests/scraper/`** and run with `.venv/Scripts/python.exe -m pytest`. The repo root is already on the pytest path (existing tests import `from tools.scraper...` directly — no `sys.path` hacks).
- **The box uses the repo `.venv`**; all `python` invocations on the box are `<repo>\.venv\Scripts\python.exe`.

---

### Task 1: AdsPower health check

**Files:**
- Modify: `tools/scraper/shared/adspower.py` (add `health_check`)
- Test: `tests/scraper/test_adspower_health.py`

**Interfaces:**
- Consumes: `adspower._call(path, params)` and `adspower.AdsPowerError` (existing).
- Produces: `adspower.health_check() -> bool` — True iff the Local API answers code 0 on `/status`.

- [ ] **Step 1: Write the failing test**

```python
# tests/scraper/test_adspower_health.py
from tools.scraper.shared import adspower


def test_health_check_true_when_status_ok(monkeypatch):
    monkeypatch.setattr(adspower, '_call', lambda path, params: {'ok': True})
    assert adspower.health_check() is True


def test_health_check_false_when_api_unreachable(monkeypatch):
    def boom(path, params):
        raise adspower.AdsPowerError('unreachable')
    monkeypatch.setattr(adspower, '_call', boom)
    assert adspower.health_check() is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower_health.py -v`
Expected: FAIL with `AttributeError: module 'tools.scraper.shared.adspower' has no attribute 'health_check'`

- [ ] **Step 3: Write minimal implementation**

Add to `tools/scraper/shared/adspower.py` (after `stop_profile`):

```python
def health_check() -> bool:
    """True if the AdsPower Local API is up (answers code 0 on /status).

    The fleet watchdog uses this to decide whether to relaunch the desktop
    client. Never raises — an unreachable or erroring API reads as False."""
    try:
        _call('/status', {})
        return True
    except AdsPowerError:
        return False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower_health.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/shared/adspower.py tests/scraper/test_adspower_health.py
git commit -m "feat(scraper): add AdsPower Local API health check for the fleet watchdog"
```

---

### Task 2: Fleet watchdog

**Files:**
- Create: `tools/scraper/fleet_watchdog.py`
- Test: `tests/scraper/test_fleet_watchdog.py`

**Interfaces:**
- Consumes: `adspower.health_check()` (Task 1).
- Produces: `fleet_watchdog.check_and_recover(launch_command: list[str], *, wait_seconds: float = 90.0, poll_interval: float = 5.0) -> str` returning `'ok'` / `'recovered'` / `'failed'`; and a `main()` CLI entry point.

- [ ] **Step 1: Write the failing test**

```python
# tests/scraper/test_fleet_watchdog.py
from tools.scraper import fleet_watchdog as fw


def test_returns_ok_when_api_healthy(monkeypatch):
    launched = []
    monkeypatch.setattr(fw.adspower, 'health_check', lambda: True)
    monkeypatch.setattr(fw.subprocess, 'Popen', lambda *a, **k: launched.append(a))
    assert fw.check_and_recover(['AdsPower.exe']) == 'ok'
    assert launched == []  # healthy → never relaunches


def test_recovers_when_api_down_then_up(monkeypatch):
    states = iter([False, True])  # down initially, up after relaunch
    monkeypatch.setattr(fw.adspower, 'health_check', lambda: next(states))
    monkeypatch.setattr(fw.subprocess, 'Popen', lambda *a, **k: None)
    monkeypatch.setattr(fw.time, 'sleep', lambda s: None)
    assert fw.check_and_recover(['AdsPower.exe'], wait_seconds=10, poll_interval=1) == 'recovered'


def test_failed_when_api_stays_down(monkeypatch):
    monkeypatch.setattr(fw.adspower, 'health_check', lambda: False)
    monkeypatch.setattr(fw.subprocess, 'Popen', lambda *a, **k: None)
    monkeypatch.setattr(fw.time, 'sleep', lambda s: None)
    assert fw.check_and_recover(['AdsPower.exe'], wait_seconds=3, poll_interval=1) == 'failed'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fleet_watchdog.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.scraper.fleet_watchdog'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/scraper/fleet_watchdog.py
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


def check_and_recover(launch_command, *, wait_seconds: float = 90.0, poll_interval: float = 5.0) -> str:
    """Return 'ok' if the Local API is already up. Otherwise launch AdsPower via
    launch_command and poll up to wait_seconds; return 'recovered' or 'failed'."""
    if adspower.health_check():
        return 'ok'
    subprocess.Popen(launch_command, close_fds=True)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fleet_watchdog.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/fleet_watchdog.py tests/scraper/test_fleet_watchdog.py
git commit -m "feat(scraper): fleet watchdog that relaunches AdsPower when its API is down"
```

---

### Task 3: Fleet session opener

**Files:**
- Create: `tools/scraper/fleet_session.py`
- Test: `tests/scraper/test_fleet_session.py`

**Interfaces:**
- Consumes: `adspower.health_check()` (Task 1), `adspower.start_profile(profile_id)` and `adspower.AdsPowerError` (existing), `tools.db.supabase_client.table` (existing).
- Produces: `fleet_session.open_account_session(*, account_id=None, profile_id=None) -> dict` returning `{profile_id, account_id, country, cdp_address, webdriver_path}`; a `FleetSessionError` exception; and a `main()` CLI.

- [ ] **Step 1: Write the failing test**

```python
# tests/scraper/test_fleet_session.py
from types import SimpleNamespace
import pytest
from tools.scraper import fleet_session as fs


class _Query:
    """Minimal chainable stand-in for the supabase query builder."""
    def __init__(self, rows):
        self._rows = rows
    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def execute(self): return SimpleNamespace(data=self._rows)


def test_open_by_profile_id_returns_cdp(monkeypatch):
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: True)
    monkeypatch.setattr(fs.adspower, 'start_profile',
                        lambda pid: {'debugger_address': '127.0.0.1:9222', 'webdriver_path': 'C:/cd.exe'})
    out = fs.open_account_session(profile_id='k1flq0bx')
    assert out['cdp_address'] == '127.0.0.1:9222'
    assert out['profile_id'] == 'k1flq0bx'
    assert out['webdriver_path'] == 'C:/cd.exe'


def test_raises_when_api_down(monkeypatch):
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: False)
    with pytest.raises(fs.FleetSessionError):
        fs.open_account_session(profile_id='k1flq0bx')


def test_resolves_profile_from_account(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': 'p1', 'status': 'active', 'country': 'GB'}]))
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: True)
    monkeypatch.setattr(fs.adspower, 'start_profile',
                        lambda pid: {'debugger_address': '127.0.0.1:9333', 'webdriver_path': ''})
    out = fs.open_account_session(account_id='acc-1')
    assert out['profile_id'] == 'p1'
    assert out['cdp_address'] == '127.0.0.1:9333'
    assert out['country'] == 'GB'


def test_raises_when_account_has_no_profile(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': None, 'status': 'active', 'country': 'GB'}]))
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: True)
    with pytest.raises(fs.FleetSessionError):
        fs.open_account_session(account_id='acc-1')


def test_raises_when_account_not_active(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': 'p1', 'status': 'checkpoint', 'country': 'GB'}]))
    with pytest.raises(fs.FleetSessionError):
        fs.open_account_session(account_id='acc-1')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fleet_session.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tools.scraper.fleet_session'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/scraper/fleet_session.py
"""Fleet session — open a secured AdsPower profile for one FB account and return
its CDP address.

This is the seam the queue-driven fleet worker (Phase 3) will call. In Phase 1
it is exercised directly via the CLI to prove the box can open any account's
profile on demand. It does NOT drive the browser or relay CDP (Phase 2) — it
launches the profile and returns where to attach.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Optional

from tools.db.supabase_client import table
from tools.scraper.shared import adspower


class FleetSessionError(RuntimeError):
    """Could not open a fleet session for the requested account/profile."""


def _resolve_profile_id(account_id: str) -> tuple[str, Optional[str]]:
    rows = (table('social_accounts')
            .select('adspower_profile_id,status,country')
            .eq('id', account_id).limit(1).execute().data)
    if not rows:
        raise FleetSessionError(f'No social_accounts row for id={account_id!r}')
    row = rows[0]
    if row.get('status') != 'active':
        raise FleetSessionError(f'Account {account_id} is not active (status={row.get("status")!r})')
    profile_id = (row.get('adspower_profile_id') or '').strip()
    if not profile_id:
        raise FleetSessionError(f'Account {account_id} has no adspower_profile_id bound')
    return profile_id, row.get('country')


def open_account_session(*, account_id: Optional[str] = None, profile_id: Optional[str] = None) -> dict:
    """Open the AdsPower profile for an account (or a raw profile id) and return
    {profile_id, account_id, country, cdp_address, webdriver_path}.

    Fails closed (FleetSessionError) if the Local API is down or the account has
    no bound active profile — never returns a half-open session."""
    if not account_id and not profile_id:
        raise FleetSessionError('Pass account_id or profile_id')
    country = None
    if account_id and not profile_id:
        profile_id, country = _resolve_profile_id(account_id)
    if not adspower.health_check():
        raise FleetSessionError('AdsPower Local API is not responding on this host')
    try:
        attach = adspower.start_profile(profile_id)
    except adspower.AdsPowerError as exc:
        raise FleetSessionError(f'AdsPower failed to start profile {profile_id}: {exc}') from exc
    return {
        'profile_id': profile_id,
        'account_id': account_id,
        'country': country,
        'cdp_address': attach['debugger_address'],
        'webdriver_path': attach.get('webdriver_path') or '',
    }


def main() -> int:
    ap = argparse.ArgumentParser(description='Open a secured AdsPower profile and print its CDP address.')
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument('--account', help='social_accounts.id to open')
    grp.add_argument('--profile', help='raw AdsPower profile id to open')
    args = ap.parse_args()
    try:
        out = open_account_session(account_id=args.account, profile_id=args.profile)
    except FleetSessionError as exc:
        print(f'FLEET SESSION FAILED: {exc}', file=sys.stderr, flush=True)
        return 1
    print(json.dumps(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fleet_session.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/fleet_session.py tests/scraper/test_fleet_session.py
git commit -m "feat(scraper): fleet session opener — account/profile to CDP address"
```

---

### Task 4: Windows persistent-desktop rig

This task is infrastructure, not unit-testable code. Its "tests" are the explicit manual verification steps in Step 3, run on the actual Windows EC2 box. Build the script from the parts already proven by Tasks 1–3.

**Files:**
- Create: `scripts/ec2-windows-adspower-fleet-setup.ps1`

**Interfaces:**
- Consumes: `tools.scraper.fleet_watchdog` (Task 2, run every 5 min), `tools.scraper.fleet_session` (Task 3, used in verification).
- Produces: a box that (a) auto-logs into the console session on boot, (b) launches AdsPower at logon, (c) runs the watchdog every 5 minutes, and (d) survives RDP disconnects (AdsPower lives in the console session, which RDP disconnect does not tear down).

- [ ] **Step 1: Write the setup script**

```powershell
# scripts/ec2-windows-adspower-fleet-setup.ps1
# Idempotent. Run as Administrator on the Windows EC2 fleet host.
#   powershell -ExecutionPolicy Bypass -File scripts\ec2-windows-adspower-fleet-setup.ps1 `
#       -User Administrator -Password '<console-password>' -RepoDir 'C:\opt\scraper'
#
# What it does:
#   1. Auto-logon to the CONSOLE session (session 1) so AdsPower's GUI + Local
#      API run without an attached RDP session. Console session survives RDP
#      disconnects, so the fleet stays up when nobody is connected.
#   2. Launch AdsPower at logon (scheduled task, ONLOGON).
#   3. Run the fleet watchdog every 5 minutes (scheduled task) to relaunch
#      AdsPower if its Local API stops answering.
param(
    [Parameter(Mandatory=$true)][string]$User,
    [Parameter(Mandatory=$true)][string]$Password,
    [string]$RepoDir = 'C:\opt\scraper',
    [string]$AdsPowerExe = 'C:\Program Files\adspower_global\AdsPower Global.exe'
)
$ErrorActionPreference = 'Stop'
$py = Join-Path $RepoDir '.venv\Scripts\python.exe'

# 1. Auto-logon via Sysinternals Autologon (stores the password as an LSA
#    secret, not plaintext registry). Download if absent.
$autologon = Join-Path $env:TEMP 'Autologon64.exe'
if (-not (Test-Path $autologon)) {
    Invoke-WebRequest 'https://live.sysinternals.com/Autologon64.exe' -OutFile $autologon
}
& $autologon /accepteula $User $env:COMPUTERNAME $Password
Write-Output 'Auto-logon configured.'

# 2. Launch AdsPower at logon.
$adsAction  = New-ScheduledTaskAction -Execute $AdsPowerExe
$adsTrigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'AdsPower-Launch' -Action $adsAction -Trigger $adsTrigger `
    -RunLevel Highest -User $User -Force | Out-Null
Write-Output 'AdsPower launch-at-logon task registered.'

# 3. Watchdog every 5 minutes.
$wdAction  = New-ScheduledTaskAction -Execute $py `
    -Argument "-m tools.scraper.fleet_watchdog --exe `"$AdsPowerExe`"" -WorkingDirectory $RepoDir
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName 'AdsPower-Watchdog' -Action $wdAction -Trigger $wdTrigger `
    -RunLevel Highest -User $User -Force | Out-Null
Write-Output 'Watchdog task registered (every 5 min).'

Write-Output ''
Write-Output 'Setup complete. REBOOT the box to apply auto-logon, then run the'
Write-Output 'verification steps in the plan (Task 4, Step 3).'
```

- [ ] **Step 2: Run the setup script on the box**

Run (as Administrator on the Windows EC2 host):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\ec2-windows-adspower-fleet-setup.ps1 `
    -User Administrator -Password '<console-password>' -RepoDir 'C:\opt\scraper'
```
Expected: prints "Auto-logon configured.", both "task registered" lines, and "Setup complete." with no errors. Then **reboot the box.**

- [ ] **Step 3: Verify the rig (manual acceptance tests)**

After reboot, confirm each of these on the box — this is the acceptance gate for Phase 1:

1. **Auto-logon + AdsPower up:** within ~2 min of boot (no RDP connected),
   ```
   C:\opt\scraper\.venv\Scripts\python.exe -m tools.scraper.adspower_probe
   ```
   Expected: `== 1. Service status ==` shows `HTTP 200` with a code-0 payload, and the profile list prints your accounts. (Proves AdsPower launched in the console session and the Local API answers.)

2. **Watchdog recovers a crash:** kill AdsPower, then wait ≤5 min:
   ```
   Stop-Process -Name 'AdsPower Global' -Force
   # wait for the next 5-min watchdog tick, then:
   C:\opt\scraper\.venv\Scripts\python.exe -m tools.scraper.adspower_probe
   ```
   Expected: the status check is healthy again (the watchdog relaunched AdsPower). Confirm the task ran: `Get-ScheduledTask AdsPower-Watchdog | Get-ScheduledTaskInfo` shows a recent `LastRunTime` and `LastTaskResult` 0.

3. **Session opens end-to-end** (use a THROWAWAY profile, not a logged-in FB account):
   ```
   C:\opt\scraper\.venv\Scripts\python.exe -m tools.scraper.fleet_session --profile <THROWAWAY_PROFILE_ID>
   ```
   Expected: a single JSON line with a non-empty `"cdp_address"`. (Proves the box opens a secured profile on demand and returns where to attach — the Phase 1 keystone deliverable.)

4. **Survives RDP disconnect:** disconnect the RDP session (do not log off), reconnect after a minute, re-run step 1's probe. Expected: still healthy (AdsPower never left the console session).

- [ ] **Step 4: Commit**

```bash
git add scripts/ec2-windows-adspower-fleet-setup.ps1
git commit -m "feat(scraper): Windows persistent-desktop rig for the AdsPower fleet host"
```

---

## Self-Review

**Spec coverage (Phase 1 scope):**
- Persistent-desktop rig (auto-logon, AdsPower auto-start, keep-alive, watchdog) → Task 4 (rig) + Task 2 (watchdog logic).
- Fleet opens a profile → CDP address via the loopback Local API → Task 3, reusing `start_profile`.
- Reuse existing provisioner + uc_driver AdsPower branch → Tasks reuse `adspower.py`; no reimplementation.
- Explicitly excluded (per scope): CDP relay (Phase 2), `/join` and worker enqueue conversion (Phase 3). Not in any task. ✓

**Placeholder scan:** No TBD/TODO; every code and test step is complete. Task 4's non-pytest verification is deliberate (infrastructure) and each check has an exact command + expected result. ✓

**Type consistency:** `health_check() -> bool` (Task 1) is consumed by Tasks 2 and 3 by that exact name. `start_profile` returns `{'debugger_address','webdriver_path'}` (existing) and Task 3 reads both keys. `open_account_session(*, account_id, profile_id) -> dict` and `FleetSessionError` (Task 3) are the names Phase 3 will consume. `check_and_recover(launch_command, *, wait_seconds, poll_interval)` (Task 2) matches its CLI and tests. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-12-fb-fleet-phase1-foundation.md`.
