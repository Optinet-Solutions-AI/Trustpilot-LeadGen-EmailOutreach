-- ============================================================
-- Migration 061: claim_next_pending_scrape_job — browserless-FB exception
-- ============================================================
-- The always-on Linux worker (ec2-sg-1) sets
-- PLATFORM_EXCLUDE='facebook,instagram' because it can't drive a browser for
-- FB/IG. But CONSUMER-mode Facebook discovery runs cookieless via Apify — it
-- is pure HTTP, no browser, no logged-in session — so the Linux worker CAN
-- run it. Today it doesn't, because the exclude filter (migration 047) keys on
-- `platform` alone and can't tell browserless consumer FB from browser-driven
-- business FB. Result: cloud-enqueued FB jobs only run on the (currently
-- dormant) Windows worker and otherwise sit `pending` forever.
--
-- This adds p_browserless_facebook_ok. When a worker opts in, a facebook job in
-- CONSUMER mode (filters.lead_type is NULL / '' / 'consumers') is claimable
-- even while 'facebook' is in p_platform_exclude. Business-mode FB and ALL
-- Instagram stay excluded (browser-only). The consumer-mode test mirrors
-- isFacebookConsumerJob() in server/src/services/social-routing.ts, and the
-- worker's shouldRefuseSocialOnLinux() guard remains a runtime backstop.
--
-- The 5th param changes the signature, so the old 4-arg function is dropped
-- first. The new param DEFAULTS to false, so every existing caller that omits
-- it keeps its exact prior behaviour. Idempotent; safe to re-apply.
-- ============================================================

DROP FUNCTION IF EXISTS claim_next_pending_scrape_job(text, int, text, text);

CREATE OR REPLACE FUNCTION claim_next_pending_scrape_job(
  p_worker_id               text,
  p_max_concurrent          int     DEFAULT 3,
  p_platform_filter         text    DEFAULT NULL,
  p_platform_exclude        text    DEFAULT NULL,
  p_browserless_facebook_ok boolean DEFAULT false
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
          AND (
            -- Normal exclude: skip jobs whose platform is in the list …
            p_platform_exclude IS NULL
            OR platform <> ALL(regexp_split_to_array(p_platform_exclude, '\s*,\s*'))
            -- … EXCEPT a browserless (consumer-mode) Facebook job, which a
            -- worker opting in via p_browserless_facebook_ok may claim even
            -- when 'facebook' is excluded (Apify discovery = pure HTTP).
            OR (
              p_browserless_facebook_ok
              AND platform = 'facebook'
              AND (
                filters->>'lead_type' IS NULL
                OR lower(btrim(filters->>'lead_type')) IN ('', 'consumers')
              )
            )
          )
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *;
END;
$$;

-- Verify the new signature exists WITHOUT executing a real claim (a PERFORM of
-- the function would UPDATE a live pending row to 'running' under a fake
-- worker_id — migration 047 did that; we avoid the side effect here).
DO $$
BEGIN
  PERFORM 1 FROM pg_proc
    WHERE proname = 'claim_next_pending_scrape_job'
      AND pg_get_function_arguments(oid) LIKE '%p_browserless_facebook_ok%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration 061 failed: p_browserless_facebook_ok param missing';
  END IF;
END;
$$;
