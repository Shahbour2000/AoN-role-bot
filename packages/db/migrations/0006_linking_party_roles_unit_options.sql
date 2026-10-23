-- 0006: direct linking, generic party roles, unit option, safer defaults, rank/mapping role exclusivity, retired rank roles.
-- Existing guilds keep their current values; only the DEFAULTS for guilds created from now on change.

-- 1) account links may be created directly (name-only link, ownership NOT proven; see docs/LINKING.md)
ALTER TABLE account_links DROP CONSTRAINT account_links_method_check;
ALTER TABLE account_links ADD CONSTRAINT account_links_method_check CHECK (method IN ('self_claim','self_direct','staff_approved','admin_forced'));
ALTER TABLE guilds ALTER COLUMN require_staff_approval SET DEFAULT false;      -- new guilds: simple direct linking; staff approval stays available

-- 2) a party role identified by the game's own role value (treasurer, council, ... whatever the game reports)
ALTER TABLE role_mappings DROP CONSTRAINT role_mappings_kind_check;
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_kind_check CHECK (kind IN (
  'president','vice_president','minister_defense','minister_foreign','minister_economy','congress','government_role',
  'citizen','party_member','party_leader','party_role','unit_member','unit_leader','alliance_member','alliance_leader'));
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_party_role_ref CHECK (kind <> 'party_role' OR game_ref <> '');

-- 3) unit leaders may receive the leader role INSTEAD of the member role (per-guild choice)
ALTER TABLE guilds ADD COLUMN unit_leader_replaces_member boolean NOT NULL DEFAULT false;

-- 4) military ranks are not cumulative and thresholds only increase: reflecting a changed configuration on the next sync is the
--    expected behaviour, so new guilds default to immediate demotion (never / grace remain selectable).
ALTER TABLE guilds ALTER COLUMN demotion_mode SET DEFAULT 'immediate';

-- 5) a Discord role is EITHER a rank role OR a mapped office/membership role within one guild (never both)
CREATE FUNCTION check_mapping_not_rank_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM military_ranks WHERE guild_id = NEW.guild_id AND discord_role_id = NEW.discord_role_id) THEN
    RAISE EXCEPTION 'discord role % is already used as a military rank role in guild %', NEW.discord_role_id, NEW.guild_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_mappings_not_rank_role BEFORE INSERT OR UPDATE OF discord_role_id ON role_mappings FOR EACH ROW EXECUTE FUNCTION check_mapping_not_rank_role();
CREATE FUNCTION check_rank_not_mapping_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.discord_role_id IS NOT NULL AND EXISTS (SELECT 1 FROM role_mappings WHERE guild_id = NEW.guild_id AND discord_role_id = NEW.discord_role_id) THEN
    RAISE EXCEPTION 'discord role % is already used by a role mapping in guild %', NEW.discord_role_id, NEW.guild_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER military_ranks_not_mapping_role BEFORE INSERT OR UPDATE OF discord_role_id ON military_ranks FOR EACH ROW EXECUTE FUNCTION check_rank_not_mapping_role();

-- 6) rank roles that were removed from the ladder keep being cleaned off members until one full sync has completed
CREATE TABLE retired_rank_roles (
  guild_id        text NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  discord_role_id text NOT NULL,
  retired_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_role_id)
);

-- 7) the military-rank system is OPTIONAL: new guilds start with it off (the 17 starter ranks are created when an admin enables it)
ALTER TABLE guilds ALTER COLUMN modules SET DEFAULT '{"government":true,"party":false,"unit":false,"alliance":false,"ranks":false}'::jsonb;
