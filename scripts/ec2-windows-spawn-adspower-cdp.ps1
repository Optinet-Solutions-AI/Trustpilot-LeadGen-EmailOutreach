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
#   -AccountId   the social_accounts.id (fleet_session resolves its adspower_profile_id).
#                Requires the account row's status='active' (fleet_session's
#                _resolve_profile_id gate) — use -ProfileId instead for a row
#                that isn't active yet (e.g. mid-onboarding, pre-activation).
#   -ProfileId   a raw AdsPower profile id, bypassing the account lookup/active
#                check entirely. Added for the onboarding wizard: a freshly
#                created profile belongs to a social_accounts row that is
#                still 'disabled' until the VA finishes login and the
#                onboard-complete route activates it, so -AccountId can't be
#                used yet. Exactly one of -AccountId / -ProfileId is required.
#   -RepoDir     repo root (for the .venv python + the bridge js). Defaults to
#                self-located from this script's own path (<repo>\scripts\... -> <repo>),
#                mirroring ec2-windows-spawn-cdp.ps1's Find-RepoRoot.
#   -TargetUrl   deep-link the Node bridge navigates the CDP page to once the
#                AdsPower profile's CDP port is up (AdsPower's browser/start
#                opens a blank tab with no startup-URL option, unlike a plain
#                browser.exe invocation, so the bridge does the Page.navigate)
param(
    [string]$AccountId,
    [string]$ProfileId,
    [string]$RepoDir = $null,
    [string]$TargetUrl = 'https://www.facebook.com/'
)
if (-not $AccountId -and -not $ProfileId) {
    Write-Host "FATAL: pass -AccountId or -ProfileId"
    exit 2
}
$FsIdArgs = if ($ProfileId) { @('--profile', $ProfileId) } else { @('--account', $AccountId) }
if (-not $RepoDir) { $RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
# `python -m tools.scraper.fleet_session` resolves the `tools` package from the
# current directory, so we MUST run from the repo root — otherwise Python throws
# ModuleNotFoundError: No module named 'tools'. All absolute paths below ($py,
# $BRIDGE_SCRIPT, $CLOUDFLARED) are unaffected by the cwd change.
Set-Location $RepoDir
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

Write-Host "AdsPower CDP spawn: account=$AccountId profile=$ProfileId targetUrl=$TargetUrl"

# Kill leftovers on the bridge port from any previous unclean exit.
$pids = Get-NetTCPConnection -LocalPort $BRIDGE_PORT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 1. Open the AdsPower profile and get its CDP port (this launches the browser).
$CDP_PORT = (& $py -m tools.scraper.fleet_session @FsIdArgs --print-port 2>&1 | Select-Object -Last 1 | Out-String).Trim()
if (-not ($CDP_PORT -match '^\d+$')) {
    Write-Host "FATAL: fleet_session did not return a numeric CDP port (got: '$CDP_PORT')"
    & $py -m tools.scraper.fleet_session @FsIdArgs --stop 2>&1 | Out-Null
    exit 3
}
Write-Host "AdsPower profile open; CDP port=$CDP_PORT"

# 2. Start the Node CDP bridge against the AdsPower CDP port. Pass -TargetUrl
#    through as --target-url so the bridge navigates the blank AdsPower tab
#    to it once the CDP websocket opens (see the param block comment above).
$bridgeArgs = @("$BRIDGE_SCRIPT", "--cdp-port", "$CDP_PORT", "--serve-port", "$BRIDGE_PORT", "--target-url", "$TargetUrl")
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
    & $py -m tools.scraper.fleet_session @FsIdArgs --stop 2>&1 | Out-Null
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
    & $py -m tools.scraper.fleet_session @FsIdArgs --stop 2>&1 | Out-Null
    Remove-Item $tunnelLogOut, $tunnelLogErr -ErrorAction SilentlyContinue
    Write-Host "AdsPower CDP session cleanup complete for account=$AccountId profile=$ProfileId"
}
