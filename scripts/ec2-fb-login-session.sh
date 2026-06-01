#!/usr/bin/env bash
# One-time Facebook login session on the EC2 scraper worker.
# (Plan B, 2026-05-30.)
#
# Why this exists: every cross-machine cookie transplant we tried —
# log in on Windows, ship cookies to EC2 — landed on Facebook's
# "Continue / Use another profile / Password" trust gate. FB ties
# session trust to device fingerprint, not just IP, so cookies minted
# by a Windows Chrome fingerprint can't survive being injected into
# a Linux Chrome fingerprint on EC2 even when both go through the
# same PH residential proxy. The fix is to do the login ON the same
# Chrome that will do the scraping. This script gives the operator
# a remote-desktop view of that exact Chrome.
#
# WHAT IT DOES
#   1. Installs Xvfb + x11vnc + fluxbox once (idempotent).
#   2. Creates /srv/fb-profiles/<account_id>/ owned by the scraper user.
#   3. Starts a virtual display (:99) and a VNC server bound to
#      localhost:5900 (no password — exposed only via SSM tunnel).
#   4. Launches Chrome with --user-data-dir=$PROFILE through the
#      residential proxy (via selenium-wire — same TLS fingerprint
#      every later scrape will use).
#   5. Waits for the operator to close Chrome, then tears down
#      Xvfb + x11vnc.
#
# HOW THE OPERATOR USES IT
#   On EC2 (via SSM Session Manager):
#     sudo /opt/scraper/scripts/ec2-fb-login-session.sh <account_id>
#
#   On the operator's local machine, in another terminal:
#     aws ssm start-session \\
#       --target i-0188e136ef92d0c07 \\
#       --document-name AWS-StartPortForwardingSession \\
#       --parameters '{"portNumber":["5900"],"localPortNumber":["5900"]}'
#
#   Then open any VNC client (TightVNC / RealVNC / macOS Screen Sharing)
#   at 127.0.0.1:5900 — no password. You'll see the Chrome window on
#   EC2. Log into Facebook. Close the Chrome window when done. The
#   profile dir is flushed to disk and reused by every later scrape.
#
# IDEMPOTENCY
#   Running twice is safe — any prior Xvfb/x11vnc/Chrome on :99 is
#   killed before the new ones start. Re-running for the SAME
#   account_id reuses the existing profile (operator can re-login
#   after a captcha without losing the profile state).

set -euo pipefail

ACCOUNT_ID="${1:-}"
if [[ -z "$ACCOUNT_ID" ]]; then
    cat >&2 <<EOF
Usage: $0 <account_id>

Example:
  sudo $0 0eec969c-a888-4e54-bdfe-057ca11c2af5

The account_id must match the social_accounts.id of the FB account
to log in. The profile is saved to /srv/fb-profiles/<account_id>/
and reused by every later scrape that sets FB_PROFILE_DIR to that path.
EOF
    exit 1
fi

