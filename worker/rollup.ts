import type { OverviewFilters, OverviewPoint } from "./types";
import { buildWhere } from "./validation";

const HOUR_MS = 3_600_000;
// A sample contributes at most five minutes, so a small lookahead past the
// rebuilt window is enough to see the "next" sample that closes each interval.
const LOOKAHEAD_MS = 6 * HOUR_MS;

/**
 * Shared CTE that turns raw `activity_events` into per-event "slices".
 *
 * A slice is the portion of one sample's contribution that falls inside a
 * single time bucket, capped at five minutes. A sample that crosses the bucket
 * end produces an extra spill slice in the following bucket with no CPUs. This
 * mirrors the runtime overview math exactly; only the bucket boundaries change
 * (hours here, days/months in `computeOverview`).
 */
function sliceCte(
  bucketExpr: { key: string; start: string; end: string; spillKey: string; spillEnd: string },
  contextRange: { sql: string; values: unknown[] },
  effectiveTo: number,
): string {
  return `
    WITH ordered_all AS (
      SELECT e.id, e.device_id, e.observed_at, e.process_name, e.window_title,
             e.cpu_percent, e.battery_percent,
             LEAD(e.observed_at) OVER (
               PARTITION BY e.device_id ORDER BY e.observed_at, e.id
             ) AS next_at,
             LEAD(e.process_name) OVER (
               PARTITION BY e.device_id ORDER BY e.observed_at, e.id
             ) AS next_process,
             LEAD(e.window_title) OVER (
               PARTITION BY e.device_id ORDER BY e.observed_at, e.id
             ) AS next_title
        FROM activity_events e
       WHERE ${contextRange.sql}
    ),
    bucketed AS (
      SELECT ordered_all.*,
             ${bucketExpr.key} AS bucket,
             ${bucketExpr.start} AS bucket_start,
             ${bucketExpr.end} AS bucket_end,
             CASE
               WHEN process_name IN ('LockScreen', 'Desktop') THEN observed_at
               ELSE MIN(COALESCE(next_at, ${effectiveTo}), observed_at + 300000, ${effectiveTo})
             END AS raw_end
        FROM ordered_all
    ),
    slices AS (
      SELECT bucket, bucket_start, bucket_end, device_id, process_name, window_title,
             1 AS event_count,
             CASE WHEN process_name IN ('LockScreen', 'Desktop') THEN 0
                  ELSE MAX(0, MIN(raw_end, bucket_end) - MAX(observed_at, bucket_start)) END AS total_ms,
             CASE WHEN next_at IS NOT NULL AND
                       (next_process <> process_name OR next_title <> window_title)
                  THEN 1 ELSE 0 END AS switch_count,
             cpu_percent
        FROM bucketed
      UNION ALL
      SELECT ${bucketExpr.spillKey} AS bucket,
             bucket_end AS bucket_start,
             ${bucketExpr.spillEnd} AS bucket_end,
             device_id, process_name, window_title,
             0 AS event_count,
             MAX(0, raw_end - bucket_end) AS total_ms,
             0 AS switch_count,
             NULL AS cpu_percent
        FROM bucketed
       WHERE raw_end > bucket_end
         AND process_name NOT IN ('LockScreen', 'Desktop')
    )`;
}

/** SQL fragments for bucketing by UTC hour: `(x / 3600000) * 3600000`. */
const hourBucket = {
  key: "((observed_at / 3600000) * 3600000)",
  start: "((observed_at / 3600000) * 3600000)",
  end: "(((observed_at / 3600000) * 3600000) + 3600000)",
  spillKey: "((bucket_end / 3600000) * 3600000)",
  spillEnd: "(((bucket_end / 3600000) * 3600000) + 3600000)",
};

/**
 * Recompute the hourly rollup for every hour in [hourFrom, hourTo).
 *
 * The raw sample context is widened by one hour before and a few hours after so
 * that LEAD() sees the neighbouring samples needed to close intervals and to
 * receive spill from the previous hour. Only buckets inside the requested
 * window are written, so the operation is idempotent: the window is cleared and
 * re-inserted in one pass.
 */
export async function rebuildRollup(
  db: D1Database,
  hourFrom: number,
  hourTo: number,
): Promise<void> {
  if (hourTo <= hourFrom) return;
  // Align the window to whole hours.
  const from = Math.floor(hourFrom / HOUR_MS) * HOUR_MS;
  const to = Math.ceil(hourTo / HOUR_MS) * HOUR_MS;
  const contextFrom = from - HOUR_MS;
  const contextTo = to + LOOKAHEAD_MS;
  const effectiveTo = to + LOOKAHEAD_MS;

  const cte = sliceCte(hourBucket, { sql: "e.observed_at >= ? AND e.observed_at < ?", values: [contextFrom, contextTo] }, effectiveTo);

  const sql = `${cte}
    INSERT INTO activity_rollup
      (device_id, hour_bucket, process_name, window_title,
       event_count, total_ms, switch_count, cpu_sum, cpu_count, cpu_max)
    SELECT device_id, bucket AS hour_bucket, process_name, window_title,
           SUM(event_count) AS event_count,
           SUM(total_ms) AS total_ms,
           SUM(switch_count) AS switch_count,
           COALESCE(SUM(cpu_percent), 0) AS cpu_sum,
           COUNT(cpu_percent) AS cpu_count,
           MAX(cpu_percent) AS cpu_max
      FROM slices
     WHERE bucket >= ? AND bucket < ?
     GROUP BY device_id, bucket, process_name, window_title`;

  await db.batch([
    db.prepare("DELETE FROM activity_rollup WHERE hour_bucket >= ? AND hour_bucket < ?").bind(from, to),
    db.prepare(sql).bind(contextFrom, contextTo, from, to),
  ]);
}

