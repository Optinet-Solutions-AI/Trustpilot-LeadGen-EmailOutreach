-- Migration 035: cache DKIM check result per sender account
-- Adds a 4th DNS badge alongside dns_mx / dns_spf / dns_dmarc.

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS dns_dkim boolean;
