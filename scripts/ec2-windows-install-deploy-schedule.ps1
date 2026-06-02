# Register a Scheduled Task that runs ec2-windows-deploy.ps1 every 5 min
# under the SYSTEM account (no password needed; SYSTEM can do everything
# the deploy script needs — git pull, npm, nssm restart). Mirrors the
# Linux EC2's /etc/cron.d/scraper-deploy entry.
#
# Usage (PowerShell as Administrator):
#   .\ec2-windows-install-deploy-schedule.ps1
#
# To inspect/unregister later:
#   Get-ScheduledTask -TaskName "scraper-deploy"
#   Unregister-ScheduledTask -TaskName "scraper-deploy" -Confirm:$false

$ErrorActionPreference = "Stop"

$TASK_NAME      = "scraper-deploy"
$DEPLOY_SCRIPT  = "C:\scraper\scripts\ec2-windows-deploy.ps1"

# Must run as Administrator.
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: must run as Administrator." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $DEPLOY_SCRIPT)) {
    Write-Host "ERROR: deploy script not found at $DEPLOY_SCRIPT" -ForegroundColor Red
    Write-Host "Run 'git pull origin main' in C:\scraper first." -ForegroundColor Red
    exit 1
}

# Drop any existing task so the script is idempotent.
$existing = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TASK_NAME'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
}

# Build the task definition.
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$DEPLOY_SCRIPT`""

# Trigger: every 5 min, starting now, indefinitely. AtStartup trigger
# also runs it once when EC2 boots so a fresh box gets the latest code
# without waiting for the first 5-min interval.
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$triggerCron    = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30) -RepetitionInterval (New-TimeSpan -Minutes 5)

# Settings: short timeout (5 min) so a hung deploy doesn't pile up;
# allow the task to run even on battery (EC2 doesn't have a battery,
# but the default is to skip — explicit allow is safer).
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

# Principal: SYSTEM (no password needed, highest privilege).
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TASK_NAME `
    -Action $action `
    -Trigger @($triggerStartup, $triggerCron) `
    -Settings $settings `
    -Principal $principal `
    -Description "Auto-pull latest code from git + restart scraper-worker every 5 min"

# Start it once now to validate.
Start-ScheduledTask -TaskName $TASK_NAME

Start-Sleep -Seconds 3
$info = Get-ScheduledTaskInfo -TaskName $TASK_NAME

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Scheduled task '$TASK_NAME' registered." -ForegroundColor Cyan
Write-Host "  Last run: $($info.LastRunTime)" -ForegroundColor Cyan
Write-Host "  Next run: $($info.NextRunTime)" -ForegroundColor Cyan
Write-Host "  Last result: $($info.LastTaskResult) (0 = success)" -ForegroundColor Cyan
Write-Host "" -ForegroundColor Cyan
Write-Host "  Logs: C:\scraper-deploy\deploy.log" -ForegroundColor Yellow
Write-Host "  Manual run:" -ForegroundColor Yellow
Write-Host "    powershell -ExecutionPolicy Bypass -File $DEPLOY_SCRIPT" -ForegroundColor DarkGray
Write-Host "  Force retry after a failed deploy:" -ForegroundColor Yellow
Write-Host "    Remove-Item C:\scraper-deploy\last_attempted_commit" -ForegroundColor DarkGray
Write-Host "================================================================" -ForegroundColor Cyan
