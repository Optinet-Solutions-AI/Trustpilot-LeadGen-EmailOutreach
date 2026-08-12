# FB Fleet — Phase 2: Point the CDP Stream at AdsPower Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a VA remote-control a fleet-hosted **AdsPower** profile from the web app by reusing the existing CDP-screencast bridge + cloudflared tunnel — swapping only the browser-spawn step from native Brave to the AdsPower profile opened by Phase 1's `fleet_session`.

**Architecture:** The CDP relay already exists and works: `browse-stream-bridge.ts` streams a CDP screencast to a canvas and forwards VA input, `ec2-windows-spawn-cdp.ps1` wires it to a cloudflared quick tunnel, `social-connect-worker.ts` captures the tunnel URL into `social_accounts.connect_tunnel_url`, and `useBrowseSession.ts` opens it for the VA. Phase 2 adds a **sibling spawner** that opens the AdsPower profile (via `fleet_session --print-port`) and points the *same* bridge + tunnel at its CDP port, plus a one-line worker branch to select it for fleet accounts. Nothing about the bridge, tunnel, frontend, or status polling changes.

**Tech Stack:** Python 3 (repo `.venv`), pytest; Node/TypeScript (Express worker) + vitest; Windows PowerShell + cloudflared; AdsPower desktop client (Phase 1).

## Global Constraints

