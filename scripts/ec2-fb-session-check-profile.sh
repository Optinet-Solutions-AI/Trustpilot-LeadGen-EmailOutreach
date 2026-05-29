#!/usr/bin/env bash
# Diagnostic: prove a persistent FB Chrome profile (minted by
# scripts/ec2-fb-login-session.sh) yields a real logged-in homepage
# when reused by HEADLESS Chrome through the residential proxy.
#
# Pass: title="Facebook" and body contains feed-y elements ("What's
#       on your mind", "Friends", etc.); no "Password" / "Continue
#       as <name>" / "Use another profile".
# Fail: body still shows the trust gate / profile picker / password
#       prompt — means the profile didn't survive cross-headless
#       reuse and we need to investigate fingerprint divergence.
#
# Usage (run as root via sudo from SSM):
#   sudo /opt/scraper/scripts/ec2-fb-session-check-profile.sh <account_id>

set -euo pipefail

ACCOUNT_ID="${1:-}"
if [[ -z "$ACCOUNT_ID" ]]; then
    echo "Usage: $0 <account_id>" >&2
    exit 1
fi

PROFILE_DIR="/srv/fb-profiles/${ACCOUNT_ID}"
if [[ ! -d "$PROFILE_DIR" ]]; then
    echo "ERROR: profile not found at $PROFILE_DIR — run ec2-fb-login-session.sh first" >&2
    exit 1
fi

SCRAPER_USER="${SCRAPER_USER:-scraper}"
REPO_DIR="${REPO_DIR:-/opt/scraper}"
ENV_FILE="${ENV_FILE:-/etc/scraper-worker.env}"

cd "$REPO_DIR"

sudo -u "$SCRAPER_USER" -- bash -c "
    set -a
    source '$ENV_FILE'
    set +a
    export FB_PROFILE_DIR='$PROFILE_DIR'
    export PLAYWRIGHT_HEADLESS=true
    export RESIDENTIAL_PROXY_FORCE=true
    cd '$REPO_DIR'
    '$REPO_DIR/.venv/bin/python' <<'PYEOF'
import sys, time
from tools.scraper.platforms import facebook as fb

# Anchor location to the same region the login was done in (PH today).
fb._CURRENT_LOCATION = 'Cebu'
driver = fb._open_driver()
try:
    driver.get('https://www.facebook.com/')
    time.sleep(8)
    print('POST-SESSION URL:', driver.current_url)
    print('TITLE:', driver.title)
    body = driver.find_element('tag name', 'body').text
    print('BODY (first 800):')
    print(body[:800])
finally:
    driver.quit()
PYEOF
"
