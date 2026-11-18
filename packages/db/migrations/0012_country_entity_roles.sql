-- 0012: country-server roles, corrected model.
--   * party / unit MEMBERSHIP roles are now one row PER party / unit (game_ref = that entity's id);
--   * Party President, Unit Leader and Unit Owner stay ONE shared role per kind;
--   * proxy-country citizen roles may share one Discord role (typically the country's ordinary citizen role).
-- Additive and forward-only: no row is changed or deleted, no role kind is added or removed. Only the two indexes that encoded the old
-- "one role per identity kind / no sharing with proxies" rules are replaced by narrower ones. Every row that was valid before stays valid.
-- Legacy rows of kind country_party_member / country_unit_member with game_ref = '' (the old "any party / any unit" role) are KEPT but the
-- bot no longer evaluates them; the dashboard flags them so the administrator can remove them.
DROP INDEX IF EXISTS role_mappings_one_per_identity;
DROP INDEX IF EXISTS role_mappings_identity_proxy_role_unique;

-- shared roles: exactly one Discord role per kind per server
CREATE UNIQUE INDEX role_mappings_one_per_shared_identity ON role_mappings (guild_id, kind)
  WHERE kind IN ('country_party_president','country_unit_leader','country_unit_owner');
-- membership roles: one Discord role per party / unit per server
CREATE UNIQUE INDEX role_mappings_one_per_entity_member ON role_mappings (guild_id, kind, game_ref)
  WHERE kind IN ('country_party_member','country_unit_member');
-- an identity role is never reused by another identity role of the same server (proxy roles are deliberately NOT part of this index)
CREATE UNIQUE INDEX role_mappings_identity_role_unique ON role_mappings (guild_id, discord_role_id)
  WHERE kind IN ('country_party_member','country_party_president','country_unit_member','country_unit_leader','country_unit_owner');

-- new membership rows must name their party / unit (NOT VALID: legacy rows with game_ref = '' are left untouched)
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_entity_member_ref
  CHECK (kind NOT IN ('country_party_member','country_unit_member') OR game_ref <> '') NOT VALID;
