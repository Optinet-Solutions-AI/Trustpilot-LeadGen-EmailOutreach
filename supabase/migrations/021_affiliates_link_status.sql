-- Migration 021: Mirror the leads link-validation columns on affiliates so the
-- Affiliate Monitor can flag dead/removed Trustpilot affiliate pages.
ALTER TABLE affiliates
  ADD COLUMN IF NOT EXISTS link_status text NOT NULL DEFAULT 'VALID'
    CHECK (link_status IN ('VALID', 'FLAGGED_DEAD', 'FLAGGED_REMOVED', 'UNKNOWN')),
  ADD COLUMN IF NOT EXISTS last_validated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS link_validation_error  text;

CREATE INDEX IF NOT EXISTS affiliates_link_status_flagged_idx
  ON affiliates (link_status, last_validated_at DESC)
  WHERE link_status <> 'VALID';
