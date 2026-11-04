-- Collapse per-sample events into one row per (device, UTC day, application),
-- keeping the detailed samples in a compact JSON array. This shrinks the table
-- from one row per sample (hundreds of thousands) to a few thousand rows while
-- preserving per-sample detail for timelines, charts and title search.
--
-- samples is a JSON array of positional tuples:
--   [observed_at, window_title, cpu, memory, battery, power_plugged,
--    trigger("w"|"h"), id]
--
-- Rows are ordered by observed_at so the decoder can replay them in sequence.

CREATE TABLE IF NOT EXISTS activity_days (
  device_id TEXT NOT NULL,
  day_utc INTEGER NOT NULL,
  process_name TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  samples TEXT NOT NULL,
  PRIMARY KEY (device_id, day_utc, process_name)
);

CREATE INDEX IF NOT EXISTS idx_days_day ON activity_days(day_utc);
CREATE INDEX IF NOT EXISTS idx_days_device_day ON activity_days(device_id, day_utc);
CREATE INDEX IF NOT EXISTS idx_days_process ON activity_days(process_name);

-- Backfill existing per-sample events into the collapsed representation.
INSERT OR REPLACE INTO activity_days (device_id, day_utc, process_name, sample_count, samples)
SELECT device_id,
       (observed_at / 86400000) * 86400000 AS day_utc,
       process_name,
       COUNT(*) AS sample_count,
       json_group_array(
         json_array(
           observed_at,
           window_title,
           cpu_percent,
           memory_percent,
           battery_percent,
           power_plugged,
           CASE WHEN trigger = 'window_change' THEN 'w' ELSE 'h' END,
           id
         )
       ) AS samples
  FROM (
    SELECT * FROM activity_events
     ORDER BY device_id, observed_at, id
  )
 GROUP BY device_id, (observed_at / 86400000) * 86400000, process_name;

-- The per-sample table is no longer the source of truth.
DROP TABLE IF EXISTS activity_events;
