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
    [string]$AdsPowerExe = 'C:\Program Files\AdsPower Global\AdsPower Global.exe'
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
