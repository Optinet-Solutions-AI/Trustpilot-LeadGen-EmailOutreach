# ec2-windows-spawn-noVNC.ps1
# Runs once per Connect-FB request. Spawned by social-connect-worker.ts.
# Starts in order:
#   1. TightVNC server (display only - VNC server itself runs as a service
#      and the listener is already on :5900)
#   2. websockify (translates noVNC websocket on :6080 to VNC :5900)
#   3. cloudflared tunnel pointing at :6080
#   4. Brave launched at facebook.com with the operator's profile dir
# Prints the noVNC URL on stdout. social-connect-worker.ts greps the
# first trycloudflare.com line and writes it to the DB row.
#
# Args:
#   -ProfileDir  C:\fb-profiles\<account_id>
#   -AccountId   the social_accounts.id (for log tagging)
#
# Process lifecycle: when the parent (Node) kills this script tree via
# taskkill /T /F, all spawned children (Brave / websockify / cloudflared)
# die with it. We also kill any leftovers from a previous unclean exit
# at the top of every run.

param(
    [Parameter(Mandatory=$true)][string]$ProfileDir,
    [Parameter(Mandatory=$true)][string]$AccountId
)

$ErrorActionPreference = "Continue"

# Paths - operator-installed binaries. If any are missing, fail fast.
# websockify runs via Python (pip install websockify) instead of a
# standalone .exe — the suchja/websockify-windows release is flaky and
# Python is already installed on this box for the scrapers.

# Probe multiple Brave install paths — choco installs to %LOCALAPPDATA% on
# Windows Server when run without elevated install scope, while
# desktop installers default to C:\Program Files. Python scraper has the
# same probe; mirror its order for consistency.
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

$BRAVE       = Find-Brave
$PYTHON      = "C:\scraper\.venv\Scripts\python.exe"
$CLOUDFLARED = "C:\tools\cloudflared\cloudflared.exe"

if (-not $BRAVE) {
    Write-Host "FATAL: Brave not found in any known location. Tried LOCALAPPDATA, Program Files, Program Files (x86)."
    exit 2
}

foreach ($p in @($PYTHON, $CLOUDFLARED)) {
    if (-not (Test-Path $p)) {
        Write-Host "FATAL: missing binary $p - run the one-time install steps in the plan"
        exit 2
    }
}

Write-Host "Brave: $BRAVE"

# Verify Python websockify is importable (pip install websockify on first setup).
& $PYTHON -c "import websockify" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "FATAL: Python websockify module missing. Run: $PYTHON -m pip install websockify"
    exit 2
}

# Single-flight: only one connect session at a time on this box. Kill any
# leftovers from a previous session that exited uncleanly. websockify now
# runs inside a Python process, so we kill by the websocket port instead.
Get-Process brave, cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# Kill anything bound to :6080 (the previous websockify Python process, if any)
$prevWs = Get-NetTCPConnection -LocalPort 6080 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pid in $prevWs) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# 1. Start websockify (Python module) - translates the noVNC HTML5 client's
#    websocket on :6080 into a raw VNC connection on the local TightVNC :5900.
$wsArgs = @("-m", "websockify", "--web", "C:\tools\noVNC", "6080", "localhost:5900")
$wsProc = Start-Process -FilePath $PYTHON -ArgumentList $wsArgs -PassThru -WindowStyle Hidden
Write-Host "websockify started pid=$($wsProc.Id) on :6080"
Start-Sleep -Seconds 1

# 2. Start cloudflared quick tunnel pointing at :6080. Output goes to a temp
#    file we tail for the public URL.
$tunnelLog = [System.IO.Path]::GetTempFileName()
$cfArgs = @("tunnel", "--no-autoupdate", "--url", "http://localhost:6080")
$cfProc = Start-Process -FilePath $CLOUDFLARED -ArgumentList $cfArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelLog
Write-Host "cloudflared started pid=$($cfProc.Id), waiting for tunnel URL..."

# Tail the log for up to 30s waiting for the URL line. cloudflared prints
# something like: "Your quick tunnel has been created! https://abc.trycloudflare.com"
$tunnelUrl = $null
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $tunnelLog) {
        $content = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match "https://[a-z0-9-]+\.trycloudflare\.com") {
            $tunnelUrl = $Matches[0]
        }
    }
}

if (-not $tunnelUrl) {
    Write-Host "FATAL: cloudflared did not print a tunnel URL within 30s"
    Stop-Process -Id $cfProc.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $wsProc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $tunnelLog -ErrorAction SilentlyContinue
    exit 3
}

# Emit the URL - this is the line social-connect-worker.ts greps for.
# Append /vnc.html for the noVNC client page, plus auto-connect flags.
$noVncUrl = "$tunnelUrl/vnc.html?autoconnect=true&resize=remote"
Write-Host $noVncUrl

# 3. Launch Brave at facebook.com with the operator's persistent profile dir.
#    --remote-debugging-port=9222 enables the Chromium DevTools Protocol (CDP)
#    so the Node worker can extract structured cookies via Network.getAllCookies
#    instead of reading the raw SQLite binary file.
$braveArgs = @(
    "--user-data-dir=$ProfileDir"
    "--no-first-run"
    "--no-default-browser-check"
    "--window-size=1280,900"
    "--window-position=0,0"
    "--remote-debugging-port=9222"
    "https://www.facebook.com/"
)
$braveProc = Start-Process -FilePath $BRAVE -ArgumentList $braveArgs -PassThru
Write-Host "brave launched pid=$($braveProc.Id) profile=$ProfileDir"

# Block until parent (Node) kills our process tree via taskkill /T /F. We
# sit in a loop and check that Brave is still alive - if the operator
# closes the browser window we also exit so the worker marks the request
# 'failed' cleanly.
try {
    while ($true) {
        Start-Sleep -Seconds 2
        if ((Get-Process -Id $braveProc.Id -ErrorAction SilentlyContinue) -eq $null) {
            Write-Host "Brave exited; cleaning up"
            break
        }
    }
} finally {
    Stop-Process -Id $braveProc.Id  -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $cfProc.Id     -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $wsProc.Id     -Force -ErrorAction SilentlyContinue
    Remove-Item $tunnelLog -ErrorAction SilentlyContinue
}
