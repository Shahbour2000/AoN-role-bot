-- 0005: durable per-guild schedule (3/6/12/24 h), claim-based scheduling, richer job results.
-- Existing intervals are mapped to the nearest allowed value that is NOT shorter than what was configured.

UPDATE guilds SET sync_interval_minutes = CASE
  WHEN sync_interval_minutes <= 180 THEN 180
  WHEN sync_interval_minutes <= 360 THEN 360
  WHEN sync_interval_minutes <= 720 THEN 720
  ELSE 1440 END;
ALTER TABLE guilds DROP CONSTRAINT guilds_sync_interval_minutes_check;
ALTER TABLE guilds ADD CONSTRAINT guilds_sync_interval_allowed CHECK (sync_interval_minutes IN (180, 360, 720, 1440));

-- The schedule lives in the database, not in a timer: any worker (or a restarted one) can see and claim due guilds.
ALTER TABLE guilds ADD COLUMN next_sync_at timestamptz;
UPDATE guilds SET next_sync_at = now() + (sync_interval_minutes * interval '1 minute') WHERE auto_sync_enabled;
ALTER TABLE guilds ADD CONSTRAINT guilds_schedule_consistent CHECK (auto_sync_enabled = (next_sync_at IS NOT NULL));
CREATE INDEX guilds_due ON guilds (next_sync_at) WHERE auto_sync_enabled;

-- Aggregated result of a run: roles added/removed, skip reasons, blocked operations, first errors.
ALTER TABLE sync_jobs ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
