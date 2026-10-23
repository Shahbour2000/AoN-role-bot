-- 0002: let guilds map ANY raw government role value (game_ref = API role string, e.g. 'ministerForeign').
ALTER TABLE role_mappings DROP CONSTRAINT role_mappings_kind_check;
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_kind_check CHECK (kind IN (
  'president','vice_president','minister_defense','minister_foreign','minister_economy','congress','government_role',
  'citizen','party_member','party_leader','unit_member','unit_leader','alliance_member','alliance_leader'));
-- government_role needs the raw role value.
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_gov_role_ref CHECK (kind <> 'government_role' OR game_ref <> '');
