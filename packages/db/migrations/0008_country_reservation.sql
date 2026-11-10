-- 0008: one Discord server per country, enforced by the database. Forward-only, idempotent on a fresh or an existing database.
--
-- Model: a COUNTRY server reserves its country. A reservation is a first-come claim; it does NOT prove in-game authority over the country
-- (no official API data proves that). Party / unit / general servers never reserve a country (a country id they store is only a lookup filter).
--
--   country_reservations.guild_id  PRIMARY KEY  -> a server holds at most ONE country
--   country_reservations (lower(country_id)) UNIQUE -> a country is held by at most ONE server (case-insensitive)
--   trigger on guilds keeps the table in step with guilds.country_id / community_type INSIDE the same statement, so no application path
--   (dashboard, bot, scripts, concurrent requests) can bypass it. A conflicting claim aborts the whole statement/transaction.

CREATE TABLE country_reservations (
  guild_id    text PRIMARY KEY REFERENCES guilds(guild_id) ON DELETE CASCADE,
  country_id  text NOT NULL CHECK (country_id <> ''),
  reserved_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX country_reservations_country ON country_reservations (lower(country_id));

-- Safe migration of existing data: where several existing country servers already share a country, the OLDEST keeps the reservation.
-- The others are NOT altered or cut off (no data is deleted, their sync keeps working); they simply hold no reservation, the dashboard
-- warns them, and any attempt to (re)claim a country goes through the same constraint.
INSERT INTO country_reservations (guild_id, country_id, reserved_at)
SELECT DISTINCT ON (lower(country_id)) guild_id, country_id, created_at
FROM guilds
WHERE community_type = 'country' AND country_id IS NOT NULL AND country_id <> ''
ORDER BY lower(country_id), created_at, guild_id;

CREATE FUNCTION guilds_sync_country_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_c text; new_c text;
BEGIN
  new_c := CASE WHEN NEW.community_type = 'country' THEN NULLIF(NEW.country_id, '') END;
  old_c := CASE WHEN TG_OP = 'UPDATE' AND OLD.community_type = 'country' THEN NULLIF(OLD.country_id, '') END;
  -- unchanged effective country: nothing to do (an existing duplicate keeps working and is never touched by unrelated saves)
  IF TG_OP = 'UPDATE' AND new_c IS NOT DISTINCT FROM old_c THEN RETURN NEW; END IF;
  DELETE FROM country_reservations WHERE guild_id = NEW.guild_id;          -- release the previous country (changed, cleared, or type left 'country')
  IF new_c IS NOT NULL THEN
    INSERT INTO country_reservations (guild_id, country_id) VALUES (NEW.guild_id, new_c) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'country_already_reserved' USING ERRCODE = 'unique_violation', DETAIL = 'the country is reserved by another server';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guilds_country_reservation AFTER INSERT OR UPDATE OF country_id, community_type ON guilds
  FOR EACH ROW EXECUTE FUNCTION guilds_sync_country_reservation();
