-- ============================================================
-- 030_scraper_worker_queue.sql
-- Turns scrape_jobs into a proper queue for the remote EC2 worker.
-- Adds claim ownership, retry budget, priority. Two RPCs do the
-- atomic FOR UPDATE SKIP LOCKED claim + stale-claim sweep that
-- supabase-js can't express directly.
-- ============================================================

-- ── Columns (additive — existing data untouched) ─────────────
ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS worker_id    text,
  ADD COLUMN IF NOT EXISTS claimed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS attempts     int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts int  NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS priority     int  NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS last_error   text;

-- Hot path: workers dequeue by priority then age
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_pending_priority
  ON scrape_jobs (priority, created_at)
  WHERE status = 'pending';

-- Sweep helper: find running jobs with stale heartbeats
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_running_heartbeat
  ON scrape_jobs (last_heartbeat_at)
  WHERE status = 'running';

-- Inspect ownership quickly
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_worker_running
  ON scrape_jobs (worker_id)
  WHERE status = 'running';

-- ============================================================
-- RPC: claim_next_pending_scrape_job
-- Atomically claims one pending job for the calling worker
-- using FOR UPDATE SKIP LOCKED. Hard-caps the calling worker
-- at p_max_concurrent in-flight jobs as a defense-in-depth
-- backstop to the in-process semaphore. Returns NULL when the
-- queue is empty or the cap is reached.
-- ============================================================
-- Returns SETOF (not single composite) so the "empty queue" case is an
-- empty result set, not a row-of-NULLs. The previous RETURNS scrape_jobs
-- shape made supabase-js unwrap a NULL composite into {id: null, ...},
-- which the worker treated as a valid claim and then crashed on the null
-- UUID. SETOF makes the empty case unambiguous on the wire.
--
-- DROP is required because CREATE OR REPLACE cannot change a function's
-- return type. Safe to re-run: the function is recreated immediately below.
DROP FUNCTION IF EXISTS claim_next_pending_scrape_job(text, int);

CREATE OR REPLACE FUNCTION claim_next_pending_scrape_job(
  p_worker_id     text,
  p_max_concurrent int DEFAULT 3
)
RETURNS SETOF scrape_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_flight int;
BEGIN
  -- Defense-in-depth cap: refuse to claim if this worker already
  -- holds p_max_concurrent running jobs. The worker also enforces
  -- this with an in-process semaphore.
  SELECT count(*) INTO v_in_flight
    FROM scrape_jobs
   WHERE status = 'running' AND worker_id = p_worker_id;

  IF v_in_flight >= p_max_concurrent THEN
    RETURN;  -- empty SETOF, supabase-js sees data: []
  END IF;

  -- Atomic claim. The inner SELECT locks one pending row and
  -- skips rows another worker has already locked.
  RETURN QUERY
    UPDATE scrape_jobs
       SET status            = 'running',
           worker_id         = p_worker_id,
           claimed_at        = now(),
           last_heartbeat_at = now(),
           attempts          = scrape_jobs.attempts + 1,
           started_at        = COALESCE(scrape_jobs.started_at, now())
     WHERE id = (
       SELECT id FROM scrape_jobs
        WHERE status = 'pending'
          AND attempts < max_attempts
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *;
END;
$$;

-- ============================================================
-- RPC: release_stale_scrape_claims
-- Called periodically by the Cloud Run scheduler tick. Any job
-- whose last_heartbeat_at is older than p_max_age_min minutes is
-- presumed dead. If it still has retry budget it goes back to
-- 'pending'; otherwise it is marked 'failed' permanently.
-- Returns the count of rows touched.
-- ============================================================
CREATE OR REPLACE FUNCTION release_stale_scrape_claims(
  p_max_age_min int DEFAULT 10
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_requeued int := 0;
  v_failed   int := 0;
  v_cutoff   timestamptz := now() - (p_max_age_min || ' minutes')::interval;
BEGIN
  -- Requeue stale claims that still have retry budget
  WITH requeued AS (
    UPDATE scrape_jobs
       SET status     = 'pending',
           worker_id  = NULL,
           claimed_at = NULL,
           last_error = COALESCE(last_error, 'Worker heartbeat went stale; requeued')
     WHERE status = 'running'
       AND last_heartbeat_at < v_cutoff
       AND attempts < max_attempts
    RETURNING id
  )
  SELECT count(*) INTO v_requeued FROM requeued;

  -- Mark permanently failed if retry budget exhausted
  WITH gave_up AS (
    UPDATE scrape_jobs
       SET status       = 'failed',
           completed_at = COALESCE(completed_at, now()),
           error        = COALESCE(error, 'Max attempts exceeded after stale heartbeat')
     WHERE status = 'running'
       AND last_heartbeat_at < v_cutoff
       AND attempts >= max_attempts
    RETURNING id
  )
  SELECT count(*) INTO v_failed FROM gave_up;

  RETURN v_requeued + v_failed;
END;
$$;
