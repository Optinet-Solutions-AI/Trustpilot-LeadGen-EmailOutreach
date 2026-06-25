# ec2-windows-spawn-cdp.ps1
# CDP-based browser-only stream for browse mode.
# Replaces the full-desktop noVNC stack (TightVNC + websockify) with a
# lightweight CDP screencast + Node bridge that streams just the browser.
#
# Spawned by social-connect-worker.ts when BROWSE_STREAM=cdp.
# CONTRACT mirrors ec2-windows-spawn-noVNC.ps1 exactly:
#   - Same param shape (-ProfileDir, -AccountId, -TargetUrl)
#   - Emits ONE stdout line: the public viewer URL (trycloudflare.com/…)
#   - Blocks until Brave exits or parent kills the tree
#   - On exit, kills Brave + cloudflared + Node bridge
#
# Process lifecycle: when the parent (Node) kills this script tree via
# taskkill /T /F, all spawned children die with it.
# We also kill leftovers from previous unclean exits at the top of every run.
#
# Args:
#   -ProfileDir  C:\fb-profiles\<account_id>
#   -AccountId   the social_accounts.id (for log tagging)
#   -TargetUrl   deep-link URL to open in Brave (required for browse mode)

param(
    [Parameter(Mandatory=$true)][string]$ProfileDir,
    [Parameter(Mandatory=$true)][string]$AccountId,
    [string]$TargetUrl = 'https://www.facebook.com/'
)

$ErrorActionPreference = "Continue"

# Refresh PATH from the registry so node / cloudflared resolve even when the
# spawning service handed us a stale PATH.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# CDP and bridge ports — must not conflict with noVNC's :6080.
$CDP_PORT    = 9222
$BRIDGE_PORT = 6090

