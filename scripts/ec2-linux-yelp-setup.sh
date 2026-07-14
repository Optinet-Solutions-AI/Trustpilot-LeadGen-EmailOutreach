#!/usr/bin/env bash
# Set up the Linux EC2 worker to run Yelp discovery HEADED-under-xvfb, so Yelp
# no longer needs the (pricey) Windows box. Idempotent. Run as root.
#
#   sudo /opt/scraper/scripts/ec2-linux-yelp-setup.sh
#
# What it does: installs xvfb + x11vnc + google-chrome (if missing) and starts
# Xvfb :99 + x11vnc:5900 as transient systemd units (survive SSM disconnects,
# same pattern as ec2-expose-vnc.sh). Then prints the remaining manual steps
# (env vars, one-time cookie mint via noVNC, worker restart, verification).
#
# WHY headed-under-xvfb: Yelp /search is DataDome-walled; the reused cookie
# only clears it in a REAL (non---headless) browser. Xvfb gives Chrome a real
# rendering context on a virtual framebuffer → reads as headed. (Different
# anti-bot system from Meta, so FB-checkpointed-on-Linux does NOT predict Yelp
# here — but it is UNVERIFIED, so VERIFY before you stop the Windows box.)

set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "ERROR: run as root (sudo)" >&2; exit 1; }
export NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive

REPO="${REPO:-/opt/scraper}"
COOKIE="$REPO/tools/scraper/data/yelp_datadome_cookie.json"

# 1. Packages
NEEDED=()
for p in xvfb x11vnc; do dpkg -s "$p" >/dev/null 2>&1 || NEEDED+=("$p"); done
if [[ ${#NEEDED[@]} -gt 0 ]]; then apt-get update -qq; apt-get install -y "${NEEDED[@]}"; fi
if ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
    echo "Installing google-chrome-stable..."
    wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y /tmp/chrome.deb
fi

# 2. Xvfb :99 + x11vnc:5900 as transient units
for u in yelp-xvfb yelp-x11vnc; do
    systemctl stop "$u" 2>/dev/null || true
    systemctl reset-failed "$u" 2>/dev/null || true
done
systemd-run --unit=yelp-xvfb --description="Xvfb :99 for Yelp headed scraping" \
    -- /usr/bin/Xvfb :99 -screen 0 1920x1200x24
sleep 1
systemd-run --unit=yelp-x11vnc --description="x11vnc mirror of :99 -> 5900" \
    -- /usr/bin/x11vnc -display :99 -rfbport 5900 -forever -nopw -shared -q

echo "Xvfb :99 + x11vnc:5900 are running (transient units)."

cat <<EOF

================================================================
  REMAINING STEPS (manual)
================================================================

1) Add these to /etc/scraper-worker.env (the worker reads it via
   EnvironmentFile), then they apply on the next restart:

     DISPLAY=:99
     YELP_LISTING_SOURCE=relay
     YELP_PROXY_COUNTRY=US
     YELP_STICKY_SESSION=optirate-yelp
     YELP_DATADOME_COOKIE_FILE=$COOKIE

   KEEP the existing PLATFORM_EXCLUDE=facebook,instagram — do NOT add yelp;
   this box already claims yelp jobs, and now it can actually run them headed.
   (The Enigma RESIDENTIAL_PROXY_* vars are already in this file for FB/IG.)

2) Mint the DataDome cookie ONCE via noVNC:

     $REPO/scripts/ec2-expose-vnc.sh        # prints a public URL — open it
     # then, in another root shell on the box:
     cd $REPO
     DISPLAY=:99 YELP_STICKY_SESSION=optirate-yelp YELP_PROXY_COUNTRY=US \\
       python3 -m tools.scraper.mint_yelp_datadome
     # a Chrome window appears in the noVNC browser tab -> solve the slider.
     # cookie saves to $COOKIE
     sudo systemctl stop ec2-novnc ec2-cf-tunnel   # close the public exposure

3) VERIFY before touching the Windows box — run one real scrape headed/xvfb:

     cd $REPO
     DISPLAY=:99 YELP_LISTING_SOURCE=relay YELP_PROXY_COUNTRY=US \\
       YELP_STICKY_SESSION=optirate-yelp YELP_DATADOME_COOKIE_FILE=$COOKIE \\
       python3 -m tools.scraper.run --platform yelp --action list \\
         --filters '{"country":"US","category":"plumbers","max_rating":5.0,"min_review_count":1}' \\
         --max-results 6 --output /tmp/yelp_linux_smoke.json
     # PASS = real business rows in the JSON. FAIL = FAILED:listing|yelp|datadome_challenge
     #   -> xvfb reads as headless to DataDome on this box; keep Yelp on Windows.

4) Only if step 3 PASSES: restart the worker so it serves Yelp for all users:

     sudo systemctl restart scraper-worker.service
     journalctl -u scraper-worker.service -f    # watch it claim yelp jobs

5) Then pause the Windows box to stop paying for it (reversible):
     EC2 console -> select the Windows instance -> Instance state -> STOP
     (Start it again anytime to resume FB/IG; disk + profiles are preserved.)
================================================================
EOF
