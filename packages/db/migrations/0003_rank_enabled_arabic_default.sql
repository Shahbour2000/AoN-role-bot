-- 0003: per-rank enable switch, role uniqueness, key format, Arabic as the default guild language.
-- Note: this does NOT rewrite ladders that were already stored (none exist in production yet).

ALTER TABLE military_ranks ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE military_ranks ADD CONSTRAINT military_ranks_key_fmt CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$');
-- One Discord role can belong to at most one rank per guild (ambiguous otherwise).
CREATE UNIQUE INDEX military_ranks_role_unique ON military_ranks (guild_id, discord_role_id) WHERE discord_role_id IS NOT NULL;

-- Monotonic-ladder guard now considers ENABLED ranks only (disabled ranks take no part in matching).
CREATE OR REPLACE FUNCTION check_rank_ladder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g text := COALESCE(NEW.guild_id, OLD.guild_id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM military_ranks hi JOIN military_ranks lo
      ON lo.guild_id = hi.guild_id AND lo.rank_order < hi.rank_order
    WHERE hi.guild_id = g AND hi.enabled AND lo.enabled AND hi.min_damage <= lo.min_damage
  ) THEN
    RAISE EXCEPTION 'military_ranks: a higher rank must require more damage than every lower rank (guild %)', g
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE guilds ALTER COLUMN language SET DEFAULT 'ar';
