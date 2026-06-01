#!/usr/bin/env bash
# Expose EC2's local Xvfb+x11vnc (port 5900) as a public HTTPS URL via
# noVNC + Cloudflare quick tunnel. Used when an operator needs to drive
# the FB login Chrome but is on AWS Console (no aws CLI port-forward).
#
# Both services run as systemd transient units so they survive SSM
# session disconnects and needrestart's systemd-logind churn.
#
# Usage (run as root):
#   sudo /opt/scraper/scripts/ec2-expose-vnc.sh
#
# Prints the URL to open in a browser. Browser → noVNC → connects to
# the EC2 Chrome (no password). Log in to Facebook, close Chrome.
#
# To stop afterwards (recommended — closes the public exposure):
#   sudo systemctl stop ec2-novnc ec2-cf-tunnel

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: must run as root (use sudo)" >&2
    exit 1
fi

# Install deps once. NEEDRESTART_MODE=l prevents apt from restarting
# systemd-logind on us (which would kill our SSM session).
export NEEDRESTART_MODE=l
export DEBIAN_FRONTEND=noninteractive

NEEDED=()
for pkg in novnc websockify; do
    dpkg -s "$pkg" >/dev/null 2>&1 || NEEDED+=("$pkg")
done
if [[ ${#NEEDED[@]} -gt 0 ]]; then
    apt-get update -qq
    apt-get install -y "${NEEDED[@]}"
fi

if ! command -v cloudflared >/dev/null; then
    wget -qO /tmp/cloudflared.deb \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    apt-get install -y /tmp/cloudflared.deb
fi

# Reset any stale units so we can re-use the same unit names cleanly.
for unit in ec2-novnc.service ec2-cf-tunnel.service; do
    systemctl stop "$unit" 2>/dev/null || true
    systemctl reset-failed "$unit" 2>/dev/null || true
done

# CRITICAL: `--` separator before the actual command so systemd-run
# doesn't try to parse --web / --url as its own options.
systemd-run \
    --unit=ec2-novnc \
    --description="noVNC web bridge (port 6080 -> 5900)" \
    -- /usr/bin/websockify --web /usr/share/novnc/ 6080 127.0.0.1:5900

systemd-run \
    --unit=ec2-cf-tunnel \
    --description="Cloudflare quick tunnel exposing noVNC" \
    -- /usr/bin/cloudflared tunnel --url http://localhost:6080

# Wait up to 30s for cloudflared to print the public URL in its journal.
URL=""
for i in $(seq 1 30); do
    sleep 1
    URL=$(journalctl -u ec2-cf-tunnel --no-pager --since "1 minute ago" 2>/dev/null \
          | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" \
          | head -1 || true)
    [[ -n "$URL" ]] && break
done

echo
if [[ -z "$URL" ]]; then
    echo "ERROR: cloudflared did not produce a URL in 30s. Diagnostics:"
    systemctl status ec2-cf-tunnel --no-pager || true
    journalctl -u ec2-cf-tunnel --no-pager -n 40 || true
    exit 1
fi

HOST="${URL#https://}"
FULL_URL="${URL}/vnc.html?host=${HOST}&port=443&encrypt=1&path=websockify&autoconnect=true"

cat <<EOF
================================================================
  Open this URL in any browser on your laptop:

  $FULL_URL

  It loads noVNC, auto-connects to the EC2 Chrome (no password).
  Log into Facebook, then CLOSE the Chrome window inside the browser.

  When done, stop the public tunnel:
      sudo systemctl stop ec2-novnc ec2-cf-tunnel
================================================================

EOF
