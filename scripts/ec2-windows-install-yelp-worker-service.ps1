# Install a SECOND scraper-worker as a Windows Service (NSSM) that claims ONLY
# Yelp jobs and runs them through the DataDome cookie-reuse relay path.
#
# Why a dedicated worker: the claim RPC's PLATFORM_FILTER is exact single-match
# (migration 043), so one worker == one platform. The existing FB worker is
# filtered to 'facebook'; the Linux worker is headless (can't run the headed
# relay). Yelp needs its OWN headed worker with PLATFORM_FILTER=yelp.
#
# PREREQUISITES (do these first):
#   1. Code is deployed to C:\scraper and built:  cd C:\scraper\server; npm run build
#   2. The Enigma RESIDENTIAL_PROXY_* env vars are set (same ones FB/IG use).
#   3. You have minted the DataDome cookie ONCE via noVNC (see step below) so
#      C:\scraper\tools\scraper\data\yelp_datadome_cookie.json exists.
#   4. Set $STICKY below to the SAME session token you minted the cookie on.
#
# MINT (run once, interactively, in the noVNC desktop — NOT as a service):
#   cd C:\scraper
#   $env:YELP_STICKY_SESSION="optirate-yelp"; $env:YELP_PROXY_COUNTRY="US"
#   python -m tools.scraper.mint_yelp_datadome
#   # a Chrome window opens on Yelp /search -> drag the slider to solve it.
#
# Usage (PowerShell as Administrator):
#   .\ec2-windows-install-yelp-worker-service.ps1
#
# Stop / start / remove:
#   nssm stop scraper-worker-yelp ; nssm start scraper-worker-yelp
#   nssm remove scraper-worker-yelp confirm
#
# Logs: C:\scraper\server\logs\worker-yelp{,.err}.log

$ErrorActionPreference = "Stop"

$SERVICE_NAME = "scraper-worker-yelp"
$REPO_DIR     = "C:\scraper"
$LOG_DIR      = "$REPO_DIR\server\logs"
$STICKY       = "optirate-yelp"   # <-- MUST match the session used at mint time
$COUNTRY      = "US"
$COOKIE_FILE  = "$REPO_DIR\tools\scraper\data\yelp_datadome_cookie.json"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: must run as Administrator." -ForegroundColor Red; exit 1
}
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing NSSM..." -ForegroundColor Yellow; choco install -y nssm --no-progress
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$workerScript = "$REPO_DIR\server\dist\worker\scraper-worker.js"
if (-not (Test-Path $workerScript)) { Write-Host "ERROR: build first (npm run build)" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $COOKIE_FILE)) {
    Write-Host "WARNING: $COOKIE_FILE not found — mint the cookie first (see header)." -ForegroundColor Yellow
}
if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null }

$existingSvc = Get-Service $SERVICE_NAME -ErrorAction SilentlyContinue
if ($existingSvc) { & nssm stop $SERVICE_NAME 2>$null | Out-Null }
else { & nssm install $SERVICE_NAME $nodeExe $workerScript }

& nssm set $SERVICE_NAME AppDirectory "$REPO_DIR\server"

# PLATFORM_FILTER=yelp -> this worker claims ONLY Yelp jobs.
# YELP_RELAY_HEADLESS=false -> the DataDome cookie only works in a headed
# browser; NSSM runs in session 0 (no visible desktop) but launches a real
# (non---headless) Chrome, which reads as headed to DataDome. If DataDome
# still re-challenges under the service, run the worker inside the interactive
# noVNC session instead (see the workflow doc).
$envVars = @(
    "PLATFORM_FILTER=yelp",
    "WORKER_ID=windows-yelp-worker-1",
    "POLL_INTERVAL_MS=30000",
    "MAX_CONCURRENT_JOBS=1",
    "YELP_LISTING_SOURCE=relay",
    "YELP_PROXY_COUNTRY=$COUNTRY",
    "YELP_STICKY_SESSION=$STICKY",
    "YELP_DATADOME_COOKIE_FILE=$COOKIE_FILE",
    "YELP_RELAY_HEADLESS=false"
)
& nssm set $SERVICE_NAME AppEnvironmentExtra @envVars

& nssm set $SERVICE_NAME AppStdout "$LOG_DIR\worker-yelp.log"
& nssm set $SERVICE_NAME AppStderr "$LOG_DIR\worker-yelp.err.log"
& nssm set $SERVICE_NAME AppRotateFiles 1
& nssm set $SERVICE_NAME AppRotateOnline 1
& nssm set $SERVICE_NAME AppRotateBytes 10485760
& nssm set $SERVICE_NAME AppThrottle 5000
& nssm set $SERVICE_NAME AppExit Default Restart
& nssm set $SERVICE_NAME AppRestartDelay 5000
& nssm set $SERVICE_NAME Start SERVICE_AUTO_START
& nssm set $SERVICE_NAME Description "Yelp scraper worker - claims platform=yelp, runs the DataDome cookie-reuse relay path"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Service '$SERVICE_NAME' installed (PLATFORM_FILTER=yelp)." -ForegroundColor Cyan
Write-Host "  IMPORTANT: it inherits machine env for RESIDENTIAL_PROXY_* (Enigma)." -ForegroundColor Yellow
Write-Host "  Confirm those are set for the service account, then:" -ForegroundColor Yellow
Write-Host "     nssm edit $SERVICE_NAME   # Log on tab -> .\Administrator + password" -ForegroundColor DarkGray
Write-Host "     nssm start $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host "     Get-Content $LOG_DIR\worker-yelp.log -Wait -Tail 20" -ForegroundColor DarkGray
Write-Host "  Also: on the LINUX worker add 'yelp' to PLATFORM_EXCLUDE so it stops" -ForegroundColor Yellow
Write-Host "  claiming Yelp jobs it can't run headed (see workflow doc)." -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan
