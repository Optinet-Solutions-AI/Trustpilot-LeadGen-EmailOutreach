-- 040_lead_notes_send_uniqueness.sql
--
-- Hard DB-level guarantee that no (lead, campaign, step_number) tuple gets
-- more than one successful email_sent note. Defends against the scheduler
-- race that caused the 2026-05 incident: even if both schedulers' claim
-- locks AND application-side idempotency guards are bypassed by a future
-- code path, this index makes the SECOND INSERT fail with a unique-
-- constraint violation. Callers must catch the conflict and treat it as
-- "already sent" rather than retrying with new content.
--
-- TWO separate indexes, one per send type:
--   1. FOLLOW-UPS: keyed on (lead_id, campaign_id, step_number) — sequence-
--      scheduler writes these with metadata containing both keys.
--   2. INITIAL SENDS: keyed on (lead_id, campaign_id) — campaign-scheduler
--      writes these WITHOUT a step_number. A partial WHERE clause scopes
--      this index to rows that have NO step_number, so it doesn't conflict
--      with the follow-up index.
--
-- NOTE: Running this migration on a database that already contains
-- duplicate rows (which yours does — there are ~310 affected tuples) will
-- FAIL with a unique violation. The first DELETE block strips duplicates
-- BEFORE building the indexes, keeping the earliest send and discarding
-- the rest. The DELETE is safe-by-design: it never touches rows that are
-- already unique, and it preserves the FIRST send per tuple (the one the
-- recipient legitimately got — subsequent duplicates were the racing
-- ticks).
--
-- Dedup must happen BEFORE the unique index is created, or the index
-- creation itself fails.

BEGIN;

-- ── 1. Strip historical follow-up duplicates (keep oldest per tuple) ─────────
WITH ranked_followups AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY lead_id, metadata->>'campaign_id', metadata->>'step_number'
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM lead_notes
  WHERE type = 'email_sent'
    AND metadata ? 'step_number'
)
DELETE FROM lead_notes
WHERE id IN (SELECT id FROM ranked_followups WHERE rn > 1);

-- ── 2. Strip historical initial-send duplicates (keep oldest per tuple) ──────
WITH ranked_initials AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY lead_id, metadata->>'campaign_id'
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM lead_notes
  WHERE type = 'email_sent'
    AND NOT (metadata ? 'step_number')
)
DELETE FROM lead_notes
WHERE id IN (SELECT id FROM ranked_initials WHERE rn > 1);

-- ── 3. Unique partial index for follow-up sends ──────────────────────────────
-- One email_sent note per (lead, campaign, step). Lives in the DB so any
-- future caller (manual reconciliation, new agents, dev scripts) cannot
-- bypass it. Partial WHERE keeps the index small and skips notes that
-- don't have a step_number (those are guarded by the initial-send index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_notes_unique_followup_send
ON lead_notes (
  lead_id,
  (metadata->>'campaign_id'),
  (metadata->>'step_number')
)
WHERE type = 'email_sent' AND metadata ? 'step_number';

-- ── 4. Unique partial index for initial sends ────────────────────────────────
-- One email_sent note per (lead, campaign) for the "no step_number"
-- variant. Together with index 3 above, this enforces "at most one
-- successful send per logical step per lead per campaign."
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_notes_unique_initial_send
ON lead_notes (
  lead_id,
  (metadata->>'campaign_id')
)
WHERE type = 'email_sent' AND NOT (metadata ? 'step_number');

COMMIT;

-- ── 5. Sanity check (run separately AFTER migration to verify) ───────────────
-- SELECT
--   COUNT(*) FILTER (WHERE metadata ? 'step_number')       AS followup_notes,
--   COUNT(*) FILTER (WHERE NOT (metadata ? 'step_number')) AS initial_notes,
--   COUNT(*)                                                AS total_email_sent_notes
-- FROM lead_notes WHERE type = 'email_sent';
