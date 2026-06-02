# Idempotent Windows EC2 scraper-worker deploy. Runs from Task Scheduler
# every 5 min. Mirrors scripts/deploy-ec2.sh on the Linux side.
#
# PowerShell handles native-command stderr poorly under
# $ErrorActionPreference='Stop' (git writes progress to stderr,
# PowerShell interprets that as a terminating error). This script
# uses 'Continue' and checks $LASTEXITCODE explicitly after each
# native call to keep the control flow honest.

$ErrorActionPreference = "Continue"

$REPO_DIR     = "C:\scraper"
$SERVICE_NAME = "scraper-worker"
$STATE_DIR    = "C:\scraper-deploy"
$LOG_FILE     = "$STATE_DIR\deploy.log"
$LOCK_FILE    = "$STATE_DIR\deploy.lock"
$ATTEMPTED    = "$STATE_DIR\last_attempted_commit"

if (-not (Test-Path $STATE_DIR)) {
    New-Item -ItemType Directory -Path $STATE_DIR -Force | Out-Null
}

function Write-DeployLog {
    param([string]$Message)
    $stamp = (Get-Date -AsUTC).ToString("yyyy-MM-ddTHH:mm:ssZ")
    Add-Content -Path $LOG_FILE -Value "[$stamp] $Message" -Encoding utf8
}

# Run a native command, capture both stdout+stderr to the log,
# return the exit code. Avoids the PowerShell error-stream landmines.
function Invoke-Native {
    param(
        [string]$Description,
        [string]$Executable,
        [string[]]$Arguments
    )
    Write-DeployLog "$Description : $Executable $($Arguments -join ' ')"
    $output = & $Executable @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($output) {
        Add-Content -Path $LOG_FILE -Value ($output | Out-String).Trim() -Encoding utf8
    }
    return $code
}

# Single-flight lock.
try {
    $lockStream = [System.IO.File]::Open($LOCK_FILE, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
} catch {
    exit 0
}

try {
    Push-Location $REPO_DIR

    # Step 1: fetch.
    $fetchOut = & git fetch origin main 2>&1
    if ($LASTEXITCODE -ne 0) {
        # Network glitch - retry next tick. Log it cheaply.
        Write-DeployLog "git fetch transient failure (exit=$LASTEXITCODE) - will retry next tick"
        exit 0
    }

    $localHead  = (& git rev-parse HEAD 2>$null).Trim()
    $remoteHead = (& git rev-parse origin/main 2>$null).Trim()

    if ($localHead -eq $remoteHead) {
        # Cheap path: nothing new. Exit silently.
        exit 0
    }

    # Anti-spam: skip if we've already attempted this exact commit.
    if (Test-Path $ATTEMPTED) {
        $lastAttempted = (Get-Content $ATTEMPTED -Raw).Trim()
        if ($lastAttempted -eq $remoteHead) {
            Write-DeployLog "skip: commit $remoteHead already attempted and failed; waiting for next commit"
            exit 0
        }
    }

    Write-DeployLog "new commit: local=$localHead -> remote=$remoteHead"
    [System.IO.File]::WriteAllText($ATTEMPTED, $remoteHead)

    # Step 2: pull.
    $rc = Invoke-Native -Description "git pull" -Executable "git" -Arguments @("pull", "--ff-only", "origin", "main")
    if ($rc -ne 0) {
        Write-DeployLog "FAILED: git pull exited $rc"
        exit 1
    }

    # Step 3 + 4: npm ci + build.
    Push-Location "$REPO_DIR\server"
    try {
        $rc = Invoke-Native -Description "npm ci" -Executable "npm" -Arguments @("ci", "--no-audit", "--no-fund")
        if ($rc -ne 0) {
            Write-DeployLog "FAILED: npm ci exited $rc"
            exit 1
        }

        $rc = Invoke-Native -Description "npm run build" -Executable "npm" -Arguments @("run", "build")
        if ($rc -ne 0) {
            Write-DeployLog "FAILED: npm run build exited $rc"
            exit 1
        }
    } finally {
        Pop-Location
    }

    # Step 5: restart service.
    $rc = Invoke-Native -Description "nssm restart" -Executable "nssm" -Arguments @("restart", $SERVICE_NAME)
    if ($rc -ne 0) {
        Write-DeployLog "WARN: nssm restart exited $rc (will verify status)"
    }

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
    Pop-Location -ErrorAction SilentlyContinue
    $lockStream.Close()
    Remove-Item $LOCK_FILE -ErrorAction SilentlyContinue
}