# UUID sanity — refuse to make /srv/fb-profiles/random-string dirs.
if ! [[ "$ACCOUNT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: account_id must be a UUID (got: $ACCOUNT_ID)" >&2
    exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: must be run as root (use sudo)" >&2
    exit 1
fi

SCRAPER_USER="${SCRAPER_USER:-scraper}"
REPO_DIR="${REPO_DIR:-/opt/scraper}"
PROFILE_DIR="/srv/fb-profiles/${ACCOUNT_ID}"
DISPLAY_NUM=":99"
VNC_PORT="${VNC_PORT:-5900}"
LOG_DIR="/var/log/scraper-fb-login"

mkdir -p "$LOG_DIR"
# The log dir is created by root (the script's effective UID via sudo)
# but the Xvfb / fluxbox / x11vnc processes drop to the scraper user
# below and need to write inside this dir. Without this chown, the
# script exits silently because x11vnc fails to open its log file and
# the port-5900 sanity check immediately fires.
chown "$SCRAPER_USER:$SCRAPER_USER" "$LOG_DIR"

# Install OS-level deps once.
NEEDED=()
for pkg in xvfb x11vnc fluxbox; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        NEEDED+=("$pkg")
    fi
done
if [[ ${#NEEDED[@]} -gt 0 ]]; then
    echo "INFO: installing ${NEEDED[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${NEEDED[@]}"
fi

# Profile dir.
mkdir -p "$PROFILE_DIR"
chown -R "$SCRAPER_USER:$SCRAPER_USER" /srv/fb-profiles
chmod 700 "$PROFILE_DIR"

# Kill any stale processes on :99 / port 5900. -f matches the cmdline
# so we don't blast unrelated x11vnc / Xvfb instances on other displays.
pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null || true
pkill -f "x11vnc.*-rfbport $VNC_PORT" 2>/dev/null || true
pkill -f "fluxbox.*DISPLAY=$DISPLAY_NUM" 2>/dev/null || true
# Don't kill chrome processes by name globally — would nuke the
# scraper-worker's own Chrome. We only kill chromes that were spawned
# against THIS display, identified by the user-data-dir flag.
pkill -f "user-data-dir=$PROFILE_DIR" 2>/dev/null || true
sleep 1

# Start Xvfb as the scraper user (matching ownership avoids permission
# weirdness with the Chrome socket file).
echo "INFO: starting Xvfb on display $DISPLAY_NUM"
sudo -u "$SCRAPER_USER" -- bash -c \
    "nohup Xvfb $DISPLAY_NUM -screen 0 1280x900x24 >$LOG_DIR/xvfb.log 2>&1 &"
sleep 2

# Minimal window manager so Chrome window is movable / closable.
echo "INFO: starting fluxbox on display $DISPLAY_NUM"
sudo -u "$SCRAPER_USER" -- bash -c \
    "DISPLAY=$DISPLAY_NUM nohup fluxbox >$LOG_DIR/fluxbox.log 2>&1 &"
sleep 1

# VNC server bound to localhost ONLY. Public exposure of an unauthed
# VNC would be a disaster — but localhost-only behind SSM tunnel is
# fine because SSM authenticates the tunnel via IAM.
echo "INFO: starting x11vnc on 127.0.0.1:$VNC_PORT (localhost only — SSM tunnel required)"
sudo -u "$SCRAPER_USER" -- x11vnc \
    -display "$DISPLAY_NUM" \
    -localhost \
    -nopw \
    -listen 127.0.0.1 \
    -rfbport "$VNC_PORT" \
    -shared \
    -forever \
    -bg \
    -o "$LOG_DIR/x11vnc.log"
sleep 1

# Sanity: confirm x11vnc came up.
if ! ss -tln | awk '{print $4}' | grep -q "127.0.0.1:$VNC_PORT"; then
    echo "ERROR: x11vnc failed to bind 127.0.0.1:$VNC_PORT — see $LOG_DIR/x11vnc.log" >&2
    exit 1
fi

# Load proxy creds from the worker's env file (same file
# /etc/systemd/system/scraper-worker.service.d/override.conf reads).
ENV_FILE="${ENV_FILE:-/etc/scraper-worker.env}"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found — set RESIDENTIAL_PROXY_* env vars first" >&2
    exit 1
fi

cat >&2 <<EOF

────────────────────────────────────────────────────────────────────
  READY — connect from your local machine now:

  1) In a new terminal on your LOCAL machine, start the SSM tunnel:

       aws ssm start-session \\
         --target i-0188e136ef92d0c07 \\
         --document-name AWS-StartPortForwardingSession \\
         --parameters '{"portNumber":["$VNC_PORT"],"localPortNumber":["$VNC_PORT"]}'

  2) Open a VNC client and connect to: 127.0.0.1:$VNC_PORT
       - Windows:  TightVNC Viewer or RealVNC Viewer
       - macOS:    Finder → Go → Connect to Server → vnc://127.0.0.1:$VNC_PORT
       - Linux:    remmina / vinagre — protocol VNC

  3) Chrome will open inside the VNC view, routed through Proxy Lite PH.
     Log in to Facebook normally. Resolve any captcha / 2FA there.

  4) When the homepage loads and looks right, CLOSE THE CHROME WINDOW.
     The profile saves to disk; this script exits.

  Profile dir: $PROFILE_DIR
────────────────────────────────────────────────────────────────────

EOF

# Hand off to the Python interactive driver. Run as the scraper user so
# the profile dir ends up owned by scraper. Source the env file inside
# the sudo'd shell so RESIDENTIAL_PROXY_* makes it through.
cd "$REPO_DIR"
sudo -u "$SCRAPER_USER" -- bash -c "
    set -a
    source '$ENV_FILE'
    set +a
    export DISPLAY=$DISPLAY_NUM
    export FB_PROFILE_DIR='$PROFILE_DIR'
    export FB_PROFILE_HEADFUL=true
    export RESIDENTIAL_PROXY_FORCE=true
    cd '$REPO_DIR'
    '$REPO_DIR/.venv/bin/python' -m tools.scraper.shared.interactive_login
"

echo "INFO: interactive login finished — tearing down Xvfb / x11vnc"
pkill -f "x11vnc.*-rfbport $VNC_PORT" 2>/dev/null || true
pkill -f "fluxbox.*DISPLAY=$DISPLAY_NUM" 2>/dev/null || true
pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null || true

echo "INFO: done. Profile lives at $PROFILE_DIR (owned by $SCRAPER_USER)."
echo "INFO: every scrape that sets FB_PROFILE_DIR=$PROFILE_DIR will reuse it."
