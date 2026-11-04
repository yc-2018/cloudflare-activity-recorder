import type { ActivityRow, QueryFilters } from "./types";

/**
 * Compact single-sample representation stored inside the per-day JSON blob.
 * Kept as a positional tuple (not an object) so the stored JSON is small.
 *
 *   [ observed_at, window_title, cpu, memory, battery, power_plugged, trigger, id ]
 *
 * `trigger` is encoded as "w" (window_change) or "h" (heartbeat). Battery and
 * power_plugged may be null.
 */
export type SampleTuple = [
  number,
  string,
  number,
  number,
  number | null,
  number | null,
  string,
  string,
];

export interface StoredEvent {
  id: string;
  deviceId: string;
  observedAt: number;
  processName: string;
  windowTitle: string;
  cpuPercent: number;
  memoryPercent: number;
  batteryPercent: number | null;
  powerPlugged: boolean | null;
  trigger: "window_change" | "heartbeat";
}

/** Decode a stored JSON array of sample tuples into flat events for one key. */
export function decodeSamples(
  deviceId: string,
  processName: string,
  json: string | null,
): StoredEvent[] {
  if (!json) return [];
  let tuples: SampleTuple[];
  try {
    tuples = JSON.parse(json) as SampleTuple[];
  } catch {
    return [];
  }
  if (!Array.isArray(tuples)) return [];
  const out: StoredEvent[] = [];
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || tuple.length < 8) continue;
    out.push({
      id: String(tuple[7]),
      deviceId,
      observedAt: Number(tuple[0]),
      processName,
      windowTitle: String(tuple[1] ?? ""),
      cpuPercent: Number(tuple[2]),
      memoryPercent: Number(tuple[3]),
      batteryPercent: tuple[4] === null ? null : Number(tuple[4]),
      powerPlugged: tuple[5] === null ? null : Number(tuple[5]) !== 0,
      trigger: tuple[6] === "w" ? "window_change" : "heartbeat",
    });
  }
  return out;
}

/** Encode an event into the compact tuple form. */
export function encodeSample(event: StoredEvent): SampleTuple {
  return [
    event.observedAt,
    event.windowTitle,
    event.cpuPercent,
    event.memoryPercent,
    event.batteryPercent,
    event.powerPlugged === null ? null : event.powerPlugged ? 1 : 0,
    event.trigger === "window_change" ? "w" : "h",
    event.id,
  ];
}

/** UTC day bucket (ms at 00:00 UTC) for a timestamp. */
export function utcDay(ts: number): number {
  return Math.floor(ts / 86_400_000) * 86_400_000;
}

/** Convert a decoded event into the legacy ActivityRow shape used by computeReport. */
export function toActivityRow(event: StoredEvent, deviceName: string): ActivityRow {
  return {
    id: event.id,
    device_id: event.deviceId,
    device_name: deviceName,
    observed_at: event.observedAt,
    process_name: event.processName,
    window_title: event.windowTitle,
    cpu_percent: event.cpuPercent,
    memory_percent: event.memoryPercent,
    battery_percent: event.batteryPercent,
    power_plugged: event.powerPlugged === null ? null : event.powerPlugged ? 1 : 0,
    trigger: event.trigger,
  };
}

interface DayRow {
  device_id: string;
  device_name: string;
  day_utc: number;
  process_name: string;
  samples: string | null;
}

/**
 * Load every sample in the inclusive UTC-day range that covers [from, to) for
 * the given filters, decoded back into flat events. Reads only the daily rows
 * (a few per day) rather than one row per sample.
 */
export async function readEventsForRange(
  db: D1Database,
  filters: QueryFilters,
  options: { applyActivityFilters?: boolean } = {},
): Promise<StoredEvent[]> {
  const applyActivity = options.applyActivityFilters !== false;
  const dayFrom = utcDay(filters.from);
  // `to` is exclusive; include the day that contains the last millisecond.
  const dayTo = utcDay(filters.to - 1);
  const clauses = ["a.day_utc >= ?", "a.day_utc <= ?"];
  const values: unknown[] = [dayFrom, dayTo];
  if (filters.deviceId) {
    clauses.push("a.device_id = ?");
    values.push(filters.deviceId);
  }
  if (applyActivity && filters.app) {
    clauses.push("a.process_name = ?");
    values.push(filters.app);
  }
  const rows = await db
    .prepare(
      `SELECT a.device_id, d.name AS device_name, a.day_utc, a.process_name, a.samples
         FROM activity_days a
         JOIN devices d ON d.id = a.device_id
        WHERE ${clauses.join(" AND ")}`,
    )
    .bind(...values)
    .all<DayRow>();

  const events: StoredEvent[] = [];
  for (const row of rows.results ?? []) {
    events.push(...decodeSamples(row.device_id, row.process_name, row.samples));
  }
  // Clamp to the exact requested window, then apply the title search (which is
  // not expressible against the JSON column in SQL).
  const query = applyActivity ? filters.query : undefined;
  return events.filter((event) => {
    if (event.observedAt < filters.from || event.observedAt >= filters.to) return false;
    if (query && !event.windowTitle.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
}

export interface DeviceNameRow {
  id: string;
  name: string;
}

export function deviceNameMap(rows: DeviceNameRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.name]));
}
