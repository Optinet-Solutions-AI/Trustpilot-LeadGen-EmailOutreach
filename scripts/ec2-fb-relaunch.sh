#!/usr/bin/env bash
# One-shot rebuild of the FB-login environment after iptables / Chrome
# / cloudflared churn. Run this when you want a clean slate without
# re-doing each subcommand. Outputs the new noVNC URL at the end.
#
# Usage:
#   sudo /opt/scraper/scripts/ec2-fb-relaunch.sh <account_id>

set -euo pipefail

ACCOUNT_ID="${1:?Usage: $0 <account_id>}"
SCRAPER_USER="${SCRAPER_USER:-scraper}"
REPO_DIR="${REPO_DIR:-/opt/scraper}"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: must run as root (sudo)" >&2
    exit 1
fi

echo "=== Step 1/5: pull latest scripts ==="
sudo -u "$SCRAPER_USER" git -C "$REPO_DIR" pull --ff-only origin main || true

echo
echo "=== Step 2/5: kill stale Chrome / VNC processes ==="
pkill -9 -f "user-data-dir=/srv/fb-profiles" 2>/dev/null || true
sleep 2

echo
echo "=== Step 3/5: ensure Xvfb + x11vnc are running ==="
if ! pgrep -f "Xvfb :99" >/dev/null; then
    echo "INFO: Xvfb not running; starting via login-session script"
    nohup "$REPO_DIR/scripts/ec2-fb-login-session.sh" "$ACCOUNT_ID" >/tmp/relaunch-session.log 2>&1 &
    sleep 8
fi
echo "Xvfb: $(pgrep -af 'Xvfb :99' | head -1 || echo 'MISSING')"
echo "x11vnc: $(pgrep -af 'x11vnc.*5900' | head -1 || echo 'MISSING')"

echo
echo "=== Step 4/5: restart cloudflared + websockify (clean URL) ==="
systemctl stop ec2-novnc ec2-cf-tunnel 2>/dev/null || true
sleep 2
"$REPO_DIR/scripts/ec2-expose-vnc.sh" || true

echo
echo "=== Step 5/5: launch plain Chrome (clean profile, all fingerprint fixes) ==="
"$REPO_DIR/scripts/ec2-fb-plain-chrome.sh" "$ACCOUNT_ID" --clean
