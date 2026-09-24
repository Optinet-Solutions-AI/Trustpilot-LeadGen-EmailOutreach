-- ============================================================
-- Migration 064: keep the `_enrich_` sentinel away from scraper workers
-- ============================================================
-- `POST /api/enrich` parks its progress in a scrape_jobs row using the
-- sentinel country/category `_enrich_`. That row is NOT a scraper job: the
-- work runs IN-PROCESS on Cloud Run (the TypeScript website enricher), and
-- the row exists only so status survives an instance restart.
--
-- Two RPCs never learned that, and together they corrupt every long enrich
-- run (observed live 2026-09-02, 3 of 4 chunks destroyed):
--
--   1. release_stale_scrape_claims() sees the row as a dead worker claim the
--      moment Cloud Run's 20s heartbeat lapses — which a CPU-saturated
--      instance (5 concurrent Chromium tier-ladders on 1 vCPU) does easily —
--      and flips it back to `pending`, clearing worker_id/claimed_at.
--   2. claim_next_pending_scrape_job() then happily claims it, because it
--      filters on platform only. ec2-sg-1 spawns
--      `run.py --platform trustpilot` for country `_enrich_`, which emits no
--      stdout, so the 300s Python watchdog kills it and stamps the row
--      `failed` — while the real Cloud Run enrichment is still running and
--      still writing emails to that same row.
--
-- Anything polling /api/enrich/status then reads `failed`, abandons a live
-- job, and starts another — stacking concurrent enrichments, which is the
-- documented pile-up that once wedged the box with ~200 chromiums.
--
-- Fix, in two parts:
--   * the claim RPC skips `_enrich_` rows outright — a scraper worker must
--     never run one;
--   * the stale sweeper stops re-queueing them. A genuinely dead enrich row
--     still terminates (marked `failed`, so callers aren't left hanging), it
--     just never re-enters the worker queue.
--
-- `server/src/db/scrape-jobs.ts` already carries the same `_enrich_` guard on
-- its three listing queries; this brings the two RPCs in line with it.
-- Signatures are unchanged. Idempotent; safe to re-apply.
-- ============================================================

-- ── Part 1: claim RPC never hands an `_enrich_` row to a worker ──────────────
-- Body copied from migration 061 with a single added predicate, so the
-- browserless-Facebook exception and every other behaviour is preserved.
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
          -- NEW: enrichment-only rows run in-process on Cloud Run, never here.
          AND country <> '_enrich_'
          AND (p_platform_filter IS NULL OR platform = p_platform_filter)
          AND (
            p_platform_exclude IS NULL
            OR platform <> ALL(regexp_split_to_array(p_platform_exclude, '\s*,\s*'))
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
     RETURNING scrape_jobs.*;
END;
$$;

-- ── Part 2: stale sweeper stops re-queueing `_enrich_` rows ──────────────────
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
  -- Requeue stale claims that still have retry budget.
  -- `_enrich_` rows are excluded: re-queueing one only feeds it to a scraper
  -- worker that cannot run it.
  WITH requeued AS (
    UPDATE scrape_jobs
       SET status     = 'pending',
           worker_id  = NULL,
           claimed_at = NULL,
           last_error = COALESCE(last_error, 'Worker heartbeat went stale; requeued')
     WHERE status = 'running'
       AND last_heartbeat_at < v_cutoff
       AND attempts < max_attempts
       AND country <> '_enrich_'
    RETURNING id
  )
  SELECT count(*) INTO v_requeued FROM requeued;

  -- Mark permanently failed when retry budget is exhausted, and for any stale
  -- `_enrich_` row regardless of budget — it terminates without ever being
  -- offered to a worker, so a caller polling status isn't left hanging.
  WITH gave_up AS (
    UPDATE scrape_jobs
       SET status       = 'failed',
           completed_at = COALESCE(completed_at, now()),
           error        = COALESCE(error, 'Max attempts exceeded after stale heartbeat')
     WHERE status = 'running'
       AND last_heartbeat_at < v_cutoff
       AND (attempts >= max_attempts OR country = '_enrich_')
    RETURNING id
  )
  SELECT count(*) INTO v_failed FROM gave_up;

  RETURN v_requeued + v_failed;
END;
$$;
