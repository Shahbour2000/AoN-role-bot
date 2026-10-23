-- 0001_init: multi-tenant core schema. Forward-only; never edited after release.
-- Every tenant-owned table carries guild_id and references guilds(guild_id).

CREATE TABLE guilds (
  guild_id            text PRIMARY KEY,
  name                text NOT NULL DEFAULT '',
  community_type      text NOT NULL DEFAULT 'general'
                      CHECK (community_type IN ('country','party','military_unit','alliance','general')),
  language            text NOT NULL DEFAULT 'en' CHECK (language IN ('en','ar')),
  country_id          text,
  party_id            text,
  unit_id             text,
  alliance_id         text,
  modules             jsonb NOT NULL DEFAULT '{"government":true,"party":false,"unit":false,"alliance":false,"ranks":true}'::jsonb,
  require_staff_approval boolean NOT NULL DEFAULT true,
  demotion_mode       text NOT NULL DEFAULT 'never' CHECK (demotion_mode IN ('never','immediate','grace')),
  demotion_grace_days integer NOT NULL DEFAULT 7 CHECK (demotion_grace_days BETWEEN 1 AND 365),
  sync_interval_minutes integer NOT NULL DEFAULT 360 CHECK (sync_interval_minutes >= 30),
  auto_sync_enabled   boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Discord user <-> game player, scoped per guild because approval is per guild.
CREATE TABLE account_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id          text NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  discord_user_id   text NOT NULL,
  player_id         text NOT NULL,           -- stable game id, never the username
  player_username   text,                    -- display only; mutable
  status            text NOT NULL CHECK (status IN ('pending','verified','admin_linked','rejected','unlinked')),
  method            text NOT NULL CHECK (method IN ('self_claim','staff_approved','admin_forced')),
  conflict          boolean NOT NULL DEFAULT false,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by       text,
  reviewed_at       timestamptz,
  reason            text,
  last_synced_at    timestamptz,
  last_damage       bigint,
  managed_role_ids  text[] NOT NULL DEFAULT '{}',
  rank_below_since  timestamptz
);
-- One ACTIVE link per player and per Discord user inside a guild. Pending claims may overlap (flagged as conflicts).
CREATE UNIQUE INDEX account_links_active_player ON account_links (guild_id, player_id) WHERE status IN ('verified','admin_linked');
CREATE UNIQUE INDEX account_links_active_user   ON account_links (guild_id, discord_user_id) WHERE status IN ('verified','admin_linked');
CREATE INDEX account_links_pending ON account_links (guild_id, status);

CREATE TABLE role_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        text NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('president','vice_president','minister_defense','minister_foreign','minister_economy',
                                               'congress','citizen','party_member','party_leader','unit_member','unit_leader',
                                               'alliance_member','alliance_leader')),
  game_ref        text NOT NULL DEFAULT '',  -- country/party/unit/alliance id this applies to ('' = guild's configured entity)
  discord_role_id text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, kind, game_ref, discord_role_id)
);

CREATE TABLE custom_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        text NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  name            text NOT NULL,
  condition       jsonb NOT NULL,
  discord_role_id text NOT NULL,
  priority        integer NOT NULL DEFAULT 100,
  enabled         boolean NOT NULL DEFAULT true,
  UNIQUE (guild_id, name)
);

CREATE TABLE military_ranks (
  guild_id        text NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  key             text NOT NULL,
  rank_order      integer NOT NULL CHECK (rank_order >= 1),
  name_en         text NOT NULL,
  name_ar         text NOT NULL,
  min_damage      bigint NOT NULL CHECK (min_damage > 0),
  discord_role_id text,
  PRIMARY KEY (guild_id, key),
  UNIQUE (guild_id, rank_order) DEFERRABLE INITIALLY DEFERRED
);

-- Defence in depth: even a buggy caller cannot commit a ladder where a higher rank needs less damage.
CREATE FUNCTION check_rank_ladder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g text := COALESCE(NEW.guild_id, OLD.guild_id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM military_ranks hi JOIN military_ranks lo
      ON lo.guild_id = hi.guild_id AND lo.rank_order < hi.rank_order
    WHERE hi.guild_id = g AND hi.min_damage <= lo.min_damage
  ) THEN
    RAISE EXCEPTION 'military_ranks: a higher rank must require more damage than every lower rank (guild %)', g
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER military_ranks_monotonic
  AFTER INSERT OR UPDATE OR DELETE ON military_ranks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_rank_ladder();

CREATE TABLE sync_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id      text NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('all','scheduled','user')),
  target_user_id text,
  status        text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  requested_by  text,
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
-- At most one in-flight server-wide job per guild.
CREATE UNIQUE INDEX sync_jobs_one_active_guild ON sync_jobs (guild_id) WHERE kind IN ('all','scheduled') AND status IN ('queued','running');

CREATE TABLE audit_events (
  id               bigserial PRIMARY KEY,
  guild_id         text NOT NULL,           -- intentionally no FK: audit must survive guild removal
  actor_discord_id text,
  action           text NOT NULL,
  target           text,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_guild_time ON audit_events (guild_id, created_at DESC);
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_append_only();
