CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  os_version TEXT NOT NULL,
  cpu_model TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  process_name TEXT NOT NULL,
  window_title TEXT NOT NULL,
  cpu_percent REAL NOT NULL,
  memory_percent REAL NOT NULL,
  battery_percent REAL,
  power_plugged INTEGER,
  trigger TEXT NOT NULL CHECK (trigger IN ('window_change', 'heartbeat')),
  received_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_observed_at
  ON activity_events(observed_at);
CREATE INDEX IF NOT EXISTS idx_events_device_observed_at
  ON activity_events(device_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_process_observed_at
  ON activity_events(process_name, observed_at);
