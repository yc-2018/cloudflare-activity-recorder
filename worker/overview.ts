import type { OverviewFilters, OverviewPoint } from "./types";
import type { StoredEvent } from "./storage";

/**
 * Build the overview (day/month buckets) directly from decoded events. This is
 * the exact, timezone-correct path: bucketing happens against local calendar
 * boundaries derived from the request's tzOffset, and each sample contributes at
 * most five minutes (capped by the next sample on the same device and the range
 * end), with LockScreen/Desktop contributing no tracked time. A sample that
 * crosses a bucket boundary spills into the next bucket.
 */
export function computeOverviewFromEvents(events: StoredEvent[], filters: OverviewFilters) {
  const offsetMs = -filters.tzOffset * 60_000;
  const effectiveTo = Math.min(filters.to, Date.now());

  const dayKey = (ts: number): string => {
    const d = new Date(ts + offsetMs);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  const monthKey = (ts: number): string => dayKey(ts).slice(0, 7);
  const keyOf = (ts: number): string => filters.granularity === "day" ? dayKey(ts) : monthKey(ts);
  const startOf = (ts: number): number => {
    const d = new Date(ts + offsetMs);
    const local = filters.granularity === "day"
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return local - offsetMs;
  };
  const endOf = (start: number): number => {
    const d = new Date(start + offsetMs);
    const local = filters.granularity === "day"
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return local - offsetMs;
  };

  interface Bucket {
    key: string; start: number; end: number;
    events: number; totalMs: number; switches: number;
    cpuSum: number; cpuCount: number; maxCpu: number | null;
    devices: Set<string>;
  }
  const buckets = new Map<string, Bucket>();
  const ensure = (start: number): Bucket => {
    const key = keyOf(start);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key, start, end: endOf(start), events: 0, totalMs: 0, switches: 0,
        cpuSum: 0, cpuCount: 0, maxCpu: null, devices: new Set(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const appDuration = new Map<string, number>();

  const byDevice = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (event.observedAt < filters.from || event.observedAt >= filters.to) continue;
    const list = byDevice.get(event.deviceId);
    if (list) list.push(event);
    else byDevice.set(event.deviceId, [event]);
  }

  for (const list of byDevice.values()) {
    list.sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
    for (let i = 0; i < list.length; i += 1) {
      const event = list[i];
      const next = list[i + 1];
      const passive = event.processName === "LockScreen" || event.processName === "Desktop";
      const rawEnd = passive
        ? event.observedAt
        : Math.min(next ? next.observedAt : effectiveTo, event.observedAt + 300_000, effectiveTo);

      // The sample itself belongs to the bucket that contains its start.
      const startBucket = ensure(startOf(event.observedAt));
      startBucket.events += 1;
      startBucket.devices.add(event.deviceId);
      startBucket.cpuSum += event.cpuPercent;
      startBucket.cpuCount += 1;
      startBucket.maxCpu = startBucket.maxCpu === null ? event.cpuPercent : Math.max(startBucket.maxCpu, event.cpuPercent);
      if (next && (next.processName !== event.processName || next.windowTitle !== event.windowTitle)) {
        startBucket.switches += 1;
      }

      // Assign the [event.observedAt, rawEnd) interval, splitting at boundaries.
      let cursor = event.observedAt;
      while (cursor < rawEnd) {
        const bucket = ensure(startOf(cursor));
        const sliceEnd = Math.min(rawEnd, bucket.end);
        const ms = Math.max(0, sliceEnd - cursor);
        if (!passive) {
          bucket.totalMs += ms;
          appDuration.set(event.processName, (appDuration.get(event.processName) ?? 0) + ms);
        }
        if (sliceEnd <= cursor) break;
        cursor = sliceEnd;
      }
    }
  }

  // Build a stable calendar series including empty buckets.
  const localStart = new Date(filters.from + offsetMs);
  const localEnd = new Date(filters.to + offsetMs);
  const keys: string[] = [];
  if (filters.granularity === "day") {
    let cursor = Date.UTC(localStart.getUTCFullYear(), localStart.getUTCMonth(), localStart.getUTCDate());
    const endCursor = Date.UTC(localEnd.getUTCFullYear(), localEnd.getUTCMonth(), localEnd.getUTCDate());
    while (cursor < endCursor) {
      const d = new Date(cursor);
      keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
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

  const points: OverviewPoint[] = keys.map((key) => {
    const start = filters.granularity === "day"
      ? Date.parse(`${key}T00:00:00Z`) - offsetMs
      : Date.parse(`${key}-01T00:00:00Z`) - offsetMs;
    const end = endOf(start);
    const bucket = buckets.get(key);
    if (!bucket) {
      return { key, start, end, events: 0, totalMs: 0, switches: 0, averageCpu: null, maximumCpu: null, batteryDelta: null };
    }
    return {
      key, start, end,
      events: bucket.events,
      totalMs: bucket.totalMs,
      switches: bucket.switches,
      averageCpu: bucket.cpuCount ? Number((bucket.cpuSum / bucket.cpuCount).toFixed(1)) : null,
      maximumCpu: bucket.maxCpu,
      batteryDelta: batteryDeltaFor(events, bucket.start, bucket.end, bucket.devices),
    };
  });

  const apps = [...appDuration.entries()]
    .map(([processName, durationMs]) => ({ processName, durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs || a.processName.localeCompare(b.processName))
    .slice(0, 10);

  const cpuCount = points.reduce((sum, point) => sum + point.events, 0);
  const weightedCpu = points.reduce((sum, point) => sum + (point.averageCpu === null ? 0 : point.averageCpu * point.events), 0);
  const maximumCpu = points.reduce<number | null>(
    (max, point) => point.maximumCpu === null ? max : max === null ? point.maximumCpu : Math.max(max, point.maximumCpu),
    null,
  );

  // Range-wide battery delta when a single device is in scope.
  const deviceSet = new Set(events.filter((e) => e.observedAt >= filters.from && e.observedAt < filters.to).map((e) => e.deviceId));
  const batteryAll = events
    .filter((e) => e.observedAt >= filters.from && e.observedAt < filters.to && e.batteryPercent !== null)
    .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));

  return {
    granularity: filters.granularity,
    from: filters.from,
    to: filters.to,
    hasData: points.some((point) => point.events > 0 || point.totalMs > 0),
    points,
    apps,
    summary: {
      totalMs: points.reduce((sum, point) => sum + point.totalMs, 0),
      switches: points.reduce((sum, point) => sum + point.switches, 0),
      events: points.reduce((sum, point) => sum + point.events, 0),
      averageCpu: cpuCount ? Number((weightedCpu / cpuCount).toFixed(1)) : null,
      maximumCpu,
      batteryDelta: deviceSet.size === 1 && batteryAll.length > 1
        ? Number((batteryAll[batteryAll.length - 1].batteryPercent! - batteryAll[0].batteryPercent!).toFixed(1))
        : null,
    },
  };
}

function batteryDeltaFor(events: StoredEvent[], start: number, end: number, devices: Set<string>): number | null {
  if (devices.size !== 1) return null;
  const list = events
    .filter((e) => e.observedAt >= start && e.observedAt < end && e.batteryPercent !== null)
    .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
  if (list.length < 2) return null;
  return Number((list[list.length - 1].batteryPercent! - list[0].batteryPercent!).toFixed(1));
}
