import type { OverviewFilters, OverviewPoint } from "./types";
import { buildWhere } from "./validation";

/**
 * Build a grouped overview without sending the raw event stream to the
 * browser. A sample contributes at most five minutes, and a sample crossing a
 * calendar boundary is split into a second (duration-only) slice so day and
 * month totals remain accurate.
 */
export async function computeOverview(db: D1Database, filters: OverviewFilters) {
  // Date.getTimezoneOffset() is UTC - local time. Adding the inverse converts
  // a UTC epoch into the browser's local calendar for SQLite's date functions.
  const offsetMs = -filters.tzOffset * 60_000;
  const effectiveTo = Math.min(filters.to, Date.now());
  const where = buildWhere(filters);
  // Calculate LEAD() over every sample in the selected device/time range,
  // then apply app/title filters to the rows that contribute to the result.
  // Otherwise filtering to one app would incorrectly extend each matching
  // sample to five minutes across intervening applications.
  const contextWhere = buildWhere(filters, false);
  const activitySql = where.sql.slice(contextWhere.sql.length).replace(/^\s*AND\s+/, "") || "1 = 1";
  const activityValues = where.values.slice(contextWhere.values.length);
  const shifted = (timestamp: string) => `(${timestamp} + ${offsetMs})`;
  const keyFor = (timestamp: string) => filters.granularity === "day"
    ? `strftime('%Y-%m-%d', ${shifted(timestamp)} / 1000, 'unixepoch')`
    : `strftime('%Y-%m', ${shifted(timestamp)} / 1000, 'unixepoch')`;
  const startFor = (timestamp: string) => filters.granularity === "day"
    ? `(CAST(strftime('%s', date(${shifted(timestamp)} / 1000, 'unixepoch')) AS INTEGER) * 1000 - ${offsetMs})`
    : `(CAST(strftime('%s', date(${shifted(timestamp)} / 1000, 'unixepoch', 'start of month')) AS INTEGER) * 1000 - ${offsetMs})`;
  const endFor = (timestamp: string) => filters.granularity === "day"
    ? `(${startFor(timestamp)} + 86400000)`
    : `(CAST(strftime('%s', date(${shifted(timestamp)} / 1000, 'unixepoch', 'start of month', '+1 month')) AS INTEGER) * 1000 - ${offsetMs})`;

  // The expressions below run in the `bucketed` CTE, whose columns no longer
  // have the inner `e` table alias.
  const bucketKey = keyFor("observed_at");
  const bucketStart = startFor("observed_at");
  const bucketEnd = endFor("observed_at");
  const spillKey = keyFor("(bucket_end + 1)");
  const spillEnd = endFor("(bucket_end + 1)");

  const baseSql = `
    WITH ordered_all AS (
      SELECT e.id, e.device_id, e.observed_at, e.process_name, e.window_title,
             e.cpu_percent, e.memory_percent, e.battery_percent, e.power_plugged,
             e.trigger,
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
       WHERE ${contextWhere.sql}
    ),
    ordered AS (
      SELECT * FROM ordered_all
       WHERE ${activitySql.replaceAll("e.", "")}
    ),
    bucketed AS (
      SELECT ordered.*,
             ${bucketKey} AS bucket,
             ${bucketStart} AS bucket_start,
             ${bucketEnd} AS bucket_end,
             CASE
               WHEN process_name IN ('LockScreen', 'Desktop') THEN observed_at
               ELSE MIN(COALESCE(next_at, ${effectiveTo}), observed_at + 300000, ${effectiveTo})
             END AS raw_end
        FROM ordered
    ),
    slices AS (
      SELECT bucket, bucket_start, bucket_end, device_id, process_name,
             1 AS event_count,
             CASE WHEN process_name IN ('LockScreen', 'Desktop') THEN 0
                  ELSE MAX(0, MIN(raw_end, bucket_end) - MAX(observed_at, bucket_start)) END AS total_ms,
             CASE WHEN next_at IS NOT NULL AND
                       (next_process <> process_name OR next_title <> window_title)
                  THEN 1 ELSE 0 END AS switch_count,
             cpu_percent, battery_percent, observed_at, id
        FROM bucketed
      UNION ALL
      SELECT ${spillKey} AS bucket,
             bucket_end AS bucket_start,
             ${spillEnd} AS bucket_end,
             device_id, process_name,
             0 AS event_count,
             MAX(0, raw_end - bucket_end) AS total_ms,
             0 AS switch_count,
             NULL AS cpu_percent, NULL AS battery_percent,
             observed_at, id
        FROM bucketed
       WHERE raw_end > bucket_end
         AND process_name NOT IN ('LockScreen', 'Desktop')
    )`;

  const sql = `${baseSql},
    grouped AS (
      SELECT bucket AS key,
             MIN(bucket_start) AS start,
             MAX(bucket_end) AS end,
             SUM(event_count) AS events,
             SUM(total_ms) AS total_ms,
             SUM(switch_count) AS switches,
             COUNT(DISTINCT device_id) AS device_count,
             AVG(cpu_percent) AS average_cpu,
             MAX(cpu_percent) AS maximum_cpu,
             (SELECT s2.battery_percent FROM slices s2
               WHERE s2.bucket = slices.bucket AND s2.battery_percent IS NOT NULL
               ORDER BY s2.observed_at, s2.id LIMIT 1) AS first_battery,
             (SELECT s3.battery_percent FROM slices s3
               WHERE s3.bucket = slices.bucket AND s3.battery_percent IS NOT NULL
               ORDER BY s3.observed_at DESC, s3.id DESC LIMIT 1) AS last_battery,
             (SELECT s4.battery_percent FROM slices s4
               WHERE s4.battery_percent IS NOT NULL
               ORDER BY s4.observed_at, s4.id LIMIT 1) AS global_first_battery,
             (SELECT s5.battery_percent FROM slices s5
               WHERE s5.battery_percent IS NOT NULL
               ORDER BY s5.observed_at DESC, s5.id DESC LIMIT 1) AS global_last_battery,
             (SELECT COUNT(DISTINCT s6.device_id) FROM slices s6) AS global_device_count
        FROM slices
       GROUP BY bucket
       ORDER BY bucket
    )
    SELECT * FROM grouped`;

  const appsSql = `${baseSql}
    SELECT process_name, SUM(total_ms) AS duration_ms
      FROM slices
     WHERE process_name NOT IN ('LockScreen', 'Desktop')
       AND total_ms > 0
     GROUP BY process_name
     ORDER BY duration_ms DESC, process_name COLLATE NOCASE
     LIMIT 10`;

  interface RawPoint {
    key: string;
    start: number;
    end: number;
    events: number;
    total_ms: number;
    switches: number;
    device_count: number;
    average_cpu: number | null;
    maximum_cpu: number | null;
    first_battery: number | null;
    last_battery: number | null;
    global_first_battery: number | null;
    global_last_battery: number | null;
    global_device_count: number;
  }

  interface RawApp {
    process_name: string;
    duration_ms: number;
  }

  const result = await db.prepare(sql).bind(...contextWhere.values, ...activityValues).all<RawPoint>();
  const appResult = await db.prepare(appsSql).bind(...contextWhere.values, ...activityValues).all<RawApp>();
  const rows = result.results ?? [];
  const populated: OverviewPoint[] = rows.map((row) => ({
    key: row.key,
    start: Number(row.start),
    end: Number(row.end),
    events: Number(row.events ?? 0),
    totalMs: Number(row.total_ms ?? 0),
    switches: Number(row.switches ?? 0),
    averageCpu: row.average_cpu === null ? null : Number(Number(row.average_cpu).toFixed(1)),
    maximumCpu: row.maximum_cpu === null ? null : Number(row.maximum_cpu),
    batteryDelta: Number(row.device_count) !== 1 || row.first_battery === null || row.last_battery === null
      ? null
      : Number((Number(row.last_battery) - Number(row.first_battery)).toFixed(1)),
  }));

  // Return a stable calendar series, including empty days/months. This keeps
  // the API useful to non-React clients and makes the dashboard's x-axis show
  // all 31 days or all 12 months instead of only buckets with events.
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
    if (existing) return existing;
    const localBoundary = filters.granularity === "day"
      ? Date.parse(`${key}T00:00:00Z`)
      : Date.parse(`${key}-01T00:00:00Z`);
    const nextBoundary = filters.granularity === "day"
      ? localBoundary + 86_400_000
      : (() => {
        const date = new Date(localBoundary);
        date.setUTCMonth(date.getUTCMonth() + 1);
        return date.getTime();
      })();
    return {
      key,
      start: localBoundary - offsetMs,
      end: nextBoundary - offsetMs,
      events: 0,
      totalMs: 0,
      switches: 0,
      averageCpu: null,
      maximumCpu: null,
      batteryDelta: null,
    };
  });

  const first = rows.find((row) => row.global_first_battery !== null);
  const last = rows.find((row) => row.global_last_battery !== null);
  const cpuCount = points.reduce((sum, point) => sum + point.events, 0);
  const weightedCpu = points.reduce(
    (sum, point) => sum + (point.averageCpu === null ? 0 : point.averageCpu * point.events),
    0,
  );
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
    apps: (appResult.results ?? []).map((row) => ({
      processName: row.process_name,
      durationMs: Number(row.duration_ms ?? 0),
    })),
    summary: {
      totalMs: points.reduce((sum, point) => sum + point.totalMs, 0),
      switches: points.reduce((sum, point) => sum + point.switches, 0),
      events: points.reduce((sum, point) => sum + point.events, 0),
      averageCpu: cpuCount ? Number((weightedCpu / cpuCount).toFixed(1)) : null,
      maximumCpu,
      batteryDelta: first && last && Number(first.global_device_count) === 1 && first.global_first_battery !== null && last.global_last_battery !== null
        ? Number((Number(last.global_last_battery) - Number(first.global_first_battery)).toFixed(1))
        : null,
    },
  };
}
