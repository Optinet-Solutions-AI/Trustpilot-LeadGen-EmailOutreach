-- ─────────────────────────────────────────────────────────────
-- Migration 042 — scrape_jobs.recent_events for honest UI updates
--
-- Why this exists:
--   Cloud Run + Google API Gateway buffer Server-Sent Events instead
--   of flushing each line through, so the frontend's EventSource on
--   /api/scrape/:id/status receives no live events for any production
--   scrape. The ActiveScrapeCard already falls back to polling
--   /api/scrape, but only the top-level counters (total_found,
--   total_scraped) updated — the per-stage "Live activity" feed
--   stayed empty, so operators couldn't tell whether the Gemini
--   classifier ran, whether posts were being dropped at substring or
--   LLM stage, or where in the pipeline a slow run was stuck.
--
--   Storing the recent progress events on the job row itself lets
--   the polling path render Live Activity from the DB without
--   relying on SSE that the gateway swallows. scrape-runner.ts now
--   subscribes to its own EventEmitter and debounce-flushes the
--   last ~30 events per job into this column every 2 seconds.
--
-- Shape:
--   recent_events: [
--     { "stage": "groups_found", "detail": "count=41", "ts": "..." },
--     { "stage": "consumer_filtered", "detail": "dropped=119 kept=33", "ts": "..." },
--     { "stage": "llm_filtered", "detail": "dropped=23 kept=10", "ts": "..." },
--     ...
--   ]
--
-- ─────────────────────────────────────────────────────────────

ALTER TABLE scrape_jobs
    ADD COLUMN IF NOT EXISTS recent_events jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN scrape_jobs.recent_events IS
    'Last ~30 PROGRESS events emitted during this scrape, persisted by '
    'scrape-runner.ts so the frontend can render Live Activity through '
    'polling when SSE is blocked by the API Gateway. Each entry: '
    '{stage, detail, ts}.';
