-- Migration 010: Add auth type and OAuth credential fields to email_accounts
-- Run this in the Supabase SQL Editor

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS auth_type    text NOT NULL DEFAULT 'smtp',
  ADD COLUMN IF NOT EXISTS app_password text,
  ADD COLUMN IF NOT EXISTS gmail_client_id     text,
  ADD COLUMN IF NOT EXISTS gmail_client_secret text,
  ADD COLUMN IF NOT EXISTS gmail_refresh_token text,
  ADD COLUMN IF NOT EXISTS smtp_secure  text NOT NULL DEFAULT 'tls';

-- auth_type values: 'gmail_oauth' | 'app_password' | 'smtp' | 'instantly'
-- smtp_secure values: 'tls' | 'ssl' | 'none'
