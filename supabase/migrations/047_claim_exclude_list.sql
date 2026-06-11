-- ============================================================
-- Migration 047: claim_next_pending_scrape_job — multi-platform exclude
-- ============================================================
-- Migration 043 made p_platform_exclude a single platform
-- (`platform <> p_platform_exclude`). Now that BOTH Facebook and
-- Instagram run only on the Windows worker, the Linux worker must
-- exclude BOTH from its claims — a single value can't express that.
--
-- This upgrades p_platform_exclude to accept a comma-separated list,
-- e.g. 'facebook,instagram'. Backward-compatible: a single value like
-- 'facebook' still works (a 1-element list). Whitespace around commas
-- is tolerated ('facebook, instagram').
--
-- Signature is unchanged (text, int, text, text), so no DROP is needed.
-- ============================================================

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
  SELECT count(*) INTO v_in_flight
    FROM scrape_jobs
   WHERE status = 'running' AND worker_id = p_worker_id;

  IF v_in_flight >= p_max_concurrent THEN
    RETURN;
  END IF;

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
          -- comma-list exclude: skip jobs whose platform is in the list
          AND (p_platform_exclude IS NULL
               OR platform <> ALL(regexp_split_to_array(p_platform_exclude, '\s*,\s*')))
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *;
END;
$$;

-- Confirm callable with both a single value and a comma-list.
DO $$
BEGIN
  PERFORM claim_next_pending_scrape_job('migration-047-verify', 1, NULL, 'facebook,instagram');
END;
$$;
