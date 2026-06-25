ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS encrypted_fb_username text,
  ADD COLUMN IF NOT EXISTS encrypted_fb_password text;
