import type { Report } from "../types";

export interface AppActivityPoint {
  app: string;
  deviceName: string;
  start: number;
  end: number;
  durationMs: number;
  titles: string[];
}

const PASSIVE_APPS = new Set(["LockScreen", "Desktop"]);

export function mergeAppActivity(timeline: Report["timeline"]): AppActivityPoint[] {
  const devices = new Map<string, Report["timeline"]>();
  for (const segment of timeline) {
    if (segment.durationMs <= 0 || PASSIVE_APPS.has(segment.processName)) continue;
    const list = devices.get(segment.deviceId) ?? [];
    list.push(segment);
    devices.set(segment.deviceId, list);
  }

  const result: AppActivityPoint[] = [];
  for (const segments of devices.values()) {
    segments.sort((left, right) => left.start - right.start);
    let current: AppActivityPoint | null = null;
    for (const segment of segments) {
      if (
        current && current.app === segment.processName &&
        segment.start >= current.end && segment.start - current.end <= 1_000
      ) {
        current.end = Math.max(current.end, segment.end);
        current.durationMs += segment.durationMs;
        if (segment.windowTitle && !current.titles.includes(segment.windowTitle) && current.titles.length < 3) {
          current.titles.push(segment.windowTitle);
        }
      } else {
        current = {
          app: segment.processName,
          deviceName: segment.deviceName,
          start: segment.start,
          end: segment.end,
          durationMs: segment.durationMs,
          titles: segment.windowTitle ? [segment.windowTitle] : [],
        };
        result.push(current);
      }
    }
  }
  return result.sort((left, right) => left.start - right.start);
}
