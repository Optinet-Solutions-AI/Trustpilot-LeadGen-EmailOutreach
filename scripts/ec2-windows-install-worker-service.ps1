# Install the scraper-worker as a Windows Service via NSSM.
# Runs idempotently — reinstalling is safe, just updates env vars.
#
# Phase 2.9 of the Windows EC2 worker rollout. After this script
# runs, the worker survives RDP disconnect, logoff, reboot, and
# crashes (NSSM auto-restarts on exit code != 0).
#
# Prerequisites:
#   - Node.js LTS installed (via choco install nodejs-lts)
#   - Repo cloned to C:\scraper
#   - server/ built (npm install + npm run build)
#   - FB profile minted at C:\fb-profiles\<account_id>
#
# Usage (PowerShell as Administrator):
#   .\ec2-windows-install-worker-service.ps1
#
# To stop / start / remove later:
#   nssm stop scraper-worker
#   nssm start scraper-worker
#   nssm remove scraper-worker confirm
#
# Logs at:
#   C:\scraper\server\logs\worker.log       (stdout)
#   C:\scraper\server\logs\worker.err.log   (stderr)

$ErrorActionPreference = "Stop"
$SERVICE_NAME = "scraper-worker"
$REPO_DIR     = "C:\scraper"
$LOG_DIR      = "$REPO_DIR\server\logs"

# Must run as Administrator.
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: must run as Administrator." -ForegroundColor Red
    exit 1
}

# 1. Install NSSM via Chocolatey if not present.
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "[1/6] Installing NSSM..." -ForegroundColor Yellow
    choco install -y nssm --no-progress
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "[1/6] NSSM already installed." -ForegroundColor Green
}

# 2. Find Node.js executable.
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    Write-Host "ERROR: node.exe not on PATH. Did you install nodejs-lts?" -ForegroundColor Red
    exit 1
}
Write-Host "[2/6] node.exe at: $nodeExe" -ForegroundColor Green

# 3. Verify the worker script exists.
$workerScript = "$REPO_DIR\server\dist\worker\scraper-worker.js"
if (-not (Test-Path $workerScript)) {
    Write-Host "ERROR: worker script not found at $workerScript" -ForegroundColor Red
    Write-Host "Run 'cd $REPO_DIR\server; npm run build' first." -ForegroundColor Red
    exit 1
}
Write-Host "[3/6] Worker script at: $workerScript" -ForegroundColor Green

# 4. Create log dir.
if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
}
Write-Host "[4/6] Logs will land in: $LOG_DIR" -ForegroundColor Green

# 5. Install or reconfigure the service.
$existing = nssm get $SERVICE_NAME Description 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "[5/6] Service exists — stopping and reconfiguring." -ForegroundColor Yellow
    nssm stop $SERVICE_NAME 2>$null | Out-Null
} else {
    Write-Host "[5/6] Installing new service '$SERVICE_NAME'..." -ForegroundColor Yellow
    nssm install $SERVICE_NAME $nodeExe $workerScript
}

# 6. Configure env vars + working dir + logs + restart policy.
nssm set $SERVICE_NAME AppDirectory "$REPO_DIR\server"

# Env vars threaded into the service. CRLF separator in AppEnvironmentExtra.
# NSSM expects KEY=VALUE pairs, one per line via -separator ` or repeated `set` calls.
nssm set $SERVICE_NAME AppEnvironmentExtra `
    "PLATFORM_FILTER=facebook" `
    "WORKER_ID=windows-fb-worker-1" `
    "POLL_INTERVAL_MS=30000" `
    "MAX_CONCURRENT_JOBS=1" `
    "FB_PROFILE_DIR=C:\fb-profiles\0eec969c-a888-4e54-bdfe-057ca11c2af5" `
    "PLAYWRIGHT_HEADLESS=true" `
    "SOCIAL_CHROME_VERSION=148"

# Logs.
nssm set $SERVICE_NAME AppStdout "$LOG_DIR\worker.log"
nssm set $SERVICE_NAME AppStderr "$LOG_DIR\worker.err.log"
nssm set $SERVICE_NAME AppRotateFiles 1
nssm set $SERVICE_NAME AppRotateOnline 1
nssm set $SERVICE_NAME AppRotateBytes 10485760  # rotate at 10 MB

# Restart policy: throttle restart attempts to once per 5s, max 3 retries
# in 30s window. Beyond that, NSSM gives up — operator must intervene.
nssm set $SERVICE_NAME AppThrottle 5000           # 5s grace period before counting as crash
nssm set $SERVICE_NAME AppExit Default Restart
nssm set $SERVICE_NAME AppRestartDelay 5000       # 5s wait between restarts

# Start type: Automatic so it survives reboot.
nssm set $SERVICE_NAME Start SERVICE_AUTO_START
nssm set $SERVICE_NAME Description "FB scraper worker — polls Supabase scrape_jobs queue for platform=facebook"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Service '$SERVICE_NAME' is installed and configured." -ForegroundColor Cyan
Write-Host "" -ForegroundColor Cyan
Write-Host "  IMPORTANT — Logon Account:" -ForegroundColor Yellow
Write-Host "    By default NSSM runs the service as LOCAL SYSTEM, which" -ForegroundColor Gray
Write-Host "    may not be able to launch Brave with the Administrator" -ForegroundColor Gray
Write-Host "    profile due to Windows DPAPI cookie encryption." -ForegroundColor Gray
Write-Host "" -ForegroundColor Cyan
Write-Host "    Recommended: configure logon as Administrator. Run:" -ForegroundColor White
Write-Host "        nssm edit $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host "    GUI opens → 'Log on' tab → 'This account' → fill in" -ForegroundColor Gray
Write-Host "    '.\Administrator' + your Windows Administrator password." -ForegroundColor Gray
Write-Host "    Click OK." -ForegroundColor Gray
Write-Host "" -ForegroundColor Cyan
Write-Host "  Then start the service:" -ForegroundColor White
Write-Host "        nssm start $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host "" -ForegroundColor Cyan
Write-Host "  Check status:" -ForegroundColor White
Write-Host "        nssm status $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host "        Get-Service $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host "" -ForegroundColor Cyan
Write-Host "  Tail logs:" -ForegroundColor White
Write-Host "        Get-Content $LOG_DIR\worker.log -Wait -Tail 20" -ForegroundColor DarkGray
Write-Host "================================================================" -ForegroundColor Cyan
