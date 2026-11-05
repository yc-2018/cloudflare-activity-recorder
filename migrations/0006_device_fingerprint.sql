-- Step 1 of the device-identity change: add the columns and backfill the
-- legacy uuid. This migration is safe for the currently deployed Worker because
-- every new column is nullable and the old statements never mention them.
--
-- Step 2 (0007) rewrites devices.id / activity_days.device_id to short numbers
-- once the new Worker code (which understands legacy_id and fingerprint) is
-- deployed.

ALTER TABLE devices ADD COLUMN legacy_id TEXT;
ALTER TABLE devices ADD COLUMN fingerprint TEXT;
ALTER TABLE devices ADD COLUMN created_at INTEGER;

UPDATE devices SET legacy_id = id WHERE legacy_id IS NULL;
UPDATE devices SET created_at = first_seen WHERE created_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_legacy ON devices(legacy_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices(fingerprint);
