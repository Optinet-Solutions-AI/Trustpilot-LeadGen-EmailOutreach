-- Migration 013: Add IMAP fields and email_provider to email_accounts
-- Supports native SMTP/IMAP accounts (e.g. DreamHost webmail)

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS imap_host      text,
  ADD COLUMN IF NOT EXISTS imap_port      integer,
  ADD COLUMN IF NOT EXISTS imap_user      text,
  ADD COLUMN IF NOT EXISTS imap_pass      text,
  ADD COLUMN IF NOT EXISTS email_provider text NOT NULL DEFAULT 'gmail';

-- email_provider values: 'gmail' | 'smtp'
