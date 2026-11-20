-- 0013: optional "Unverified" role removal after successful verification (roadmap M2a).
-- Additive: two columns on guilds. Existing installations: DISABLED, no role (behaviour unchanged).
ALTER TABLE guilds ADD COLUMN unverified_role_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE guilds ADD COLUMN unverified_role_id text;
ALTER TABLE guilds ADD CONSTRAINT guilds_unverified_role_chk
  CHECK (unverified_role_id IS NULL OR unverified_role_id ~ '^[0-9]{5,25}$') ,
  ADD CONSTRAINT guilds_unverified_role_required_chk CHECK (NOT unverified_role_enabled OR unverified_role_id IS NOT NULL);
