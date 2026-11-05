-- Step 2 of the device-identity change: collapse the 36-character client UUID
-- into a short auto-increment number.
--
-- devices.id stays TEXT so every existing join keeps working, but now holds
-- "1", "2", ... . The original UUID stays in legacy_id, so clients that still
-- send it resolve to the same short id.
--
-- Run only after the Worker that understands legacy_id is deployed.

CREATE TABLE _device_map AS
  SELECT id AS old_id, CAST(ROW_NUMBER() OVER (ORDER BY first_seen, id) AS TEXT) AS new_id
    FROM devices;

UPDATE activity_days
   SET device_id = (SELECT new_id FROM _device_map WHERE _device_map.old_id = activity_days.device_id);

UPDATE devices
   SET id = (SELECT new_id FROM _device_map WHERE _device_map.old_id = devices.id);

DROP TABLE _device_map;
