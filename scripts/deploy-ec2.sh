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

log "=== deploy starting: $LOCAL -> $REMOTE ==="

log "git pull --ff-only..."
git_as_scraper pull --ff-only origin main >> "$LOG_FILE" 2>&1

log "npm ci..."
sudo -u "$SCRAPER_USER" bash -c "cd '$REPO_DIR/server' && npm ci --no-audit --no-fund" >> "$LOG_FILE" 2>&1

log "npm run build..."
sudo -u "$SCRAPER_USER" bash -c "cd '$REPO_DIR/server' && npm run build" >> "$LOG_FILE" 2>&1

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