- **Reuse, do not rebuild, the stream.** `browse-stream-bridge.ts`, the cloudflared tunnel, `useBrowseSession.ts`, and the `connect_tunnel_url` status flow are unchanged. Phase 2 only changes *which browser* the bridge points at.
- **Transport is the existing cloudflared quick tunnel** (decision A, 2026-08-12) — NOT an outbound WS relay. See the architecture spec's corrected CDP-relay section.
- **The AdsPower spawner mirrors `scripts/ec2-windows-spawn-cdp.ps1`'s contract exactly:** emit exactly ONE `https://<sub>.trycloudflare.com…` viewer URL on stdout (the worker greps for it), block until the session ends, and kill every child + stop the AdsPower profile on exit.
- **Python tests live in `tests/scraper/`** (repo `.venv` pytest, no `sys.path` hacks). **TS tests are vitest** alongside the module (e.g. `social-routing.test.ts`), run with `npx vitest run` in `server/`.
- **Reuse Phase 1:** `fleet_session.open_account_session` and `adspower.start_profile`/`stop_profile` already exist on `main`. Do not reimplement them.
- **On-box acceptance:** the end-to-end stream can only be verified on the provisioned Windows fleet host with AdsPower running (same as Phase 1's rig). Task 2's acceptance is manual, on-box.

---

### Task 1: fleet_session — CDP-port extraction + profile stop + CLI modes

**Files:**
- Modify: `tools/scraper/fleet_session.py`
- Test: `tests/scraper/test_fleet_session.py`

**Interfaces:**
- Consumes: `adspower.stop_profile(profile_id)` (existing), `_resolve_profile_id` + `FleetSessionError` + `open_account_session` (Phase 1, same file).
- Produces: `port_from_cdp_address(cdp_address: str) -> int`; `close_account_session(*, account_id=None, profile_id=None) -> None`; CLI flags `--print-port` (open, then print ONLY the CDP port) and `--stop` (stop the profile). The AdsPower spawner (Task 2) calls `--print-port` and `--stop`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scraper/test_fleet_session.py`:

```python
def test_port_from_cdp_address_parses_port():
    assert fs.port_from_cdp_address('127.0.0.1:9222') == 9222
    assert fs.port_from_cdp_address('localhost:50325') == 50325


def test_port_from_cdp_address_rejects_malformed():
    with pytest.raises(fs.FleetSessionError):
        fs.port_from_cdp_address('no-colon-here')
    with pytest.raises(fs.FleetSessionError):
        fs.port_from_cdp_address('127.0.0.1:notaport')


def test_close_account_session_by_profile_stops_it(monkeypatch):
    stopped = []
    monkeypatch.setattr(fs.adspower, 'stop_profile', lambda pid: stopped.append(pid))
    fs.close_account_session(profile_id='k1flq0bx')
    assert stopped == ['k1flq0bx']


def test_close_account_session_resolves_account(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': 'p1', 'status': 'active', 'country': 'GB'}]))
    stopped = []
    monkeypatch.setattr(fs.adspower, 'stop_profile', lambda pid: stopped.append(pid))
    fs.close_account_session(account_id='acc-1')
    assert stopped == ['p1']


def test_close_account_session_rejects_both_and_neither(monkeypatch):
    with pytest.raises(fs.FleetSessionError):
        fs.close_account_session()
    with pytest.raises(fs.FleetSessionError):
        fs.close_account_session(account_id='a', profile_id='p')
```

(`_Query` and `fs` are already imported/defined at the top of this test file from Phase 1.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fleet_session.py -v`
Expected: FAIL with `AttributeError: module 'tools.scraper.fleet_session' has no attribute 'port_from_cdp_address'` (and `close_account_session`).

- [ ] **Step 3: Write the implementation**

In `tools/scraper/fleet_session.py`, add these two functions after `open_account_session`:

```python
def port_from_cdp_address(cdp_address: str) -> int:
    """Extract the integer TCP port from a CDP debugger address, e.g.
    '127.0.0.1:9222' -> 9222. Raises FleetSessionError on a malformed value."""
    addr = (cdp_address or '').strip()
    if ':' not in addr:
        raise FleetSessionError(f'CDP address {cdp_address!r} has no :port')
    port_str = addr.rsplit(':', 1)[1]
    try:
        return int(port_str)
    except ValueError as exc:
        raise FleetSessionError(f'CDP address {cdp_address!r} has a non-integer port') from exc


def close_account_session(*, account_id: Optional[str] = None, profile_id: Optional[str] = None) -> None:
    """Stop the AdsPower profile for an account (or a raw profile id). Resolves
    the profile from social_accounts when given an account_id. Stopping an
    already-stopped profile is not an error (adspower.stop_profile handles it)."""
    if not account_id and not profile_id:
        raise FleetSessionError('Pass account_id or profile_id')
    if account_id and profile_id:
        raise FleetSessionError('Pass account_id OR profile_id, not both')
    if account_id:
        profile_id, _country = _resolve_profile_id(account_id)
    adspower.stop_profile(profile_id)
```

Then replace the `main()` body so it supports `--print-port` and `--stop`:

```python
def main() -> int:
    ap = argparse.ArgumentParser(description='Open/stop a secured AdsPower profile for the fleet.')
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument('--account', help='social_accounts.id')
    grp.add_argument('--profile', help='raw AdsPower profile id')
    ap.add_argument('--print-port', action='store_true',
                    help='Open the session and print ONLY the CDP port (for the spawner).')
    ap.add_argument('--stop', action='store_true',
                    help='Stop the profile instead of opening it.')
    args = ap.parse_args()
    try:
        if args.stop:
            close_account_session(account_id=args.account, profile_id=args.profile)
            return 0
        out = open_account_session(account_id=args.account, profile_id=args.profile)
    except FleetSessionError as exc:
        print(f'FLEET SESSION FAILED: {exc}', file=sys.stderr, flush=True)
        return 1
    if args.print_port:
        print(port_from_cdp_address(out['cdp_address']))
    else:
        print(json.dumps(out))
    return 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fleet_session.py -v`
Expected: PASS (the 5 Phase-1 tests + 5 new = 10 passed).

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/fleet_session.py tests/scraper/test_fleet_session.py
git commit -m "feat(scraper): fleet_session CDP-port extraction, profile stop, and --print-port/--stop CLI"
```

---

### Task 2: AdsPower CDP spawner (Windows, on-box acceptance)

Infrastructure PowerShell, mirroring `scripts/ec2-windows-spawn-cdp.ps1`. Not unit-testable; its acceptance is the on-box manual steps in Step 3, run on the provisioned Windows fleet host with AdsPower running.

**Files:**
- Create: `scripts/ec2-windows-spawn-adspower-cdp.ps1`

**Interfaces:**
- Consumes: `fleet_session --account <id> --print-port` and `fleet_session --account <id> --stop` (Task 1); `server/dist/worker/browse-stream-bridge.js` (existing, unchanged); `cloudflared`.
- Produces: the same stdout contract as `ec2-windows-spawn-cdp.ps1` — one `…trycloudflare.com/viewer.html?autoconnect=true` line — so `social-connect-worker.ts` captures it unchanged.

- [ ] **Step 1: Write the spawner**

```powershell
# scripts/ec2-windows-spawn-adspower-cdp.ps1
# CDP browser-only stream for a FLEET (AdsPower) browse session.
# Mirrors ec2-windows-spawn-cdp.ps1 but opens the AdsPower profile via Phase 1's
# fleet_session (fingerprint-isolated) instead of launching native Brave.
#
# Spawned by social-connect-worker.ts for accounts that have an
# adspower_profile_id. Contract (identical to ec2-windows-spawn-cdp.ps1):
#   - Emits ONE stdout line: the public viewer URL (trycloudflare.com/…)
#   - Blocks until the AdsPower browser's CDP port stops answering, or parent kills the tree
#   - On exit: stops the AdsPower profile + kills cloudflared + the Node bridge
#
# Args:
#   -AccountId   the social_accounts.id (fleet_session resolves its adspower_profile_id)
#   -RepoDir     repo root (for the .venv python + the bridge js). Default C:\opt\scraper
#   -TargetUrl   deep-link (logged; the VA navigates in-session for now)
param(
    [Parameter(Mandatory=$true)][string]$AccountId,
    [string]$RepoDir = 'C:\opt\scraper',
    [string]$TargetUrl = 'https://www.facebook.com/'
)
$ErrorActionPreference = 'Continue'
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$BRIDGE_PORT = 6090
$py          = Join-Path $RepoDir '.venv\Scripts\python.exe'
$CLOUDFLARED = 'C:\tools\cloudflared\cloudflared.exe'
$nodeCmd     = Get-Command node -ErrorAction SilentlyContinue
$NODE        = if ($nodeCmd) { $nodeCmd.Source } else { $null }
$BRIDGE_SCRIPT = Join-Path $RepoDir 'server\dist\worker\browse-stream-bridge.js'

if (-not (Test-Path $py))            { Write-Host "FATAL: python venv not found at $py"; exit 2 }
if (-not (Test-Path $CLOUDFLARED))   { Write-Host "FATAL: cloudflared not found at $CLOUDFLARED"; exit 2 }
if (-not $NODE)                      { Write-Host "FATAL: node not found in PATH"; exit 2 }
if (-not (Test-Path $BRIDGE_SCRIPT)) { Write-Host "FATAL: browse-stream-bridge.js not found (run 'cd server && npm run build')"; exit 2 }

Write-Host "AdsPower CDP spawn: account=$AccountId targetUrl=$TargetUrl"

# Kill leftovers on the bridge port from any previous unclean exit.
$pids = Get-NetTCPConnection -LocalPort $BRIDGE_PORT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 1. Open the AdsPower profile and get its CDP port (this launches the browser).
$CDP_PORT = (& $py -m tools.scraper.fleet_session --account $AccountId --print-port 2>&1 | Select-Object -Last 1).Trim()
if (-not ($CDP_PORT -match '^\d+$')) {
    Write-Host "FATAL: fleet_session did not return a numeric CDP port (got: '$CDP_PORT')"
    exit 3
}
Write-Host "AdsPower profile open; CDP port=$CDP_PORT"

# 2. Start the Node CDP bridge against the AdsPower CDP port.
$bridgeArgs = @("$BRIDGE_SCRIPT", "--cdp-port", "$CDP_PORT", "--serve-port", "$BRIDGE_PORT")
$bridgeProc = Start-Process -FilePath $NODE -ArgumentList $bridgeArgs -PassThru -WindowStyle Hidden
Write-Host "CDP bridge launched pid=$($bridgeProc.Id) servePort=$BRIDGE_PORT"

# 3. Cloudflared quick tunnel → :6090 (same 45s tail as the Brave spawner).
$tunnelLogOut = [System.IO.Path]::GetTempFileName()
$tunnelLogErr = [System.IO.Path]::GetTempFileName()
$cfArgs = @("tunnel", "--no-autoupdate", "--url", "http://localhost:$BRIDGE_PORT")
$cfProc = Start-Process -FilePath $CLOUDFLARED -ArgumentList $cfArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelLogOut -RedirectStandardError $tunnelLogErr
$tunnelUrl = $null
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
    Start-Sleep -Milliseconds 500
    foreach ($logFile in @($tunnelLogErr, $tunnelLogOut)) {
        if (Test-Path $logFile) {
            $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
            if ($content -match "https://[a-z0-9-]+\.trycloudflare\.com") { $tunnelUrl = $Matches[0]; break }
        }
    }
}
if (-not $tunnelUrl) {
    Write-Host "FATAL: cloudflared did not print a tunnel URL within 45s"
    if ($cfProc)     { Stop-Process -Id $cfProc.Id     -Force -ErrorAction SilentlyContinue }
    if ($bridgeProc) { Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue }
    & $py -m tools.scraper.fleet_session --account $AccountId --stop 2>&1 | Out-Null
    Remove-Item $tunnelLogOut, $tunnelLogErr -ErrorAction SilentlyContinue
    exit 3
}

# 4. Emit the ONE viewer URL line the worker greps for.
Write-Host "$tunnelUrl/viewer.html?autoconnect=true"

# 5. Block until the AdsPower CDP port stops answering (browser closed), or parent kills us.
try {
    while ($true) {
        Start-Sleep -Seconds 2
        try { Invoke-WebRequest "http://localhost:$CDP_PORT/json/version" -UseBasicParsing -TimeoutSec 3 | Out-Null }
        catch { Write-Host "AdsPower CDP port stopped answering; ending session"; break }
    }
} finally {
    if ($cfProc)     { Stop-Process -Id $cfProc.Id     -Force -ErrorAction SilentlyContinue }
    if ($bridgeProc) { Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue }
    & $py -m tools.scraper.fleet_session --account $AccountId --stop 2>&1 | Out-Null
    Remove-Item $tunnelLogOut, $tunnelLogErr -ErrorAction SilentlyContinue
    Write-Host "AdsPower CDP session cleanup complete for account=$AccountId"
}
```

- [ ] **Step 2: Build the bridge + run the spawner on the box**

On the Windows fleet host (AdsPower running, a warmed profile bound to a test `social_accounts` row):
```powershell
cd C:\opt\scraper\server; npm run build   # produces dist/worker/browse-stream-bridge.js
cd C:\opt\scraper
powershell -ExecutionPolicy Bypass -File scripts\ec2-windows-spawn-adspower-cdp.ps1 -AccountId <TEST_ACCOUNT_ID> -RepoDir C:\opt\scraper
```

- [ ] **Step 3: Verify on-box (manual acceptance)**

1. The script prints exactly one `https://<sub>.trycloudflare.com/viewer.html?autoconnect=true` line, and an AdsPower browser window opens.
2. Open that URL in a browser off the box → you see the live AdsPower browser and can click/type in it (mouse + keyboard reach the page).
3. Close the AdsPower browser → within ~2s the script logs "CDP port stopped answering" and exits, and `Get-Process cloudflared` shows the tunnel gone (cleanup ran + the profile was stopped).

- [ ] **Step 4: Commit**

```bash
git add scripts/ec2-windows-spawn-adspower-cdp.ps1
git commit -m "feat(scraper): AdsPower CDP browse spawner reusing the bridge + cloudflared tunnel"
```

---

### Task 3: Route fleet accounts to the AdsPower spawner

**Files:**
- Modify: `server/src/services/social-routing.ts` (add `chooseBrowseSpawner`)
- Test: `server/src/services/social-routing.test.ts`
- Modify: `server/src/worker/social-connect-worker.ts` (use it)

**Interfaces:**
- Consumes: nothing new (pure decision + a Supabase read the worker already has a client for).
- Produces: `chooseBrowseSpawner(opts: { isBrowse: boolean; browseStream: string; hasAdspowerProfile: boolean }): 'novnc' | 'cdp' | 'adspower-cdp'`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/social-routing.test.ts`:

```typescript
import { chooseBrowseSpawner } from './social-routing.js';

describe('chooseBrowseSpawner', () => {
  test('connect mode always uses novnc', () => {
    expect(chooseBrowseSpawner({ isBrowse: false, browseStream: 'cdp', hasAdspowerProfile: true }))
      .toBe('novnc');
  });
  test('browse + AdsPower profile → adspower-cdp', () => {
    expect(chooseBrowseSpawner({ isBrowse: true, browseStream: 'cdp', hasAdspowerProfile: true }))
      .toBe('adspower-cdp');
  });
  test('browse + no AdsPower + BROWSE_STREAM=cdp → legacy cdp', () => {
    expect(chooseBrowseSpawner({ isBrowse: true, browseStream: 'cdp', hasAdspowerProfile: false }))
      .toBe('cdp');
  });
  test('browse + no AdsPower + default stream → novnc', () => {
    expect(chooseBrowseSpawner({ isBrowse: true, browseStream: 'novnc', hasAdspowerProfile: false }))
      .toBe('novnc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `server/`): `npx vitest run src/services/social-routing.test.ts`
Expected: FAIL — `chooseBrowseSpawner` is not exported.

- [ ] **Step 3: Add the pure helper**

Append to `server/src/services/social-routing.ts`:

```typescript
/** Which browse spawner to use for a session. Connect mode always needs the
 *  full-desktop noVNC path. Browse mode prefers the fleet AdsPower spawner when
 *  the account is fleet-bound (has an adspower_profile_id); otherwise it honours
 *  the legacy BROWSE_STREAM=cdp native-Brave path, falling back to noVNC. */
export function chooseBrowseSpawner(opts: {
  isBrowse: boolean;
  browseStream: string;
  hasAdspowerProfile: boolean;
}): 'novnc' | 'cdp' | 'adspower-cdp' {
  if (!opts.isBrowse) return 'novnc';
  if (opts.hasAdspowerProfile) return 'adspower-cdp';
  if (opts.browseStream === 'cdp') return 'cdp';
  return 'novnc';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (in `server/`): `npx vitest run src/services/social-routing.test.ts`
Expected: PASS (existing social-routing tests + the 4 new).

- [ ] **Step 5: Wire it into the worker**

In `server/src/worker/social-connect-worker.ts`:

(a) Add the import and resolve the new script (next to the existing `SPAWN_SCRIPT_CDP`):
```typescript
import { chooseBrowseSpawner } from '../services/social-routing.js';
// ...
const SPAWN_SCRIPT_ADSPOWER_CDP = resolveScript('ec2-windows-spawn-adspower-cdp.ps1');
```

(b) In `handleRequest`, replace the spawner-selection + arg-building block (the `const useCdp = …` through the end of the `spawnArgs` construction) with:
```typescript
      // Fleet accounts (bound to an AdsPower profile) get the AdsPower CDP
      // spawner; everything else keeps the legacy noVNC / native-Brave-CDP paths.
      let hasAdspowerProfile = false;
      try {
        const { data } = await getSupabase()
          .from('social_accounts').select('adspower_profile_id').eq('id', row.id).single();
        hasAdspowerProfile = !!(data?.adspower_profile_id);
      } catch (err) {
        log(`adspower_profile_id lookup failed for ${row.id}: ${(err as Error).message}`);
      }
      const kind = chooseBrowseSpawner({ isBrowse, browseStream: BROWSE_STREAM, hasAdspowerProfile });
      const spawnerScript =
        kind === 'adspower-cdp' ? SPAWN_SCRIPT_ADSPOWER_CDP
        : kind === 'cdp' ? SPAWN_SCRIPT_CDP
        : SPAWN_SCRIPT_NOVNC;
      log(`spawner=${kind} script=${spawnerScript}`);

      const spawnArgs: string[] = ['-ExecutionPolicy', 'Bypass', '-File', spawnerScript];
      if (kind === 'adspower-cdp') {
        // AdsPower spawner resolves the profile itself; no -ProfileDir.
        spawnArgs.push('-AccountId', row.id);
        if (row.connect_target_url) spawnArgs.push('-TargetUrl', row.connect_target_url);
      } else if (kind === 'cdp') {
        spawnArgs.push('-ProfileDir', profileDir, '-AccountId', row.id);
        if (row.connect_target_url) spawnArgs.push('-TargetUrl', row.connect_target_url);
      } else {
        spawnArgs.push('-ProfileDir', profileDir, '-AccountId', row.id,
                       '-Mode', isBrowse ? 'browse' : 'connect');
        if (isBrowse && row.connect_target_url) spawnArgs.push('-TargetUrl', row.connect_target_url);
      }
```

- [ ] **Step 6: Type-check + run the worker/routing tests**

Run (in `server/`): `npx tsc --noEmit` (expect exit 0), then `npx vitest run src/services/social-routing.test.ts`
Expected: tsc clean; routing tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/social-routing.ts server/src/services/social-routing.test.ts server/src/worker/social-connect-worker.ts
git commit -m "feat(backend): route fleet (AdsPower) accounts to the AdsPower CDP browse spawner"
```

---

## Self-Review

**Spec coverage (Phase 2 = wire AdsPower into the existing CDP stream):**
- Open the AdsPower profile + get its CDP port → Task 1 (`--print-port`, reuses Phase 1 `open_account_session`).
- Point the existing bridge + cloudflared tunnel at that port → Task 2 (spawner reuses `browse-stream-bridge.js` + the identical tunnel/emit/cleanup contract).
- Stop the profile on session end → Task 1 (`close_account_session` / `--stop`) called from Task 2's cleanup.
- Select the AdsPower spawner for fleet accounts → Task 3 (`chooseBrowseSpawner` + worker wiring).
- Reused unchanged (correctly NOT in any task): `browse-stream-bridge.ts`, `useBrowseSession.ts`, `connect_tunnel_url` status flow. ✓
- Excluded by scope: `/join` enqueue (Phase 3), workflow UI (Phase 5), auto-navigation to the target post (deferred — VA navigates in-session; noted in Task 2 args). ✓

**Placeholder scan:** No TBD/TODO; every code + test step is complete. Task 2's on-box acceptance is deliberate (infrastructure), each check has an exact command + expected result. ✓

**Type consistency:** `port_from_cdp_address(str) -> int`, `close_account_session(*, account_id, profile_id)`, and `--print-port`/`--stop` (Task 1) are the exact names Task 2's spawner invokes. `chooseBrowseSpawner({isBrowse, browseStream, hasAdspowerProfile})` returning `'novnc'|'cdp'|'adspower-cdp'` (Task 3) matches its test and the worker's `kind` switch. The spawner's stdout `…trycloudflare.com/viewer.html?autoconnect=true` matches the worker's existing capture regex. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-12-fb-fleet-phase2-cdp-adspower.md`.
