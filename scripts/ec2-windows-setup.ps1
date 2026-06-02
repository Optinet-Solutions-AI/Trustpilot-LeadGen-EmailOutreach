# Windows EC2 setup for FB scraper worker (Phase 1, 2026-06-01).
#
# Run as Administrator in an RDP session, ONCE per Windows EC2 box.
# Installs Brave + Python + Git, clones the repo, sets up venv with
# all deps. Idempotent — re-running is safe.
#
# WHAT IT DOES
#   1. Install Chocolatey (Windows package manager)
#   2. choco install brave + python (3.12) + git
#   3. Clone the project repo to C:\scraper
#   4. Create venv, install requirements.txt
#   5. Create C:\fb-profiles (per-operator profile root)
#   6. Print next-step instructions (run local_fb_login_for_account.py)
#
# USAGE
#   Open PowerShell AS ADMINISTRATOR, then:
#     Set-ExecutionPolicy Bypass -Scope Process -Force
#     iwr -useb https://raw.githubusercontent.com/Optinet-Solutions-AI/Trustpilot-LeadGen-EmailOutreach/main/scripts/ec2-windows-setup.ps1 | iex
#
#   Or, if the repo is already cloned:
#     C:\scraper\scripts\ec2-windows-setup.ps1

$ErrorActionPreference = "Stop"
$REPO_URL = "https://github.com/Optinet-Solutions-AI/Trustpilot-LeadGen-EmailOutreach.git"
$REPO_DIR = "C:\scraper"
$PROFILE_ROOT = "C:\fb-profiles"

Write-Host "`n=== Phase 1: Windows EC2 FB Scraper Setup ===`n" -ForegroundColor Cyan

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: must run as Administrator." -ForegroundColor Red
    exit 1
}

# Step 1: Chocolatey
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Host "[1/6] Installing Chocolatey..." -ForegroundColor Yellow
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "[1/6] Chocolatey already installed." -ForegroundColor Green
}

# Step 2: Brave + Python + Git (separate calls — choco's --version
# applies to ALL listed packages when batched, which made brave/git
# fail with "version 3.12.4 not found").
Write-Host "[2/6] Installing Brave..." -ForegroundColor Yellow
choco install -y brave --no-progress
Write-Host "[2/6] Installing Python 3.12..." -ForegroundColor Yellow
choco install -y python --version=3.12.4 --no-progress
Write-Host "[2/6] Installing Git..." -ForegroundColor Yellow
choco install -y git --no-progress
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Write-Host "  brave: $(Get-Command brave -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)" -ForegroundColor DarkGray
Write-Host "  python: $(python --version)" -ForegroundColor DarkGray
Write-Host "  git: $(git --version)" -ForegroundColor DarkGray

# Step 3: Clone repo (or pull if already exists)
if (Test-Path $REPO_DIR) {
    Write-Host "[3/6] Repo already cloned. Pulling latest..." -ForegroundColor Yellow
    Push-Location $REPO_DIR
    git fetch origin main
    git reset --hard origin/main
    Pop-Location
} else {
    Write-Host "[3/6] Cloning repo to $REPO_DIR..." -ForegroundColor Yellow
    git clone $REPO_URL $REPO_DIR
}

# Step 4: venv
if (-not (Test-Path "$REPO_DIR\.venv\Scripts\python.exe")) {
    Write-Host "[4/6] Creating Python venv..." -ForegroundColor Yellow
    Push-Location $REPO_DIR
    python -m venv .venv
    Pop-Location
} else {
    Write-Host "[4/6] venv already exists." -ForegroundColor Green
}

# Step 5: deps
Write-Host "[5/6] Installing Python deps from requirements.txt (this takes 2-3 min)..." -ForegroundColor Yellow
& "$REPO_DIR\.venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
& "$REPO_DIR\.venv\Scripts\python.exe" -m pip install -r "$REPO_DIR\requirements.txt" --quiet
& "$REPO_DIR\.venv\Scripts\python.exe" -m playwright install chromium

# Step 6: profile root
if (-not (Test-Path $PROFILE_ROOT)) {
    New-Item -ItemType Directory -Path $PROFILE_ROOT | Out-Null
    Write-Host "[6/6] Created profile root: $PROFILE_ROOT" -ForegroundColor Green
} else {
    Write-Host "[6/6] Profile root exists: $PROFILE_ROOT" -ForegroundColor Green
}

Write-Host "`n=== Setup complete ===`n" -ForegroundColor Cyan
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Mint your FB profile via Brave (one-time):" -ForegroundColor White
Write-Host "       cd $REPO_DIR" -ForegroundColor DarkGray
Write-Host "       .venv\Scripts\python.exe -m tools.scraper.windows_fb_login 0eec969c-a888-4e54-bdfe-057ca11c2af5" -ForegroundColor DarkGray
Write-Host "  2. Smoke-test headless + Enigma proxy:" -ForegroundColor White
Write-Host "       .venv\Scripts\python.exe -m tools.scraper.windows_fb_smoke_test 0eec969c-a888-4e54-bdfe-057ca11c2af5" -ForegroundColor DarkGray
Write-Host ""
