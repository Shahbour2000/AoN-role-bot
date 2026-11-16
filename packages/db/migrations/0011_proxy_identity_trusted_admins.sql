-- 0011: proxy-country roles, country-server identity roles, trusted bot-administrator roles.
-- Additive and forward-only: the allowed set of role kinds only GROWS (every existing row stays valid), the new indexes cover only the NEW kinds
-- (no existing row can violate them), and one new table is created. No existing data is changed or removed.
ALTER TABLE role_mappings DROP CONSTRAINT role_mappings_kind_check;
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_kind_check CHECK (kind IN (
  'president','vice_president','minister_defense','minister_foreign','minister_economy','congress','government_role',
  'citizen','party_member','party_leader','party_role','unit_member','unit_leader','alliance_member','alliance_leader',
  'build_war','build_eco','build_hybrid',
  'proxy_citizen','country_party_member','country_party_president','country_unit_member','country_unit_leader','country_unit_owner'));

-- a proxy role names its country (game_ref = the proxy country's id); one role per proxy country per server
ALTER TABLE role_mappings ADD CONSTRAINT role_mappings_proxy_ref CHECK (kind <> 'proxy_citizen' OR game_ref <> '');
CREATE UNIQUE INDEX role_mappings_one_proxy_per_country ON role_mappings (guild_id, game_ref) WHERE kind = 'proxy_citizen';
-- identity roles: one Discord role per identity kind per server, and a role is never shared between identity/proxy kinds
CREATE UNIQUE INDEX role_mappings_one_per_identity ON role_mappings (guild_id, kind)
  WHERE kind IN ('country_party_member','country_party_president','country_unit_member','country_unit_leader','country_unit_owner');
CREATE UNIQUE INDEX role_mappings_identity_proxy_role_unique ON role_mappings (guild_id, discord_role_id)
  WHERE kind IN ('proxy_citizen','country_party_member','country_party_president','country_unit_member','country_unit_leader','country_unit_owner');

-- trusted bot administrators: members holding one of these roles may use the bot's management functions (they need no Discord permission)
CREATE TABLE bot_admin_roles (
  guild_id        text NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  discord_role_id text NOT NULL CHECK (discord_role_id ~ '^[0-9]{5,25}$'),
  added_by        text,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_role_id)
);