/**
 * Rebuild rollup rows covering the UTC days that contain the given timestamps.
 * Each affected day is widened by one hour on both sides so that samples
 * straddling a day boundary keep accurate durations and spill.
 */
export async function rebuildRollupForTimestamps(db: D1Database, timestamps: number[]): Promise<void> {
  if (timestamps.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const ts of timestamps) {
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }
  const dayStart = Math.floor(min / 86_400_000) * 86_400_000;
  const dayEnd = Math.floor(max / 86_400_000) * 86_400_000 + 86_400_000;
  // Extend by one hour each way to cover spill across the neighbouring hour.
  await rebuildRollup(db, dayStart - HOUR_MS, dayEnd + HOUR_MS);
}

/**
 * Aggregate the hourly rollup into the calendar buckets the dashboard expects.
 * Assumes a whole-hour timezone offset so UTC hours tile cleanly into local
 * days; callers must fall back to the exact path for other offsets.
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

  // Apply device / app / title filters against the rollup rows themselves.
  const clauses = ["hour_bucket >= ?", "hour_bucket < ?"];
  const values: unknown[] = [filters.from - offsetMs, filters.to - offsetMs];
  if (filters.deviceId) { clauses.push("device_id = ?"); values.push(filters.deviceId); }
  if (filters.app) { clauses.push("process_name = ?"); values.push(filters.app); }
  const whereSql = clauses.join(" AND ");

  // Title search is applied only to rollup rows; it is exact for whole-hour
  // buckets because titles are stored verbatim per hour.
  const titleClause = filters.query
    ? ` AND window_title LIKE ? ESCAPE '\\'`
    : "";
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

  // Battery endpoints and the device count are tz-independent and cheap to read
  // straight from the indexed raw events (LIMIT 1 each), so we do not store them
  // in the rollup. They use only the device filter, matching the exact path.
  const batteryClauses = ["e.observed_at >= ?", "e.observed_at < ?"];
  const batteryValues: unknown[] = [filters.from, filters.to];
  if (filters.deviceId) { batteryClauses.push("e.device_id = ?"); batteryValues.push(filters.deviceId); }
  const batteryWhere = batteryClauses.join(" AND ");
  const batterySql = `
    SELECT
      (SELECT COUNT(DISTINCT device_id) FROM activity_events e WHERE ${batteryWhere}) AS global_device_count,
      (SELECT battery_percent FROM activity_events e
        WHERE ${batteryWhere} AND battery_percent IS NOT NULL
        ORDER BY observed_at, id LIMIT 1) AS global_first_battery,
      (SELECT battery_percent FROM activity_events e
        WHERE ${batteryWhere} AND battery_percent IS NOT NULL
        ORDER BY observed_at DESC, id DESC LIMIT 1) AS global_last_battery`;

  interface SeriesRow {
    key: string;
    events: number;
    total_ms: number;
    switches: number;
    device_count: number;
    average_cpu: number | null;
    maximum_cpu: number | null;
  }
  interface AppRow { process_name: string; duration_ms: number }
  interface BatteryRow {
    global_device_count: number | null;
    global_first_battery: number | null;
    global_last_battery: number | null;
  }

  const bound = [...values, ...titleValues];
  const batteryBound = [...batteryValues, ...batteryValues, ...batteryValues];
  const [series, apps, battery] = await db.batch([
    db.prepare(seriesSql).bind(...bound),
    db.prepare(appsSql).bind(...bound),
    db.prepare(batterySql).bind(...batteryBound),
  ]);

  const seriesRows = (series.results ?? []) as SeriesRow[];
  const appRows = (apps.results ?? []) as AppRow[];
  const batteryRow = ((battery.results ?? []) as BatteryRow[])[0];

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

  // Build a stable calendar series including empty buckets.
  const localStart = new Date(filters.from + offsetMs);
  const localEnd = new Date(filters.to + offsetMs);
  const keys: string[] = [];
  if (filters.granularity === "day") {
    let cursor = Date.UTC(localStart.getUTCFullYear(), localStart.getUTCMonth(), localStart.getUTCDate());
    const endCursor = Date.UTC(localEnd.getUTCFullYear(), localEnd.getUTCMonth(), localEnd.getUTCDate());
    while (cursor < endCursor) {
      const date = new Date(cursor);
      keys.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`);
      cursor += 86_400_000;
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
    const existing = byKey.get(key);
    if (existing) {
      const localBoundary = filters.granularity === "day"
        ? Date.parse(`${key}T00:00:00Z`)
        : Date.parse(`${key}-01T00:00:00Z`);
      const nextBoundary = filters.granularity === "day"
        ? localBoundary + 86_400_000
        : (() => { const d = new Date(localBoundary); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); })();
      return { ...existing, start: localBoundary - offsetMs, end: nextBoundary - offsetMs };
    }
    const localBoundary = filters.granularity === "day"
      ? Date.parse(`${key}T00:00:00Z`)
      : Date.parse(`${key}-01T00:00:00Z`);
    const nextBoundary = filters.granularity === "day"
      ? localBoundary + 86_400_000
      : (() => { const d = new Date(localBoundary); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); })();
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

  const globalDeviceCount = Number(batteryRow?.global_device_count ?? 0);
  const globalFirstBattery = batteryRow?.global_first_battery ?? null;
  const globalLastBattery = batteryRow?.global_last_battery ?? null;

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
