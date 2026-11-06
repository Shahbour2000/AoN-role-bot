-- 0007: permanent player-build roles (War / Eco / Hybrid) — stored as role_mappings rows of three new kinds, one per server.
-- Safe for existing installations: only a new set of allowed kinds and two partial unique indexes over the NEW kinds (no existing row can violate them).
ALTER TABLE role_mappings DROP CONSTRAINT role_mappings_kind_check;
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_kind_check CHECK (kind IN (
  'president','vice_president','minister_defense','minister_foreign','minister_economy','congress','government_role',
  'citizen','party_member','party_leader','party_role','unit_member','unit_leader','alliance_member','alliance_leader',
  'build_war','build_eco','build_hybrid'));
-- exactly one Discord role per build per server, and a Discord role can serve only ONE build (contradictory otherwise)
CREATE UNIQUE INDEX role_mappings_one_per_build ON role_mappings (guild_id, kind) WHERE kind IN ('build_war','build_eco','build_hybrid');
CREATE UNIQUE INDEX role_mappings_build_role_unique ON role_mappings (guild_id, discord_role_id) WHERE kind IN ('build_war','build_eco','build_hybrid');
