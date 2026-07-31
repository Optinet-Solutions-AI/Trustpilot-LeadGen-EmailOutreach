-- AdsPower profile binding for social accounts.
--
-- An account with an adspower_profile_id opens through AdsPower's anti-detect
-- browser (isolated fingerprint per profile). NULL keeps the account on the
-- existing undetected-chromedriver + Brave persistent-profile path, which is
-- how this change stays a no-op for un-migrated accounts and how it rolls back.
ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS adspower_profile_id text;

COMMENT ON COLUMN social_accounts.adspower_profile_id IS
  'AdsPower Local API user_id. NULL = use the legacy Brave profile-dir path.';
