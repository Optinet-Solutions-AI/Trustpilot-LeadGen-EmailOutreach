-- ============================================================
-- Migration 043: platform filtering on claim_next_pending_scrape_job
-- ============================================================
-- Once a Windows EC2 worker joins the pool alongside the existing
-- Linux EC2, both workers race for the SAME jobs. Linux can't run
-- Facebook scrapes (fingerprint-rejected — proven 2026-06-01). To
-- prevent the wrong worker claiming the wrong platform, add two
-- optional parameters:
--
--   p_platform_filter   — when set, claims ONLY jobs with this platform
--   p_platform_exclude  — when set, claims jobs EXCEPT this platform
--
-- Both default to NULL (existing behavior preserved — no other code
-- has to change immediately). Production usage:
--
--   Windows EC2 worker (FB-only):  p_platform_filter = 'facebook'
--   Linux EC2 worker (everything else):  p_platform_exclude = 'facebook'
--
-- The DROP is required because we're changing the function signature.
-- ============================================================

DROP FUNCTION IF EXISTS claim_next_pending_scrape_job(text, int);

CREATE OR REPLACE FUNCTION claim_next_pending_scrape_job(
  p_worker_id        text,
  p_max_concurrent   int     DEFAULT 3,
  p_platform_filter  text    DEFAULT NULL,
  p_platform_exclude text    DEFAULT NULL
)
RETURNS SETOF scrape_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_flight int;
BEGIN
  -- Defense-in-depth cap: refuse to claim if this worker already
  -- holds p_max_concurrent running jobs.
  SELECT count(*) INTO v_in_flight
    FROM scrape_jobs
   WHERE status = 'running' AND worker_id = p_worker_id;

  IF v_in_flight >= p_max_concurrent THEN
    RETURN;
  END IF;

  -- Atomic claim with optional platform filter/exclude.
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
          AND (p_platform_filter IS NULL OR platform = p_platform_filter)
          AND (p_platform_exclude IS NULL OR platform <> p_platform_exclude)
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *;
END;
$$;

-- Verify the new signature is callable. Will silently no-op if the
-- queue is empty; we just want to confirm the function exists.
DO $$
BEGIN
  PERFORM claim_next_pending_scrape_job('migration-043-verify', 1, NULL, NULL);
END;
$$;
