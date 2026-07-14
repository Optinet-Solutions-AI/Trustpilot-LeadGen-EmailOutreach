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
#    fluxbox: a real window manager on :99 so Chrome windows are managed
#    (focus/decorations) like a desktop — bare Xvfb with no WM is a DataDome
#    headless tell.
NEEDED=()
for p in xvfb x11vnc fluxbox; do dpkg -s "$p" >/dev/null 2>&1 || NEEDED+=("$p"); done
if [[ ${#NEEDED[@]} -gt 0 ]]; then apt-get update -qq; apt-get install -y "${NEEDED[@]}"; fi
if ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
    echo "Installing google-chrome-stable..."
    wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y /tmp/chrome.deb
fi

# 2. Xvfb :99 (1920x1080x24) + fluxbox WM + x11vnc:5900 as transient units.
#    Screen depth 24 at a real desktop resolution; a managed WM + software WebGL
#    (YELP_RELAY_SOFTWARE_GL=true, see step 1) are what make DataDome offer a
#    SOLVABLE slider instead of a HARD-BLOCK on this GPU-less box.
for u in yelp-xvfb yelp-fluxbox yelp-x11vnc; do
    systemctl stop "$u" 2>/dev/null || true
    systemctl reset-failed "$u" 2>/dev/null || true
done
systemd-run --unit=yelp-xvfb --description="Xvfb :99 for Yelp headed scraping" \
    -- /usr/bin/Xvfb :99 -screen 0 1920x1080x24
sleep 1
systemd-run --unit=yelp-fluxbox --description="fluxbox WM on :99 (managed windows)" \
    --setenv=DISPLAY=:99 -- /usr/bin/fluxbox
sleep 1
systemd-run --unit=yelp-x11vnc --description="x11vnc mirror of :99 -> 5900" \
    -- /usr/bin/x11vnc -display :99 -rfbport 5900 -forever -nopw -shared -q

echo "Xvfb :99 (1920x1080x24) + fluxbox + x11vnc:5900 are running (transient units)."

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
     YELP_RELAY_SOFTWARE_GL=true        # <-- REQUIRED on this GPU-less box:
                                        #     software WebGL so DataDome sees a
                                        #     real renderer, not a headless null.

   KEEP the existing PLATFORM_EXCLUDE=facebook,instagram — do NOT add yelp;
   this box already claims yelp jobs, and now it can actually run them headed.
   (The Enigma RESIDENTIAL_PROXY_* vars are already in this file for FB/IG.)

2) VERIFY software WebGL renders BEFORE minting (fast sanity check):

     cd $REPO
     DISPLAY=:99 python3 -m tools.scraper.verify_webgl
     # PASS = renderer contains 'SwiftShader'/'ANGLE'. FAIL = null renderer ->
     #   fix flags/WM before continuing (a null renderer WILL hard-block).

3) Mint the DataDome cookie ONCE via noVNC (software_gl ON so the cookie is
   minted under the SAME fingerprint the scraper replays):

     $REPO/scripts/ec2-expose-vnc.sh        # prints a public URL — open it
     # then, in another root shell on the box:
     cd $REPO
     DISPLAY=:99 YELP_RELAY_SOFTWARE_GL=true YELP_STICKY_SESSION=optirate-yelp \\
       YELP_PROXY_COUNTRY=US python3 -m tools.scraper.mint_yelp_datadome
     # a Chrome window appears in the noVNC tab. EXPECTATION AFTER THIS HARDENING:
     #   a SOLVABLE DataDome slider -> drag it. (Before the fix this box got a
     #   HARD-BLOCK page "Something is preventing JavaScript..." with no slider;
     #   if you STILL see that, the fingerprint work did not take — capture the
     #   block page and report, do NOT stop the Windows box.)
     # cookie saves to $COOKIE
     sudo systemctl stop ec2-novnc ec2-cf-tunnel   # close the public exposure

4) VERIFY before touching the Windows box — run one real scrape headed/xvfb:

     cd $REPO
     DISPLAY=:99 YELP_LISTING_SOURCE=relay YELP_RELAY_SOFTWARE_GL=true \\
       YELP_PROXY_COUNTRY=US YELP_STICKY_SESSION=optirate-yelp \\
       YELP_DATADOME_COOKIE_FILE=$COOKIE \\
       python3 -m tools.scraper.run --platform yelp --action list \\
         --filters '{"country":"US","category":"plumbers","max_rating":5.0,"min_review_count":1}' \\
         --max-results 6 --output /tmp/yelp_linux_smoke.json
     # PASS = real business rows in the JSON. FAIL = FAILED:listing|yelp|datadome_challenge
     #   -> xvfb still reads as headless to DataDome on this box; keep Yelp on Windows.

5) Only if step 4 PASSES: restart the worker so it serves Yelp for all users:

     sudo systemctl restart scraper-worker.service
     journalctl -u scraper-worker.service -f    # watch it claim yelp jobs

6) Then pause the Windows box to stop paying for it (reversible):
     EC2 console -> select the Windows instance -> Instance state -> STOP
     (Start it again anytime to resume FB/IG; disk + profiles are preserved.)
================================================================
EOF
