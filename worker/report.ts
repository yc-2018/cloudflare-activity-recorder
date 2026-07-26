import type { ActivityRow, QueryFilters } from "./types";

export interface TimelineSegment {
  deviceId: string;
  deviceName: string;
  processName: string;
  windowTitle: string;
  start: number;
  end: number;
  durationMs: number;
}

function downsample<T>(items: T[], maximum = 600): T[] {
  if (items.length <= maximum) return items;
  const step = items.length / maximum;
  return Array.from({ length: maximum }, (_, index) => items[Math.floor(index * step)]);
}

export function computeReport(rows: ActivityRow[], filters: QueryFilters, truncated = false) {
  const sorted = [...rows].sort(
    (a, b) => a.device_id.localeCompare(b.device_id) || a.observed_at - b.observed_at || a.id.localeCompare(b.id),
  );
  const segments: TimelineSegment[] = [];
  const appDuration = new Map<string, number>();
  let totalMs = 0;
  let switches = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index];
    const next = sorted[index + 1];
    const sameDeviceNext = next?.device_id === row.device_id ? next : undefined;
    const naturalEnd = sameDeviceNext?.observed_at ?? Math.min(filters.to, Date.now());
    const passiveState = row.process_name === "LockScreen" || row.process_name === "Desktop";
    const end = passiveState
      ? row.observed_at
      : Math.min(naturalEnd, row.observed_at + 300_000, filters.to);
    const durationMs = Math.max(0, end - row.observed_at);
    totalMs += durationMs;
    if (!passiveState) {
      appDuration.set(row.process_name, (appDuration.get(row.process_name) ?? 0) + durationMs);
    }

    const previous = segments.at(-1);
    if (
      previous && previous.deviceId === row.device_id && previous.processName === row.process_name &&
      previous.windowTitle === row.window_title && previous.end === row.observed_at
    ) {
      previous.end = end;
      previous.durationMs += durationMs;
    } else {
      segments.push({
        deviceId: row.device_id,
        deviceName: row.device_name,
        processName: row.process_name,
        windowTitle: row.window_title,
        start: row.observed_at,
        end,
        durationMs,
      });
    }

    if (
      sameDeviceNext &&
      (sameDeviceNext.process_name !== row.process_name || sameDeviceNext.window_title !== row.window_title)
    ) {
      switches += 1;
    }
  }

  const cpuValues = rows.map((row) => row.cpu_percent);
  const devices = new Set(rows.map((row) => row.device_id));
  const batteryRows = rows.filter((row) => row.battery_percent !== null).sort((a, b) => a.observed_at - b.observed_at);
  const batteryDelta = devices.size === 1 && batteryRows.length > 1
    ? Number((batteryRows.at(-1)!.battery_percent! - batteryRows[0].battery_percent!).toFixed(1))
    : null;

  const metrics = downsample(
    [...rows]
      .sort((a, b) => a.observed_at - b.observed_at)
      .map((row) => ({
        at: row.observed_at,
        deviceId: row.device_id,
        cpuPercent: row.cpu_percent,
        memoryPercent: row.memory_percent,
        batteryPercent: row.battery_percent,
        powerPlugged: row.power_plugged === null ? null : Boolean(row.power_plugged),
      })),
  );

  return {
    summary: {
      totalMs,
      switches,
      events: rows.length,
      averageCpu: cpuValues.length
        ? Number((cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length).toFixed(1))
        : null,
      maximumCpu: cpuValues.length ? Math.max(...cpuValues) : null,
      batteryDelta,
    },
    apps: [...appDuration.entries()]
      .map(([processName, durationMs]) => ({ processName, durationMs }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 12),
    timeline: segments.sort((a, b) => a.start - b.start),
    metrics,
    truncated,
  };
}
