# Install the scraper-worker as a Windows Service via NSSM.
# Idempotent — reinstalling is safe, just updates env vars.
#
# Phase 2.9 of the Windows EC2 worker rollout.
#
# Usage (PowerShell as Administrator):
#   .\ec2-windows-install-worker-service.ps1
#
# Stop / start / remove:
#   nssm stop scraper-worker
#   nssm start scraper-worker
#   nssm remove scraper-worker confirm
#
# Logs at C:\scraper\server\logs\worker{,.err}.log (10 MB rotation).

$ErrorActionPreference = "Stop"

$SERVICE_NAME = "scraper-worker"
$REPO_DIR     = "C:\scraper"
$LOG_DIR      = "$REPO_DIR\server\logs"

# Must run as Administrator.
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: must run as Administrator." -ForegroundColor Red
    exit 1
}

# 1. NSSM via Chocolatey.
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "[1/6] Installing NSSM..." -ForegroundColor Yellow
    choco install -y nssm --no-progress
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "[1/6] NSSM already installed." -ForegroundColor Green
}

# 2. Node executable.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "ERROR: node.exe not on PATH. Did you install nodejs-lts?" -ForegroundColor Red
    exit 1
}
$nodeExe = $nodeCmd.Source
Write-Host "[2/6] node.exe at: $nodeExe" -ForegroundColor Green

# 3. Worker script.
$workerScript = "$REPO_DIR\server\dist\worker\scraper-worker.js"
if (-not (Test-Path $workerScript)) {
    Write-Host "ERROR: worker script not found at $workerScript" -ForegroundColor Red
    Write-Host "Run 'cd $REPO_DIR\server; npm run build' first." -ForegroundColor Red
    exit 1
}
Write-Host "[3/6] Worker script at: $workerScript" -ForegroundColor Green

# 4. Log dir.
if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
}
Write-Host "[4/6] Logs will land in: $LOG_DIR" -ForegroundColor Green

# 5. Service install or reconfigure. Check existence via Get-Service
# (avoids the flaky $LASTEXITCODE-after-redirect pattern).
$existingSvc = Get-Service $SERVICE_NAME -ErrorAction SilentlyContinue
if ($existingSvc) {
    Write-Host "[5/6] Service exists - stopping and reconfiguring." -ForegroundColor Yellow
    & nssm stop $SERVICE_NAME 2>$null | Out-Null
} else {
    Write-Host "[5/6] Installing new service '$SERVICE_NAME'..." -ForegroundColor Yellow
    & nssm install $SERVICE_NAME $nodeExe $workerScript
}

# 6. Configure: working dir + env vars + logs + restart policy.
& nssm set $SERVICE_NAME AppDirectory "$REPO_DIR\server"

# Build env-var lines as a string array. NSSM accepts space-separated
# KEY=VALUE pairs after `AppEnvironmentExtra` — passing them as one arg
# avoids the multi-line backtick-continuation parser headache.
$envVars = @(
    "PLATFORM_FILTER=facebook",
    "WORKER_ID=windows-fb-worker-1",
    "POLL_INTERVAL_MS=30000",
    "MAX_CONCURRENT_JOBS=1",
    "FB_PROFILE_DIR=C:\fb-profiles\0eec969c-a888-4e54-bdfe-057ca11c2af5",
    "PLAYWRIGHT_HEADLESS=true",
    "SOCIAL_CHROME_VERSION=148"
)
& nssm set $SERVICE_NAME AppEnvironmentExtra @envVars

# Logs.
& nssm set $SERVICE_NAME AppStdout "$LOG_DIR\worker.log"
& nssm set $SERVICE_NAME AppStderr "$LOG_DIR\worker.err.log"
& nssm set $SERVICE_NAME AppRotateFiles 1
& nssm set $SERVICE_NAME AppRotateOnline 1
& nssm set $SERVICE_NAME AppRotateBytes 10485760

# Restart policy.
& nssm set $SERVICE_NAME AppThrottle 5000
& nssm set $SERVICE_NAME AppExit Default Restart
& nssm set $SERVICE_NAME AppRestartDelay 5000

# Boot policy.
& nssm set $SERVICE_NAME Start SERVICE_AUTO_START
& nssm set $SERVICE_NAME Description "FB scraper worker - polls Supabase scrape_jobs queue for platform=facebook"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Service '$SERVICE_NAME' is installed and configured." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next: set logon account to Administrator." -ForegroundColor Yellow
Write-Host "    Run this GUI tool (asks for password):" -ForegroundColor Gray
Write-Host "        nssm edit $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host "    On the 'Log on' tab: 'This account' = .\Administrator," -ForegroundColor Gray
Write-Host "    paste your Windows password, click OK." -ForegroundColor Gray
Write-Host ""
Write-Host "  Then start the service:" -ForegroundColor Yellow
Write-Host "        nssm start $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Verify:" -ForegroundColor Yellow
Write-Host "        Get-Service $SERVICE_NAME" -ForegroundColor DarkGray
Write-Host "        Get-Content $LOG_DIR\worker.log -Wait -Tail 20" -ForegroundColor DarkGray
Write-Host "================================================================" -ForegroundColor Cyan
