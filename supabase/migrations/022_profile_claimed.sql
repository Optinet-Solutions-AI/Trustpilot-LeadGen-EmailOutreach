-- Migration 022: Track whether a Trustpilot profile has been claimed by the
-- business owner. Nullable on purpose — NULL means "not yet detected" so
-- historical rows render blank in the UI rather than being mislabelled
-- "unclaimed".
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS profile_claimed boolean;

CREATE INDEX IF NOT EXISTS leads_profile_claimed_idx
  ON leads (profile_claimed)
  WHERE profile_claimed IS NOT NULL;
