# Grant Administrator the "Log on as a service" right (SeServiceLogonRight)
# via secedit, then prompt for the Administrator password and apply the
# NSSM ObjectName change. After this runs cleanly, the scraper-worker
# service runs under the Administrator account, which can:
#   - see the per-user Brave install at %LOCALAPPDATA%\BraveSoftware\...
#   - decrypt the DPAPI-encrypted Brave profile cookies (minted by the
#     same Administrator user when the FB profile was created)
#
# Usage (PowerShell as Administrator):
#   .\ec2-windows-grant-service-right.ps1
#
# Idempotent. Re-running is safe.

$ErrorActionPreference = "Stop"

$ACCOUNT = "Administrator"
$SERVICE_NAME = "scraper-worker"

# Must run as Administrator.
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: must run as Administrator." -ForegroundColor Red
    exit 1
}

# Resolve Administrator's SID — what secedit's User Rights line wants.
$sid = (New-Object System.Security.Principal.NTAccount($ACCOUNT)).Translate([System.Security.Principal.SecurityIdentifier]).Value
Write-Host "[1/4] Account $ACCOUNT -> SID $sid" -ForegroundColor Green

# Export current security policy. /areas USER_RIGHTS limits the export to
# the section we care about and keeps the diff small.
$tempInf = "$env:TEMP\sec-rights-export.inf"
$tempSdb = "$env:TEMP\sec-rights-apply.sdb"
Remove-Item $tempInf, $tempSdb -ErrorAction SilentlyContinue
& secedit /export /cfg $tempInf /areas USER_RIGHTS | Out-Null
Write-Host "[2/4] Exported current policy to $tempInf" -ForegroundColor Green

# Patch SeServiceLogonRight. INF format is one of:
#   SeServiceLogonRight = *S-1-5-..., DOMAIN\user, ...
# We add our SID with the *S- prefix if missing.
$content = Get-Content $tempInf -Raw
$marker = "*$sid"
$sidEscaped = [regex]::Escape($sid)

if ($content -match "(?m)^SeServiceLogonRight\s*=\s*(.+)$") {
    $currentRights = $matches[1].Trim()
    if ($currentRights -match $sidEscaped) {
        Write-Host "[3/4] $ACCOUNT already has SeServiceLogonRight - skipping patch" -ForegroundColor Yellow
        $needsApply = $false
    } else {
        $newRights = "$currentRights,$marker"
        $content = $content -replace "(?m)^SeServiceLogonRight\s*=\s*(.+)$", "SeServiceLogonRight = $newRights"
        Set-Content -Path $tempInf -Value $content -Encoding Unicode
        $needsApply = $true
    }
} else {
    # No SeServiceLogonRight line at all; append one under [Privilege Rights].
    if ($content -match "(?m)^\[Privilege Rights\]") {
        $content = $content -replace "(?m)^\[Privilege Rights\]", "[Privilege Rights]`r`nSeServiceLogonRight = $marker"
    } else {
        $content += "`r`n[Privilege Rights]`r`nSeServiceLogonRight = $marker`r`n"
    }
    Set-Content -Path $tempInf -Value $content -Encoding Unicode
    $needsApply = $true
}

if ($needsApply) {
    # Apply the patched policy. /db creates an SDB cache file (required).
    & secedit /configure /db $tempSdb /cfg $tempInf /areas USER_RIGHTS | Out-Null
    Write-Host "[3/4] Granted SeServiceLogonRight to $ACCOUNT" -ForegroundColor Green
}

# Prompt for the password ONCE (SecureString -> plain only for NSSM).
$securePassword = Read-Host -Prompt "Enter the Windows Administrator password" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR) | Out-Null

# Stop service before reconfiguring ObjectName.
& nssm stop $SERVICE_NAME 2>$null | Out-Null

# Set ObjectName via NSSM CLI.
& nssm set $SERVICE_NAME ObjectName ".\$ACCOUNT" $plainPassword
$plainPassword = $null  # let GC reclaim
[System.GC]::Collect()

Write-Host "[4/4] NSSM ObjectName set to .\$ACCOUNT" -ForegroundColor Green

# Clean profile lock + start service.
Get-Process brave -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Path "C:\fb-profiles\0eec969c-a888-4e54-bdfe-057ca11c2af5\SingletonLock" -ErrorAction SilentlyContinue
Remove-Item -Path "C:\fb-profiles\0eec969c-a888-4e54-bdfe-057ca11c2af5\SingletonCookie" -ErrorAction SilentlyContinue
Remove-Item -Path "C:\fb-profiles\0eec969c-a888-4e54-bdfe-057ca11c2af5\SingletonSocket" -ErrorAction SilentlyContinue
& nssm start $SERVICE_NAME

Start-Sleep -Seconds 3
$svc = Get-Service $SERVICE_NAME
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Service status: $($svc.Status)" -ForegroundColor Cyan
if ($svc.Status -eq "Running") {
    Write-Host "  SUCCESS! Worker is running as $ACCOUNT." -ForegroundColor Green
} else {
    Write-Host "  Service did not enter Running state. Check log:" -ForegroundColor Red
    Write-Host "    Get-Content C:\scraper\server\logs\worker.err.log -Tail 20" -ForegroundColor DarkGray
}
Write-Host "================================================================" -ForegroundColor Cyan

# Cleanup temp files.
Remove-Item $tempInf, $tempSdb -ErrorAction SilentlyContinue
