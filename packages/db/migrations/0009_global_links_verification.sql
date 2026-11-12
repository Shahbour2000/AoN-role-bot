-- 0009: GLOBAL Discord <-> Age of Nations account links + company-name verification attempts. Forward-only; nothing is dropped or rewritten.
--
-- Model
--   global_links      = the identity: ONE Discord account <-> ONE game account, across every server. Uniqueness is enforced HERE by
--                       partial unique indexes (not by application code).
--   account_links     = unchanged, per server: it keeps the per-server sync state (roles granted, damage, rank grace). A row can only be
--                       ACTIVE when it matches the active global link (trigger below); the bot creates it automatically for a globally
--                       linked member the first time that member uses the bot in a server (method 'global_link').
--   verification_attempts = one-time company-name challenges (only a hash of the code is stored).

CREATE TABLE global_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id   text NOT NULL,
  player_id         text NOT NULL,                       -- stable game id, never the username
  player_username   text,
  method            text NOT NULL CHECK (method IN ('company_verified','admin_forced','staff_approved','legacy_unverified')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unlinked')),
  verified_at       timestamptz NOT NULL DEFAULT now(),
  verified_in_guild text,
  attempt_id        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  unlinked_at       timestamptz,
  unlinked_by       text,
  unlink_reason     text
);
CREATE UNIQUE INDEX global_links_active_user   ON global_links (discord_user_id) WHERE status = 'active';
CREATE UNIQUE INDEX global_links_active_player ON global_links (player_id)       WHERE status = 'active';

-- Existing per-server links are PRESERVED. Per Discord user and per game account, one link is kept as the global identity
-- (admin-forced > staff-approved > self-claimed; then oldest). A per-server link that loses such a conflict is marked 'unlinked' with a
-- reason and an audit event (never deleted); its member simply re-verifies. Links that were never proven stay marked 'legacy_unverified'.
CREATE TEMP TABLE _aon_cand ON COMMIT DROP AS
  SELECT id, guild_id, discord_user_id, player_id, player_username, method, requested_at,
         CASE method WHEN 'admin_forced' THEN 0 WHEN 'staff_approved' THEN 1 ELSE 2 END AS prio
  FROM account_links WHERE status IN ('verified','admin_linked');
DO $$
DECLARE r record;
BEGIN
  -- Greedy by strength: a pair is taken unless its Discord user or its game account is already taken by a stronger / older link.
  FOR r IN SELECT * FROM (SELECT DISTINCT ON (discord_user_id, player_id) * FROM _aon_cand ORDER BY discord_user_id, player_id, prio, requested_at, id) p ORDER BY prio, requested_at, id LOOP
    INSERT INTO global_links (discord_user_id, player_id, player_username, method, verified_in_guild)
    VALUES (r.discord_user_id, r.player_id, r.player_username,
            CASE r.method WHEN 'admin_forced' THEN 'admin_forced' WHEN 'staff_approved' THEN 'staff_approved' ELSE 'legacy_unverified' END, r.guild_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
WITH lost AS (
  UPDATE account_links a SET status = 'unlinked', reviewed_at = now(), reason = 'global uniqueness: another link for this Discord user or game account was kept'
  WHERE a.status IN ('verified','admin_linked')
    AND NOT EXISTS (SELECT 1 FROM global_links g WHERE g.status = 'active' AND g.discord_user_id = a.discord_user_id AND g.player_id = a.player_id)
  RETURNING a.guild_id, a.discord_user_id, a.player_id)
INSERT INTO audit_events (guild_id, actor_discord_id, action, target, details)
  SELECT guild_id, NULL, 'link.migration_conflict_unlinked', player_id, jsonb_build_object('discordUserId', discord_user_id) FROM lost;

-- Per-server rows may now also be created from a global link.
ALTER TABLE account_links DROP CONSTRAINT account_links_method_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_method_check CHECK (method IN ('self_claim','self_direct','staff_approved','admin_forced','global_link'));

-- Database-level guard: an ACTIVE per-server link must equal the active global link of that Discord user. Legacy write paths (direct
-- claim, staff approval, forced link) still work: when no global link exists yet they create it; a clash with a DIFFERENT global link aborts
-- the statement. Row updates that do not touch status / user / player (every sync) are not checked.
CREATE FUNCTION account_links_global_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE exact boolean; clash boolean;
BEGIN
  IF NEW.status NOT IN ('verified','admin_linked') THEN RETURN NEW; END IF;
  SELECT EXISTS (SELECT 1 FROM global_links WHERE status='active' AND discord_user_id=NEW.discord_user_id AND player_id=NEW.player_id) INTO exact;
  IF exact THEN RETURN NEW; END IF;
  SELECT EXISTS (SELECT 1 FROM global_links WHERE status='active' AND (discord_user_id=NEW.discord_user_id OR player_id=NEW.player_id)) INTO clash;
  IF clash THEN RAISE EXCEPTION 'global link unique conflict: this Discord user or game account is linked to another account' USING ERRCODE = 'unique_violation'; END IF;
  IF NEW.method = 'global_link' THEN RAISE EXCEPTION 'global link required' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO global_links (discord_user_id, player_id, player_username, method, verified_in_guild)
    VALUES (NEW.discord_user_id, NEW.player_id, NEW.player_username,
            CASE NEW.method WHEN 'admin_forced' THEN 'admin_forced' WHEN 'staff_approved' THEN 'staff_approved' ELSE 'legacy_unverified' END, NEW.guild_id);
  RETURN NEW;
END $$;
CREATE TRIGGER account_links_global_guard BEFORE INSERT OR UPDATE OF status, discord_user_id, player_id ON account_links
  FOR EACH ROW EXECUTE FUNCTION account_links_global_guard();

-- Verification tickets
ALTER TABLE guilds ADD COLUMN verification_channel_id text;

CREATE TABLE verification_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id         text NOT NULL,                          -- where it was opened (no FK: history must survive a guild removal)
  discord_user_id  text NOT NULL,
  player_id        text NOT NULL,
  player_username  text,
  code_hash        text NOT NULL,                          -- sha256 only; the code itself is never stored
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','cancelled','locked','superseded')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  check_count      integer NOT NULL DEFAULT 0,
  last_check_at    timestamptz,
  last_result      text,
  closed_at        timestamptz,
  close_reason     text,
  company_id       text,
  displaced_legacy boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX verification_attempts_code_hash ON verification_attempts (code_hash);
CREATE UNIQUE INDEX verification_one_pending_per_user ON verification_attempts (discord_user_id) WHERE status = 'pending';
CREATE INDEX verification_attempts_guild_time ON verification_attempts (guild_id, created_at DESC);
CREATE INDEX verification_attempts_user_time ON verification_attempts (discord_user_id, created_at DESC);
