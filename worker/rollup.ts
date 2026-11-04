import type { OverviewFilters, OverviewPoint } from "./types";
import { decodeSamples, type StoredEvent } from "./storage";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LOOKAHEAD_MS = 6 * HOUR_MS;

interface Slice {
  deviceId: string;
  hour: number;
  process: string;
  title: string;
  eventCount: number;
  totalMs: number;
  switches: number;
  cpu: number | null;
}

/**
 * Turn a chronologically ordered list of events (per device) into per-hour
 * slices, mirroring the runtime overview math: each sample contributes at most
 * five minutes, capped by the next sample on the same device and the range end,
 * and LockScreen/Desktop contribute no tracked time. A sample that crosses an
 * hour boundary produces a spill slice in the following hour.
 */
function buildSlices(events: StoredEvent[], effectiveTo: number): Slice[] {
  // Group by device, order by time then id, exactly like the SQL window.
  const byDevice = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const list = byDevice.get(event.deviceId);
    if (list) list.push(event);
    else byDevice.set(event.deviceId, [event]);
  }

  const slices: Slice[] = [];
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
    for (let i = 0; i < list.length; i += 1) {
      const event = list[i];
      const next = list[i + 1];
      const passive = event.processName === "LockScreen" || event.processName === "Desktop";
      const nextAt = next ? next.observedAt : null;
      const rawEnd = passive
        ? event.observedAt
        : Math.min(nextAt ?? effectiveTo, event.observedAt + 300_000, effectiveTo);

      const bucketStart = Math.floor(event.observedAt / HOUR_MS) * HOUR_MS;
      const bucketEnd = bucketStart + HOUR_MS;
      const ownMs = passive ? 0 : Math.max(0, Math.min(rawEnd, bucketEnd) - Math.max(event.observedAt, bucketStart));
      const switches = next && (next.processName !== event.processName || next.windowTitle !== event.windowTitle) ? 1 : 0;

      slices.push({
        deviceId: event.deviceId,
        hour: bucketStart,
        process: event.processName,
        title: event.windowTitle,
        eventCount: 1,
        totalMs: ownMs,
        switches,
        cpu: event.cpuPercent,
      });

      if (!passive && rawEnd > bucketEnd) {
        const spillHour = Math.floor(bucketEnd / HOUR_MS) * HOUR_MS;
        slices.push({
          deviceId: event.deviceId,
          hour: spillHour,
          process: event.processName,
          title: event.windowTitle,
          eventCount: 0,
          totalMs: Math.max(0, rawEnd - bucketEnd),
          switches: 0,
          cpu: null,
        });
      }
    }
  }
  return slices;
}

/**
 * Rebuild the hourly rollup for the UTC days that contain the given timestamps,
 * reading the collapsed day rows, expanding them, and rewriting the affected
 * hour buckets. Rebuilding (rather than incremental math) keeps late or
 * out-of-order samples correct while only touching the days a batch can span.
 */
export async function rebuildRollupForTimestamps(db: D1Database, timestamps: number[]): Promise<void> {
  if (timestamps.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const ts of timestamps) {
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }
  const dayStart = Math.floor(min / DAY_MS) * DAY_MS;
  const dayEnd = Math.floor(max / DAY_MS) * DAY_MS + DAY_MS;
  const hourFrom = dayStart - HOUR_MS;
  const hourTo = dayEnd + HOUR_MS;
  const effectiveTo = hourTo + LOOKAHEAD_MS;

  // Read day rows overlapping the affected range (with lookahead for the next
  // sample that closes each interval).
  const rows = await db
    .prepare(
      `SELECT device_id, process_name, samples FROM activity_days
        WHERE day_utc >= ? AND day_utc <= ?`,
    )
    .bind(Math.floor(hourFrom / DAY_MS) * DAY_MS, Math.floor((hourTo + LOOKAHEAD_MS) / DAY_MS) * DAY_MS)
    .all<{ device_id: string; process_name: string; samples: string }>();

  const events: StoredEvent[] = [];
  for (const row of rows.results ?? []) {
    events.push(...decodeSamples(row.device_id, row.process_name, row.samples));
  }

  const slices = buildSlices(events, effectiveTo).filter(
    (slice) => slice.hour >= hourFrom && slice.hour < hourTo,
  );

  // Aggregate slices into rollup rows.
  interface Agg {
    deviceId: string;
    hour: number;
    process: string;
    title: string;
    event_count: number;
    total_ms: number;
    switch_count: number;
    cpu_sum: number;
    cpu_count: number;
    cpu_max: number | null;
  }
  const agg = new Map<string, Agg>();
  for (const slice of slices) {
    const key = `${slice.deviceId}\u0000${slice.hour}\u0000${slice.process}\u0000${slice.title}`;
    let row = agg.get(key);
    if (!row) {
      row = {
        deviceId: slice.deviceId, hour: slice.hour, process: slice.process, title: slice.title,
        event_count: 0, total_ms: 0, switch_count: 0, cpu_sum: 0, cpu_count: 0, cpu_max: null,
      };
      agg.set(key, row);
    }
    row.event_count += slice.eventCount;
    row.total_ms += slice.totalMs;
    row.switch_count += slice.switches;
    if (slice.cpu !== null) {
      row.cpu_sum += slice.cpu;
      row.cpu_count += 1;
      row.cpu_max = row.cpu_max === null ? slice.cpu : Math.max(row.cpu_max, slice.cpu);
    }
  }

  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM activity_rollup WHERE hour_bucket >= ? AND hour_bucket < ?").bind(hourFrom, hourTo),
  ];
  for (const row of agg.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO activity_rollup
             (device_id, hour_bucket, process_name, window_title,
              event_count, total_ms, switch_count, cpu_sum, cpu_count, cpu_max)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.deviceId, row.hour, row.process, row.title, row.event_count, row.total_ms, row.switch_count, row.cpu_sum, row.cpu_count, row.cpu_max),
    );
  }
  await db.batch(statements);
}

