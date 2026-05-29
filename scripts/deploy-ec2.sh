#!/usr/bin/env bash
# Idempotent EC2 scraper-worker deploy. Designed to run from root cron every
# 5 minutes. Cheap path is <1s when origin/main hasn't moved (the 99% case).
#
# CHEAP PATH (no new commits)
#   1. `git fetch origin main`         (network: ~10 KB)
#   2. compare local HEAD vs origin    (CPU: microseconds)
#   3. exit 0, no log written
#
# SLOW PATH (new commits detected)
#   1. mark the target commit as `attempted` (so a buggy build doesn't retry
#      every 5 minutes — only re-tried after origin moves past it)
#   2. `git pull --ff-only origin main`
#   3. `npm ci --no-audit --no-fund` in server/
#   4. `npm run build`  (tsc → server/dist/)
#   5. `systemctl restart scraper-worker.service`
#   6. verify the unit returned to `active` state, log SUCCESS or FAILED
#
# SAFETY
#   - `set -euo pipefail` aborts on any non-zero exit. If the build fails, the
#     restart never runs and the worker keeps serving the old in-memory code.
#   - `flock` serializes — concurrent cron ticks can't stomp each other.
#   - `--ff-only` refuses to pull if local has diverged.
#   - The Supabase queue (migration 030) has a 10-minute stale-claim sweeper,
#     so any scrape killed mid-flight by the restart gets re-queued
#     automatically.
#
# FILES
#   /var/log/scraper-deploy.log               append-only timestamped log
#   /var/lib/scraper-deploy/last_attempted_commit   anti-spam marker
#   /var/lock/scraper-deploy.lock             flock target
#
# MANUAL TRIGGER (e.g. SSM session)
#   sudo /opt/scraper/scripts/deploy-ec2.sh
#
# FORCE RETRY OF A FAILED COMMIT
#   sudo rm /var/lib/scraper-deploy/last_attempted_commit
#   sudo /opt/scraper/scripts/deploy-ec2.sh

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/scraper}"
SCRAPER_USER="${SCRAPER_USER:-scraper}"
SERVICE_NAME="${SERVICE_NAME:-scraper-worker.service}"
LOG_FILE="${LOG_FILE:-/var/log/scraper-deploy.log}"
LOCK_FILE="${LOCK_FILE:-/var/lock/scraper-deploy.lock}"
STATE_DIR="${STATE_DIR:-/var/lib/scraper-deploy}"
ATTEMPTED_FILE="$STATE_DIR/last_attempted_commit"

# Lock — silent exit if another deploy is already in progress.
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

log() {
    printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"
}

git_as_scraper() {
    sudo -u "$SCRAPER_USER" git -C "$REPO_DIR" "$@"
}

# Cheap path: any new commits on origin/main?
git_as_scraper fetch origin main --quiet
LOCAL=$(git_as_scraper rev-parse HEAD)
REMOTE=$(git_as_scraper rev-parse origin/main)

if [[ "$LOCAL" == "$REMOTE" ]]; then
    exit 0
fi

# Anti-spam: don't retry a commit we already attempted (succeeded or failed)
# until origin moves past it. Operator: see header comment to force a retry.
mkdir -p "$STATE_DIR"
if [[ -f "$ATTEMPTED_FILE" ]] && [[ "$(cat "$ATTEMPTED_FILE")" == "$REMOTE" ]]; then
    exit 0
fi
echo "$REMOTE" > "$ATTEMPTED_FILE"

# Defer deploy if the worker is mid-scrape. Restarting now would SIGTERM
# the worker, which kills the Python subprocesses doing the actual scrapes,
# which makes the active job die with "Script exited with code null". The
# next cron tick (5 min later) will pick this commit up.
#
# Safety override: if any in-flight job has been running >45 min, assume
# it's stuck and proceed with the deploy anyway. 45m > the typical TA city
# fan-out (~10 min) and Yelp 25-profile enrichment (~8 min).
#
# Hits the Supabase REST API directly so we don't need a Node runtime to
# query it. Credentials live in /etc/scraper-worker.env (read by the unit).
if [[ -f /etc/scraper-worker.env ]]; then
    # shellcheck disable=SC1091
    set -a; source /etc/scraper-worker.env; set +a
