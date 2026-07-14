#!/usr/bin/env bash
# One-command Yelp mint-then-batch for the Linux xvfb box (operating model "A").
#
# The DataDome cookie only holds ~10 min on the sticky Enigma IP, so Yelp
# discovery is run as a deliberate batch: mint a fresh cookie (you solve ONE
# slider via noVNC), then immediately scrape — both on the same held IP.
#
#   sudo /opt/scraper/scripts/yelp-mint-and-scrape.sh US plumbers 40
#
# Args:  COUNTRY  CATEGORY  [MAX_RESULTS=40]
#
# Produces a listing JSON in /tmp. Enrich + DB upsert follow the normal path
# (ScrapingBee /biz enrichment works anywhere) — this script covers the part
# that DataDome gates: the server-side /search listing.

set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "ERROR: run as root (sudo)" >&2; exit 1; }

COUNTRY="${1:?usage: yelp-mint-and-scrape.sh COUNTRY CATEGORY [MAX_RESULTS]}"
CATEGORY="${2:?usage: yelp-mint-and-scrape.sh COUNTRY CATEGORY [MAX_RESULTS]}"
MAXRES="${3:-40}"

REPO="${REPO:-/opt/scraper}"
PY="$REPO/.venv/bin/python"
SESSION="${YELP_STICKY_SESSION:-optirate-yelp}"
COOKIE="$REPO/tools/scraper/data/yelp_datadome_cookie.json"
OUT="/tmp/yelp_${COUNTRY}_${CATEGORY}_$(date +%s).json"

cd "$REPO"
set -a; source /etc/scraper-worker.env; set +a
export DISPLAY=:99 YELP_RELAY_SOFTWARE_GL=true YELP_PROXY_COUNTRY="$COUNTRY" YELP_STICKY_SESSION="$SESSION"

# Ensure Xvfb :99 + fluxbox + x11vnc are up (idempotent).
"$REPO/scripts/ec2-linux-yelp-setup.sh" >/dev/null 2>&1 || true

echo "=============================================================="
echo " STEP 1/3 — opening noVNC tunnel. Open the URL below, click"
echo "            Connect, and be ready to solve ONE DataDome slider."
echo "=============================================================="
"$REPO/scripts/ec2-expose-vnc.sh"

echo "=============================================================="
echo " STEP 2/3 — minting the DataDome cookie. SOLVE THE SLIDER in"
echo "            the noVNC browser tab when it appears."
echo "=============================================================="
"$PY" -m tools.scraper.mint_yelp_datadome

echo "=============================================================="
echo " STEP 3/3 — scraping $CATEGORY in $COUNTRY on the held IP..."
echo "=============================================================="
YELP_LISTING_SOURCE=relay YELP_DATADOME_COOKIE_FILE="$COOKIE" \
  "$PY" -m tools.scraper.run --platform yelp --action list \
    --filters "{\"country\":\"$COUNTRY\",\"category\":\"$CATEGORY\",\"max_rating\":5.0,\"min_review_count\":1}" \
    --max-results "$MAXRES" --output "$OUT"

echo "=============================================================="
echo " DONE — listing rows written to: $OUT"
echo " (Enrich + upsert to the CRM follow the normal path.)"
echo "=============================================================="

# Close the public exposure.
systemctl stop ec2-novnc ec2-cf-tunnel 2>/dev/null || true
