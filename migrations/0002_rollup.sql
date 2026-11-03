-- Pre-aggregated activity rollup used by the month/year overview views.
--
-- Rows are keyed by UTC hour so that any whole-hour timezone offset tiles
-- cleanly into local calendar days. Each row stores the portion of an event's
-- (five-minute-capped) duration that falls inside that UTC hour, along with the
-- sample count, switch count and CPU aggregates needed to rebuild the overview
-- without scanning the raw `activity_events` table.
--
-- `event_count` counts samples that *start* in the hour. The continuation of a
-- sample that crosses an hour boundary is stored as a separate spill row in the
-- next hour with `event_count = 0` and a NULL CPU value, mirroring the runtime
-- slice logic.
CREATE TABLE IF NOT EXISTS activity_rollup (
  device_id TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  process_name TEXT NOT NULL,
  window_title TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  total_ms INTEGER NOT NULL,
  switch_count INTEGER NOT NULL,
  cpu_sum REAL NOT NULL,
  cpu_count INTEGER NOT NULL,
  cpu_max REAL,
  PRIMARY KEY (device_id, hour_bucket, process_name, window_title)
);

CREATE INDEX IF NOT EXISTS idx_rollup_hour
  ON activity_rollup(hour_bucket);
