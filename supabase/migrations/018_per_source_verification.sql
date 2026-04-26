-- Per-source verification status. The existing verification_status column
-- collapses both email sources into one value, so when a lead has both a
-- trustpilot_email and a website_email and only one is verified, the UI can't
-- tell which. These columns track each source independently.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS trustpilot_email_status text
    CHECK (trustpilot_email_status IS NULL
        OR trustpilot_email_status IN ('valid', 'invalid', 'catch-all', 'unknown')),
  ADD COLUMN IF NOT EXISTS website_email_status text
    CHECK (website_email_status IS NULL
        OR website_email_status IN ('valid', 'invalid', 'catch-all', 'unknown'));
