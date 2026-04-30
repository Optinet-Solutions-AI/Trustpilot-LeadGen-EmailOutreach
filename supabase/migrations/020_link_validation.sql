-- Migration 020: Self-healing URL validation pipeline.
--
-- Tracks the lifecycle of every Trustpilot URL after the ingestion-time
-- sanitizer + validator run. The state machine is:
--
--   VALID            → URL was sanitized successfully and the page is live
--   FLAGGED_DEAD     → hard 4xx (e.g. 404) on fetch
--   FLAGGED_REMOVED  → 200 OK but DOM contains a Trustpilot soft-404 marker
--                      (e.g. "this profile has been removed")
--   UNKNOWN          → transient network/5xx error; will be retried
--
-- The system NEVER auto-deletes flagged leads. Deletion is always a manual
-- user action via the bulk-delete UI on the leads table.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS link_status text NOT NULL DEFAULT 'VALID'
    CHECK (link_status IN ('VALID', 'FLAGGED_DEAD', 'FLAGGED_REMOVED', 'UNKNOWN')),
  ADD COLUMN IF NOT EXISTS last_validated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS link_validation_error  text;

-- Partial index — flagged leads are the only rows the UI ever filters on.
-- Keeps the index narrow on a multi-million-row leads table.
CREATE INDEX IF NOT EXISTS leads_link_status_flagged_idx
  ON leads (link_status, last_validated_at DESC)
  WHERE link_status <> 'VALID';
