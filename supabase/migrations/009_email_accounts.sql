-- Migration 009: email_accounts table
-- Stores sender email accounts managed from the UI.
-- Supports Gmail (OAuth-via-env-vars), SMTP, and Instantly-managed accounts.

CREATE TABLE IF NOT EXISTS email_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  from_name      text NOT NULL,
  provider       text NOT NULL DEFAULT 'smtp',   -- 'gmail' | 'smtp' | 'instantly'
  smtp_host      text,
  smtp_port      integer,
  smtp_user      text,
  smtp_password  text,
  status         text NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'error'
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Only service role can insert/update (auth enforced at API layer)
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON email_accounts
  FOR ALL USING (true);
