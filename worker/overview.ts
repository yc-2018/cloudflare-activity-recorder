import type { OverviewFilters, OverviewPoint, OverviewSummary } from "./types";
import { decodeSamples, type OverviewDayRow, type StoredEvent } from "./storage";

const MAX_SAMPLE_MS = 300_000;

/**
 * Build the overview (day/month buckets) from collapsed day rows. Rows are
 * streamed one device/day at a time so a year view never holds every decoded
 * sample in memory at once.
 *
 * Each sample contributes at most five minutes (capped by the next sample on
 * the same device and the range end), with LockScreen/Desktop contributing no
 * tracked time. A sample that crosses a bucket boundary spills into the next
 * bucket. Neighbours for interval capping always come from the full list, even
 * when an app/title filter is active.
 */
export function computeOverviewFromDayRows(rows: OverviewDayRow[], filters: OverviewFilters) {
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
    key: string;
    start: number;
    end: number;
    events: number;
    totalMs: number;
    switches: number;
  }
  const buckets = new Map<string, Bucket>();
  const ensure = (start: number): Bucket => {
    const key = keyOf(start);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, start, end: endOf(start), events: 0, totalMs: 0, switches: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const appDuration = new Map<string, number>();

  const matchesActivity = (event: StoredEvent): boolean => {
    if (filters.app && event.processName !== filters.app) return false;
    if (filters.query && !event.windowTitle.toLowerCase().includes(filters.query.toLowerCase())) return false;
    return true;
  };

  const addEvent = (event: StoredEvent, next: StoredEvent | null): void => {
    const passive = event.processName === "LockScreen" || event.processName === "Desktop";
    const rawEnd = passive
      ? event.observedAt
      : Math.min(next ? next.observedAt : effectiveTo, event.observedAt + MAX_SAMPLE_MS, effectiveTo);

    const startBucket = ensure(startOf(event.observedAt));
    startBucket.events += 1;
    if (next && (next.processName !== event.processName || next.windowTitle !== event.windowTitle)) {
      startBucket.switches += 1;
    }

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
  };

  let currentDevice: string | null = null;
  let currentDay: number | null = null;
  let dayEvents: StoredEvent[] = [];
  let pending: StoredEvent | null = null;

  const flushDay = (): void => {
    if (dayEvents.length === 0) return;
    dayEvents.sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
    for (const event of dayEvents) {
      if (!matchesActivity(event)) {
        if (pending) {
          addEvent(pending, event);
          pending = null;
        }
        continue;
      }
      if (pending) addEvent(pending, event);
      pending = event;
    }
    dayEvents = [];
  };

  const flushDevice = (): void => {
    flushDay();
    if (pending) {
      addEvent(pending, null);
      pending = null;
    }
  };

  for (const row of rows) {
    if (row.device_id !== currentDevice) {
      flushDevice();
      currentDevice = row.device_id;
      currentDay = null;
    }
    if (row.day_utc !== currentDay) {
      flushDay();
      currentDay = row.day_utc;
    }
    for (const event of decodeSamples(row.device_id, row.process_name, row.samples)) {
      if (event.observedAt < filters.from || event.observedAt >= filters.to) continue;
      dayEvents.push(event);
    }
  }
  flushDevice();

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
    const bucket = buckets.get(key);
    return {
      key,
      start,
      end: endOf(start),
      events: bucket?.events ?? 0,
      totalMs: bucket?.totalMs ?? 0,
      switches: bucket?.switches ?? 0,
    };
  });

  const apps = [...appDuration.entries()]
    .map(([processName, durationMs]) => ({ processName, durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs || a.processName.localeCompare(b.processName))
    .slice(0, filters.granularity === "month" ? 50 : 10);

  const summary: OverviewSummary = {
    totalMs: points.reduce((sum, point) => sum + point.totalMs, 0),
    switches: points.reduce((sum, point) => sum + point.switches, 0),
    events: points.reduce((sum, point) => sum + point.events, 0),
  };

  return {
    granularity: filters.granularity,
    from: filters.from,
    to: filters.to,
    hasData: points.some((point) => point.events > 0 || point.totalMs > 0),
    points,
    apps,
    summary,
  };
}
