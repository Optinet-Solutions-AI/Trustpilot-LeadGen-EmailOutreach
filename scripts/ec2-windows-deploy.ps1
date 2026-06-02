# Idempotent Windows EC2 scraper-worker deploy.
# Mirrors scripts/deploy-ec2.sh (Linux EC2 deploy script) for the Windows
# box. Designed to run from Task Scheduler every 5 minutes. Cheap path
# is <1s when origin/main hasn't moved (the 99% case).
#
# CHEAP PATH (no new commits)
#   1. git fetch origin main         (network: ~10 KB)
#   2. Compare local HEAD vs origin   (CPU: microseconds)
#   3. Exit 0, no log written
#
# SLOW PATH (new commits detected)
#   1. Mark the target commit as `attempted` so a buggy build doesn't
#      retry every 5 minutes — only re-tried after origin moves past it
#   2. git pull --ff-only origin main
#   3. cd server; npm ci --no-audit --no-fund
#   4. npm run build
#   5. nssm restart scraper-worker
#   6. Verify the service returned to Running, log SUCCESS or FAILED
#
# Files used (mirrors Linux paths):
#   C:\scraper-deploy\last_attempted_commit  (anti-spam marker)
#   C:\scraper-deploy\deploy.log             (append-only timestamped log)
#   C:\scraper-deploy\deploy.lock            (single-flight mutex)
#
# Manual trigger:
#   powershell -ExecutionPolicy Bypass -File C:\scraper\scripts\ec2-windows-deploy.ps1
#
# Force retry of a failed commit:
#   Remove-Item C:\scraper-deploy\last_attempted_commit
#   powershell -ExecutionPolicy Bypass -File C:\scraper\scripts\ec2-windows-deploy.ps1

$ErrorActionPreference = "Stop"

$REPO_DIR     = "C:\scraper"
$SERVICE_NAME = "scraper-worker"
$STATE_DIR    = "C:\scraper-deploy"
$LOG_FILE     = "$STATE_DIR\deploy.log"
$LOCK_FILE    = "$STATE_DIR\deploy.lock"
$ATTEMPTED    = "$STATE_DIR\last_attempted_commit"

# Ensure state dir exists.
if (-not (Test-Path $STATE_DIR)) {
    New-Item -ItemType Directory -Path $STATE_DIR -Force | Out-Null
}

function Write-DeployLog {
    param([string]$Message)
    $stamp = (Get-Date -AsUTC).ToString("yyyy-MM-ddTHH:mm:ssZ")
    "[$stamp] $Message" | Out-File -FilePath $LOG_FILE -Encoding utf8 -Append
}

# Acquire single-flight lock. If we can't, another deploy is in flight —
# silently exit (the cron tick that started first will finish).
try {
    $lockStream = [System.IO.File]::Open($LOCK_FILE, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
} catch {
    exit 0
}

try {
    # Step 1: fetch origin.
    Push-Location $REPO_DIR
    try {
        & git fetch origin main 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { exit 0 }  # transient network glitch — try next tick

        $localHead  = & git rev-parse HEAD
        $remoteHead = & git rev-parse origin/main

        # Cheap path: nothing new.
        if ($localHead -eq $remoteHead) {
            exit 0
        }

        # Anti-spam: if we've already attempted this exact commit and it
        # failed, don't retry until origin moves past it.
        if (Test-Path $ATTEMPTED) {
            $lastAttempted = (Get-Content $ATTEMPTED -Raw).Trim()
            if ($lastAttempted -eq $remoteHead) {
                exit 0
            }
        }

        Write-DeployLog "new commit detected: local=$localHead remote=$remoteHead"
        $remoteHead | Out-File -FilePath $ATTEMPTED -Encoding ascii -NoNewline

        # Step 2: pull.
        Write-DeployLog "git pull..."
        & git pull --ff-only origin main 2>&1 | Out-File -FilePath $LOG_FILE -Encoding utf8 -Append
        if ($LASTEXITCODE -ne 0) {
            Write-DeployLog "FAILED: git pull exited $LASTEXITCODE"
            exit 1
        }

        # Step 3: npm ci (only if package.json or lock changed).
        Push-Location "$REPO_DIR\server"
        try {
            $needNpmCi = $true  # safest default — always run
            # (optimization: check `git diff --name-only $localHead $remoteHead`
            # for package-lock.json/package.json change; skipping for simplicity)
            if ($needNpmCi) {
                Write-DeployLog "npm ci..."
                & npm ci --no-audit --no-fund 2>&1 | Out-File -FilePath $LOG_FILE -Encoding utf8 -Append
                if ($LASTEXITCODE -ne 0) {
                    Write-DeployLog "FAILED: npm ci exited $LASTEXITCODE"
                    exit 1
                }
            }

            # Step 4: build.
            Write-DeployLog "npm run build..."
            & npm run build 2>&1 | Out-File -FilePath $LOG_FILE -Encoding utf8 -Append
            if ($LASTEXITCODE -ne 0) {
                Write-DeployLog "FAILED: npm run build exited $LASTEXITCODE"
                exit 1
            }
        } finally {
            Pop-Location
        }

        # Step 5: restart service.
        Write-DeployLog "nssm restart $SERVICE_NAME..."
        cmd /c "nssm restart $SERVICE_NAME" 2>&1 | Out-File -FilePath $LOG_FILE -Encoding utf8 -Append

        # Step 6: verify.
        Start-Sleep -Seconds 5
        $svc = Get-Service $SERVICE_NAME -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq "Running") {
            Write-DeployLog "SUCCESS: deployed $remoteHead, service Running"
        } else {
            Write-DeployLog "FAILED: service status=$($svc.Status) after restart"
            exit 1
        }
    } finally {
        Pop-Location
    }
} finally {
    $lockStream.Close()
    Remove-Item $LOCK_FILE -ErrorAction SilentlyContinue
}