/**
 * Rebuild the hourly rollup for every UTC day in [from, to). Used by the admin
 * backfill endpoint and safe to re-run: each affected hour bucket is cleared and
 * rewritten.
 */
export async function rebuildRollupForRange(db: D1Database, from: number, to: number): Promise<number> {
  const DAY = 86_400_000;
  let rebuilt = 0;
  for (let start = Math.floor(from / DAY) * DAY; start < to; start += DAY) {
    // Overlap-safe: rebuilding this day's hours plus one hour either side.
    await rebuildRollupForTimestamps(db, [start, start + DAY - 1]);
    rebuilt += 1;
  }
  return rebuilt;
}

/**
 * Aggregate the hourly rollup into the calendar buckets the dashboard expects.
 * Assumes a whole-hour timezone offset so UTC hours tile cleanly into local
 * days; callers fall back to the exact path for other offsets.
 */
export async function computeOverviewFromRollup(
  db: D1Database,
  filters: OverviewFilters,
) {
  const offsetMs = -filters.tzOffset * 60_000;
  const shiftedHour = `((hour_bucket + ${offsetMs}) / 1000)`;
  const keyFor = filters.granularity === "day"
    ? `strftime('%Y-%m-%d', ${shiftedHour}, 'unixepoch')`
    : `strftime('%Y-%m', ${shiftedHour}, 'unixepoch')`;

  const clauses = ["hour_bucket >= ?", "hour_bucket < ?"];
  const values: unknown[] = [filters.from - offsetMs, filters.to - offsetMs];
  if (filters.deviceId) { clauses.push("device_id = ?"); values.push(filters.deviceId); }
  if (filters.app) { clauses.push("process_name = ?"); values.push(filters.app); }
  const whereSql = clauses.join(" AND ");
  const titleClause = filters.query ? ` AND window_title LIKE ? ESCAPE '\\'` : "";
  const titleValues = filters.query
    ? [`%${filters.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`]
    : [];

  const seriesSql = `
    SELECT ${keyFor} AS key,
           SUM(event_count) AS events,
           SUM(total_ms) AS total_ms,
           SUM(switch_count) AS switches,
           COUNT(DISTINCT device_id) AS device_count,
           CASE WHEN SUM(cpu_count) > 0 THEN SUM(cpu_sum) / SUM(cpu_count) END AS average_cpu,
           MAX(cpu_max) AS maximum_cpu
      FROM activity_rollup
     WHERE ${whereSql}${titleClause}
     GROUP BY key
     ORDER BY key`;

  const appsSql = `
    SELECT process_name,
           SUM(total_ms) AS duration_ms
      FROM activity_rollup
     WHERE ${whereSql}${titleClause}
       AND process_name NOT IN ('LockScreen', 'Desktop')
     GROUP BY process_name
    HAVING SUM(total_ms) > 0
     ORDER BY duration_ms DESC, process_name COLLATE NOCASE
     LIMIT 10`;

  interface SeriesRow {
    key: string; events: number; total_ms: number; switches: number;
    device_count: number; average_cpu: number | null; maximum_cpu: number | null;
  }
  interface AppRow { process_name: string; duration_ms: number }

  const bound = [...values, ...titleValues];
  const [series, apps] = await db.batch([
    db.prepare(seriesSql).bind(...bound),
    db.prepare(appsSql).bind(...bound),
  ]);

  const seriesRows = (series.results ?? []) as SeriesRow[];
  const appRows = (apps.results ?? []) as AppRow[];

  // Battery endpoints and the device count are tz-independent; read them from
  // the collapsed day rows for the requested range.
  const dayRows = await db
    .prepare(
      `SELECT device_id, samples FROM activity_days WHERE day_utc >= ? AND day_utc <= ?`,
    )
    .bind(Math.floor(filters.from / DAY_MS) * DAY_MS, Math.floor((filters.to - 1) / DAY_MS) * DAY_MS)
    .all<{ device_id: string; samples: string }>();
  const batteryEvents: StoredEvent[] = [];
  for (const row of dayRows.results ?? []) {
    batteryEvents.push(...decodeSamples(row.device_id, "", row.samples));
  }
  const inRange = batteryEvents.filter(
    (event) =>
      event.observedAt >= filters.from &&
      event.observedAt < filters.to &&
      (!filters.deviceId || event.deviceId === filters.deviceId),
  );
  inRange.sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
  const batteryList = inRange.filter((event) => event.batteryPercent !== null);
  const globalDeviceCount = new Set(inRange.map((event) => event.deviceId)).size;
  const globalFirstBattery = batteryList.length ? batteryList[0].batteryPercent : null;
  const globalLastBattery = batteryList.length ? batteryList[batteryList.length - 1].batteryPercent : null;

  const populated: OverviewPoint[] = seriesRows.map((row) => ({
    key: row.key,
    start: 0,
    end: 0,
    events: Number(row.events ?? 0),
    totalMs: Number(row.total_ms ?? 0),
    switches: Number(row.switches ?? 0),
    averageCpu: row.average_cpu === null ? null : Number(Number(row.average_cpu).toFixed(1)),
    maximumCpu: row.maximum_cpu === null ? null : Number(row.maximum_cpu),
    batteryDelta: null,
  }));

  const localStart = new Date(filters.from + offsetMs);
  const localEnd = new Date(filters.to + offsetMs);
  const keys: string[] = [];
  if (filters.granularity === "day") {
    let cursor = Date.UTC(localStart.getUTCFullYear(), localStart.getUTCMonth(), localStart.getUTCDate());
    const endCursor = Date.UTC(localEnd.getUTCFullYear(), localEnd.getUTCMonth(), localEnd.getUTCDate());
    while (cursor < endCursor) {
      const date = new Date(cursor);
      keys.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`);
      cursor += DAY_MS;
    }
  } else {
    let year = localStart.getUTCFullYear();
    let month = localStart.getUTCMonth();
    const endYear = localEnd.getUTCFullYear();
    const endMonth = localEnd.getUTCMonth();
    while (year < endYear || (year === endYear && month < endMonth)) {
      keys.push(`${year}-${String(month + 1).padStart(2, "0")}`);
      month += 1;
      if (month === 12) { month = 0; year += 1; }
    }
  }
  const byKey = new Map(populated.map((point) => [point.key, point]));
  const points: OverviewPoint[] = keys.map((key) => {
    const localBoundary = filters.granularity === "day"
      ? Date.parse(`${key}T00:00:00Z`)
      : Date.parse(`${key}-01T00:00:00Z`);
    const nextBoundary = filters.granularity === "day"
      ? localBoundary + DAY_MS
      : (() => { const d = new Date(localBoundary); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); })();
    const existing = byKey.get(key);
    if (existing) return { ...existing, start: localBoundary - offsetMs, end: nextBoundary - offsetMs };
    return {
      key, start: localBoundary - offsetMs, end: nextBoundary - offsetMs,
      events: 0, totalMs: 0, switches: 0, averageCpu: null, maximumCpu: null, batteryDelta: null,
    };
  });

  const appsOut = appRows.map((row) => ({ processName: row.process_name, durationMs: Number(row.duration_ms ?? 0) }));
  const cpuCount = points.reduce((sum, point) => sum + point.events, 0);
  const weightedCpu = points.reduce((sum, point) => sum + (point.averageCpu === null ? 0 : point.averageCpu * point.events), 0);
  const maximumCpu = points.reduce<number | null>(
    (max, point) => point.maximumCpu === null ? max : max === null ? point.maximumCpu : Math.max(max, point.maximumCpu),
    null,
  );

  return {
    granularity: filters.granularity,
    from: filters.from,
    to: filters.to,
    hasData: populated.some((point) => point.events > 0 || point.totalMs > 0),
    points,
    apps: appsOut,
    summary: {
      totalMs: points.reduce((sum, point) => sum + point.totalMs, 0),
      switches: points.reduce((sum, point) => sum + point.switches, 0),
      events: points.reduce((sum, point) => sum + point.events, 0),
      averageCpu: cpuCount ? Number((weightedCpu / cpuCount).toFixed(1)) : null,
      maximumCpu,
      batteryDelta: globalDeviceCount === 1 && globalFirstBattery !== null && globalLastBattery !== null
        ? Number((Number(globalLastBattery) - Number(globalFirstBattery)).toFixed(1))
        : null,
    },
  };
}
