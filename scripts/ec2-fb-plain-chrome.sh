#!/usr/bin/env bash
# Launch a plain headful Chrome on EC2's existing Xvfb (:99) for
# operator-driven Facebook login, bypassing all selenium-wire and
# undetected-chromedriver instrumentation that FB's anti-bot pipeline
# flags. The operator drives it via the already-running noVNC tab.
#
# Why this exists: even with cookies minted on the same EC2 Chrome,
# FB invalidates sessions whose JS context contains automation signals
# (navigator.webdriver, --test-type, chrome.runtime hooks left by
# undetected-chromedriver, selenium-wire's MITM TLS fingerprint).
# This script removes ALL of that — it's literally `google-chrome`
# with --user-data-dir and --proxy-server, nothing else.
#
# Proxy authentication uses a generated Manifest V3 extension that
# auto-fills proxy credentials via chrome.webRequest.onAuthRequired.
# More reliable than Chrome's basic-auth dialog (some Chrome versions
# suppress it).
#
# Usage (run as root):
#   sudo /opt/scraper/scripts/ec2-fb-plain-chrome.sh <account_id> [--clean]
#
# --clean wipes the profile dir first (use when prior selenium-wire
# sessions left a polluted profile).
#
# Prereqs:
#   - Xvfb is running on :99 (ec2-fb-login-session.sh started it)
#   - x11vnc is bound on 127.0.0.1:5900
#   - noVNC + cloudflared expose 5900 publicly (ec2-expose-vnc.sh)
#   - /etc/scraper-worker.env has RESIDENTIAL_PROXY_* (Enigma PH today)

set -euo pipefail

ACCOUNT_ID="${1:?Usage: $0 <account_id> [--clean]}"
CLEAN_MODE=""
if [[ "${2:-}" == "--clean" ]]; then
    CLEAN_MODE=1
fi

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: must run as root (use sudo)" >&2
    exit 1
fi

if ! [[ "$ACCOUNT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: account_id must be a UUID" >&2
    exit 1
fi

SCRAPER_USER="${SCRAPER_USER:-scraper}"
PROFILE_DIR="/srv/fb-profiles/${ACCOUNT_ID}"
EXT_DIR="/srv/fb-profiles/${ACCOUNT_ID}-proxy-auth-ext"
DISPLAY_NUM=":99"
ENV_FILE="${ENV_FILE:-/etc/scraper-worker.env}"

# Load proxy creds.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${RESIDENTIAL_PROXY_HOST:?must be in $ENV_FILE}"
: "${RESIDENTIAL_PROXY_PORT:?must be in $ENV_FILE}"
: "${RESIDENTIAL_PROXY_USERNAME:?must be in $ENV_FILE}"
: "${RESIDENTIAL_PROXY_PASSWORD:?must be in $ENV_FILE}"

# Sanity: Xvfb must be running on :99.
if ! pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null; then
    echo "ERROR: no Xvfb on $DISPLAY_NUM. Run ec2-fb-login-session.sh first to start the display." >&2
    exit 1
fi

# Kill any existing Chrome on this profile dir (selenium or plain).
pkill -f "user-data-dir=$PROFILE_DIR" 2>/dev/null || true
pkill -f "interactive_login" 2>/dev/null || true
sleep 2

# Clean the profile if requested.
if [[ -n "$CLEAN_MODE" ]]; then
    echo "INFO: wiping profile dir for fresh login"
    rm -rf "$PROFILE_DIR"
fi

mkdir -p "$PROFILE_DIR"
chown -R "$SCRAPER_USER:$SCRAPER_USER" "$PROFILE_DIR"

# Generate a tiny MV3 extension that auto-fills the proxy basic-auth
# challenge so Chrome doesn't have to pop a dialog. The extension is
# regenerated each run so credentials stay current.
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"

cat > "$EXT_DIR/manifest.json" <<EOF
{
  "manifest_version": 2,
  "name": "fb-proxy-auth",
  "version": "1.0",
  "permissions": ["proxy", "webRequest", "webRequestBlocking", "<all_urls>"],
  "background": { "scripts": ["background.js"], "persistent": true }
}
EOF
# MV2 instead of MV3 because MV3 dropped blocking webRequest, and we
# need the synchronous callback to inject proxy credentials. Chrome's
# WebStore stopped accepting new MV2 uploads, but local extensions
# loaded via --load-extension still work in Chrome 148.

cat > "$EXT_DIR/background.js" <<EOF
chrome.webRequest.onAuthRequired.addListener(
  function(details) {
    if (details.isProxy) {
      return {
        authCredentials: {
          username: "${RESIDENTIAL_PROXY_USERNAME}",
          password: "${RESIDENTIAL_PROXY_PASSWORD}"
        }
      };
    }
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);
EOF

chown -R "$SCRAPER_USER:$SCRAPER_USER" "$EXT_DIR"

# Launch plain headful Chrome on the existing Xvfb. Drop ALL selenium
# / undetected-chromedriver flags. Land on facebook.com (not /login)
# so if cookies are valid it loads the homepage directly.
#
# CRITICAL: -E here would preserve root's HOME=/root from the sudo
# elevation, and Chrome would crash trying to write
# /root/.local/share/applications/mimeapps.list. Instead, omit -E and
# explicitly export the variables we need so HOME defaults to the
# scraper user's actual home (~/home/scraper).
SCRAPER_HOME=$(getent passwd "$SCRAPER_USER" | cut -d: -f6)
sudo -u "$SCRAPER_USER" \
    DISPLAY="$DISPLAY_NUM" \
    HOME="$SCRAPER_HOME" \
    XDG_RUNTIME_DIR="/run/user/$(id -u "$SCRAPER_USER")" \
    nohup google-chrome \
    --user-data-dir="$PROFILE_DIR" \
    --proxy-server="http://${RESIDENTIAL_PROXY_HOST}:${RESIDENTIAL_PROXY_PORT}" \
    --load-extension="$EXT_DIR" \
    --no-default-browser-check \
    --no-first-run \
    --window-size=1280,900 \
    --lang=en-US,en \
    https://www.facebook.com/ \
    > /tmp/chrome-plain.log 2>&1 &

sleep 3
PID=$(pgrep -f "user-data-dir=$PROFILE_DIR" | head -1)

cat <<EOF

==============================================================
  Plain Chrome launched on Xvfb :99 (PID ${PID:-?})
  - Profile: $PROFILE_DIR
  - Proxy:   ${RESIDENTIAL_PROXY_HOST}:${RESIDENTIAL_PROXY_PORT}
  - Proxy auth: handled by MV3 extension at $EXT_DIR
  - Initial URL: https://www.facebook.com/ (not /login — so valid
    cookies skip the form)

  Switch to your noVNC browser tab. You should see facebook.com
  loading. If you're already logged in, you'll see the homepage —
  done. If you see the login form, enter credentials and submit.

  When the homepage looks right, CLOSE Chrome (X button on Chrome
  window) — the profile saves to disk.
==============================================================

EOF
