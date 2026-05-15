-- ============================================================
-- 034_leads_verification_rank.sql
-- Adds a stored verification_rank column so the leads list can
-- prioritize valid > catch-all > invalid > unknown in a single
-- ORDER BY clause without computing the CASE on every read.
--
-- Why a generated column instead of a view: PostgREST can ORDER
-- on a stored column with an index, but cannot evaluate CASE
-- expressions inside ORDER BY clauses sent over the REST API.
-- A view would solve that but breaks all the existing
-- `.from('leads')` calls in the codebase. Stored column is the
-- minimal-blast-radius option.
--
-- Ordering:
--   1 = valid       (best — campaign-ready)
--   2 = catch-all   (sometimes deliverable)
--   3 = invalid     (will bounce — keep visible for audit)
--   4 = unknown     (not yet verified)
--   5 = null/other  (status not yet set; sinks to the bottom)
-- ============================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS verification_rank int
  GENERATED ALWAYS AS (
    CASE verification_status
      WHEN 'valid'     THEN 1
      WHEN 'catch-all' THEN 2
      WHEN 'invalid'   THEN 3
      WHEN 'unknown'   THEN 4
      ELSE 5
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_leads_verification_rank
  ON leads (verification_rank);

-- ============================================================
-- Verification (run manually after applying):
--   SELECT verification_status, verification_rank, count(*)
--     FROM leads GROUP BY 1, 2 ORDER BY verification_rank;
--   -- Expect each known status to map to the integer above.
-- ============================================================