fi
if [[ -n "${SUPABASE_URL:-}" ]] && [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    BUSY_JSON=$(curl -fsS \
        -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        "$SUPABASE_URL/rest/v1/scrape_jobs?select=id,started_at&status=eq.running&worker_id=eq.ec2-sg-1" 2>>"$LOG_FILE" || echo '[]')
    # grep exits 1 when there are no matches and `set -o pipefail` would
    # then propagate that into the command substitution, tripping `set -e`
    # and silently aborting the whole deploy. The `|| true` swallows
    # grep's no-match exit so an EMPTY busy-job list correctly reads as
    # BUSY_COUNT=0 instead of silently killing the script. This bit us
    # for 4 days (2026-05-25 → 2026-05-29): every cron tick after the
    # last running job finished hit this same exit and bailed without
    # logging a thing, freezing EC2 on stale code.
    BUSY_COUNT=$(echo "$BUSY_JSON" | { grep -o '"id"' || true; } | wc -l)
    if [[ "$BUSY_COUNT" -gt 0 ]]; then
        # Check oldest started_at against the 45-min override
        OLDEST_START=$(echo "$BUSY_JSON" | grep -oE '"started_at":"[^"]+"' | sed 's/.*:"//;s/"//' | sort | head -1)
        if [[ -n "$OLDEST_START" ]]; then
            OLDEST_EPOCH=$(date -u -d "$OLDEST_START" +%s 2>/dev/null || echo 0)
            NOW_EPOCH=$(date -u +%s)
            AGE_MIN=$(( (NOW_EPOCH - OLDEST_EPOCH) / 60 ))
            if [[ "$AGE_MIN" -lt 45 ]]; then
                log "=== deploy DEFERRED: $BUSY_COUNT job(s) running (oldest ${AGE_MIN}m old, override at 45m); will retry next tick ==="
                # Roll back the attempted-marker so the next tick re-tries
                # this same commit instead of skipping it.
                rm -f "$ATTEMPTED_FILE"
                exit 0
            fi
            log "deploy proceeding despite $BUSY_COUNT busy job(s) — oldest is ${AGE_MIN}m old (>=45m override)"
        fi
    fi
fi

log "=== deploy starting: $LOCAL -> $REMOTE ==="

log "git pull --ff-only..."
git_as_scraper pull --ff-only origin main >> "$LOG_FILE" 2>&1

log "npm ci..."
sudo -u "$SCRAPER_USER" bash -c "cd '$REPO_DIR/server' && npm ci --no-audit --no-fund" >> "$LOG_FILE" 2>&1

log "npm run build..."
sudo -u "$SCRAPER_USER" bash -c "cd '$REPO_DIR/server' && npm run build" >> "$LOG_FILE" 2>&1

# Keep the Python venv in sync with requirements.txt. Idempotent — pip
# no-ops on packages already at the requested version. If the venv path
# doesn't exist (fresh box), skip silently and let an operator bootstrap
# it manually.
if [[ -x "$REPO_DIR/.venv/bin/pip" ]]; then
    log "pip install -r requirements.txt..."
    sudo -u "$SCRAPER_USER" "$REPO_DIR/.venv/bin/pip" install --quiet --disable-pip-version-check -r "$REPO_DIR/requirements.txt" >> "$LOG_FILE" 2>&1
fi

log "systemctl restart $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME"

# Confirm the unit returned to active state. Worker has up to 60s graceful
# drain on SIGTERM, but systemctl restart blocks until the new process is up.
sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
    NEW_PID=$(systemctl show -p MainPID --value "$SERVICE_NAME")
    log "=== deploy SUCCESS: now at $REMOTE (PID=$NEW_PID) ==="
else
    log "=== deploy FAILED: $SERVICE_NAME did not return to active state ==="
    systemctl status "$SERVICE_NAME" --no-pager >> "$LOG_FILE" 2>&1 || true
    exit 1
fi