# ---------------------------------------------------------------------------
# Find Brave — mirror the exact probe order in the noVNC spawner.
# ---------------------------------------------------------------------------
function Find-Brave {
    $candidates = @(
        "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe",
        "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        "C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Find the repo root and Node binary.
# ---------------------------------------------------------------------------
function Find-RepoRoot {
    # The script lives in <repo>\scripts\; probe up from there.
    $scriptDir = Split-Path -Parent $MyInvocation.ScriptName
    $candidate = Split-Path -Parent $scriptDir
    if (Test-Path (Join-Path $candidate "server\dist\worker\browse-stream-bridge.js")) {
        return $candidate
    }
    # Fallback: the Node process may have set a working dir hint via env.
    if ($env:REPO_ROOT -and (Test-Path $env:REPO_ROOT)) { return $env:REPO_ROOT }
    # Last resort: use C:\app (typical EC2 deploy root).
    return "C:\app"
}

$BRAVE        = Find-Brave
$CLOUDFLARED  = "C:\tools\cloudflared\cloudflared.exe"
$nodeCmd      = Get-Command node -ErrorAction SilentlyContinue
$NODE         = if ($nodeCmd) { $nodeCmd.Source } else { $null }
$REPO_ROOT    = Find-RepoRoot
$BRIDGE_SCRIPT = Join-Path $REPO_ROOT "server\dist\worker\browse-stream-bridge.js"

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if (-not $BRAVE) {
    Write-Host "FATAL: Brave not found in any known location."
    exit 2
}
if (-not (Test-Path $CLOUDFLARED)) {
    Write-Host "FATAL: cloudflared not found at $CLOUDFLARED"
    exit 2
}
if (-not $NODE) {
    Write-Host "FATAL: node not found in PATH"
    exit 2
}
if (-not (Test-Path $BRIDGE_SCRIPT)) {
    Write-Host "FATAL: browse-stream-bridge.js not found at $BRIDGE_SCRIPT"
    Write-Host "Run 'cd server && npm run build' in the repo root first."
    exit 2
}

Write-Host "CDP spawn start: account=$AccountId profileDir=$ProfileDir"
Write-Host "Brave: $BRAVE"
Write-Host "Bridge: $BRIDGE_SCRIPT"
Write-Host "Repo root: $REPO_ROOT"

# ---------------------------------------------------------------------------
# Single-flight: kill leftovers from any previous unclean exit.
# We only kill processes on the ports we own so we don't disturb an
# active noVNC session if one happens to be running alongside.
# ---------------------------------------------------------------------------
Get-Process brave, cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Kill anything bound to :9222 (old Brave CDP) or :6090 (old bridge).
foreach ($port in @($CDP_PORT, $BRIDGE_PORT)) {
    $pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pid in $pids) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Seconds 1

# ---------------------------------------------------------------------------
# 1. Launch Brave HEADFUL — NOT headless (avoids FB headless detection).
#    James's profile is already logged in; we reuse it as-is.
# ---------------------------------------------------------------------------
$braveArgs = @(
    "--user-data-dir=$ProfileDir"
    "--no-first-run"
    "--no-default-browser-check"
    "--window-size=1280,900"
    "--window-position=0,0"
    "--remote-debugging-port=$CDP_PORT"
    $TargetUrl
)
$braveProc = Start-Process -FilePath $BRAVE -ArgumentList $braveArgs -PassThru
Write-Host "Brave launched pid=$($braveProc.Id) cdpPort=$CDP_PORT url=$TargetUrl"

# Give Brave a moment to start listening on the CDP port before the bridge tries to connect.
Start-Sleep -Seconds 2

# ---------------------------------------------------------------------------
# 2. Start the Node CDP bridge — serves viewer.html + WebSocket on :6090.
# ---------------------------------------------------------------------------
$bridgeArgs = @("$BRIDGE_SCRIPT", "--cdp-port", "$CDP_PORT", "--serve-port", "$BRIDGE_PORT")
$bridgeProc = Start-Process -FilePath $NODE -ArgumentList $bridgeArgs -PassThru -WindowStyle Hidden
Write-Host "CDP bridge launched pid=$($bridgeProc.Id) servePort=$BRIDGE_PORT"

# ---------------------------------------------------------------------------
# 3. Start cloudflared quick tunnel pointing at :6090 (the Node bridge).
#    Use the same dual-logfile tail pattern as the noVNC spawner.
# ---------------------------------------------------------------------------
$tunnelLogOut = [System.IO.Path]::GetTempFileName()
$tunnelLogErr = [System.IO.Path]::GetTempFileName()
$cfArgs = @("tunnel", "--no-autoupdate", "--url", "http://localhost:$BRIDGE_PORT")
$cfProc = Start-Process -FilePath $CLOUDFLARED -ArgumentList $cfArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelLogOut -RedirectStandardError $tunnelLogErr
Write-Host "cloudflared started pid=$($cfProc.Id), waiting for tunnel URL..."

# Tail BOTH log files for up to 45s — mirrors the noVNC spawner's timeout.
$tunnelUrl = $null
$deadline   = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
    Start-Sleep -Milliseconds 500
    foreach ($logFile in @($tunnelLogErr, $tunnelLogOut)) {
        if (Test-Path $logFile) {
            $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
            if ($content -match "https://[a-z0-9-]+\.trycloudflare\.com") {
                $tunnelUrl = $Matches[0]
                break
            }
        }
    }
}

if (-not $tunnelUrl) {
    Write-Host "FATAL: cloudflared did not print a tunnel URL within 45s"
    Write-Host "--- cloudflared stderr tail ---"
    if (Test-Path $tunnelLogErr) {
        Get-Content $tunnelLogErr -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "cf-err: $_" }
    }
    Write-Host "--- cloudflared stdout tail ---"
    if (Test-Path $tunnelLogOut) {
        Get-Content $tunnelLogOut -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "cf-out: $_" }
    }
    if ($cfProc     -and $cfProc.Id)     { Stop-Process -Id $cfProc.Id     -Force -ErrorAction SilentlyContinue }
    if ($bridgeProc -and $bridgeProc.Id) { Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue }
    if ($braveProc  -and $braveProc.Id)  { Stop-Process -Id $braveProc.Id  -Force -ErrorAction SilentlyContinue }
    Remove-Item $tunnelLogOut, $tunnelLogErr -ErrorAction SilentlyContinue
    exit 3
}

# ---------------------------------------------------------------------------
# 4. Emit the ONE stdout line the worker greps for — the viewer URL.
#    Append /viewer.html?autoconnect=true so the frontend can open
#    the canvas viewer directly (equivalent to the noVNC /vnc.html path).
# ---------------------------------------------------------------------------
$viewerUrl = "$tunnelUrl/viewer.html?autoconnect=true"
Write-Host $viewerUrl

# ---------------------------------------------------------------------------
# 5. Block until Brave exits or parent kills our tree.
# ---------------------------------------------------------------------------
try {
    while ($true) {
        Start-Sleep -Seconds 2
        if ($null -eq (Get-Process -Id $braveProc.Id -ErrorAction SilentlyContinue)) {
            Write-Host "Brave exited; cleaning up CDP session"
            break
        }
    }
} finally {
    if ($braveProc  -and $braveProc.Id)  { Stop-Process -Id $braveProc.Id  -Force -ErrorAction SilentlyContinue }
    if ($cfProc     -and $cfProc.Id)     { Stop-Process -Id $cfProc.Id     -Force -ErrorAction SilentlyContinue }
    if ($bridgeProc -and $bridgeProc.Id) { Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $tunnelLogOut, $tunnelLogErr -ErrorAction SilentlyContinue
    Write-Host "CDP session cleanup complete for account=$AccountId"
}
