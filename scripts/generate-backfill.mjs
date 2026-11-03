// Generates a standalone backfill SQL file for the hourly rollup table.
//
// The SQL mirrors worker/rollup.ts exactly (same CTE chain and per-hour insert
// select), but is emitted as plain text so it can be applied with:
//
//   npx wrangler d1 execute activity-recorder --remote --file backfill-rollup.sql
//
// Usage:
//   node scripts/generate-backfill.mjs <fromISO> <toISO> > backfill-rollup.sql
//
// It walks one UTC day at a time. Each day uses a context window padded by one
// hour before and six hours after so LEAD() sees neighbouring samples and
// duration spill across the day boundary is captured.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LOOKAHEAD_MS = 6 * HOUR_MS;

const args = process.argv.slice(2);
const fromISO = args[0] ?? "2026-07-01T00:00:00.000Z";
const toISO = args[1] ?? new Date().toISOString();
const fromMs = Date.parse(fromISO);
const toMs = Date.parse(toISO);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
  console.error("Invalid range. Usage: node scripts/generate-backfill.mjs <fromISO> <toISO>");
  process.exit(1);
}

function dayStatements(dayStart) {
  const from = dayStart;
  const to = dayStart + DAY_MS;
  const contextFrom = from - HOUR_MS;
  const contextTo = to + LOOKAHEAD_MS;
  const effectiveTo = contextTo;

  const cte = `
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
       WHERE e.observed_at >= ${contextFrom} AND e.observed_at < ${contextTo}
    ),
    bucketed AS (
      SELECT ordered_all.*,
             ((observed_at / 3600000) * 3600000) AS bucket,
             ((observed_at / 3600000) * 3600000) AS bucket_start,
             (((observed_at / 3600000) * 3600000) + 3600000) AS bucket_end,
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
      SELECT ((bucket_end / 3600000) * 3600000) AS bucket,
             bucket_end AS bucket_start,
             (((bucket_end / 3600000) * 3600000) + 3600000) AS bucket_end,
             device_id, process_name, window_title,
             0 AS event_count,
             MAX(0, raw_end - bucket_end) AS total_ms,
             0 AS switch_count,
             NULL AS cpu_percent
        FROM bucketed
       WHERE raw_end > bucket_end
         AND process_name NOT IN ('LockScreen', 'Desktop')
    )`;

  return [
    `DELETE FROM activity_rollup WHERE hour_bucket >= ${from} AND hour_bucket < ${to};`,
    `${cte}
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
     WHERE bucket >= ${from} AND bucket < ${to}
     GROUP BY device_id, bucket, process_name, window_title;`,
  ];
}

const lines = ["-- Generated rollup backfill. Apply with wrangler d1 execute --remote --file."];
for (let dayStart = Math.floor(fromMs / DAY_MS) * DAY_MS; dayStart < toMs; dayStart += DAY_MS) {
  lines.push(...dayStatements(dayStart));
}
process.stdout.write(lines.join("\n") + "\n");
