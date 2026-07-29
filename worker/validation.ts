import { HttpError } from "./http";
import type { ActivityEventPayload, OverviewFilters, QueryFilters } from "./types";

const MAX_REPORT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if ((!allowEmpty && !cleaned) || cleaned.length > max) return null;
  return cleaned;
}

function percentage(value: unknown, nullable: true): number | null | undefined;
function percentage(value: unknown, nullable?: false): number | undefined;
function percentage(value: unknown, nullable = false): number | null | undefined {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return undefined;
  }
  return Math.round(value * 10) / 10;
}

export function validateEvent(value: unknown): ActivityEventPayload | null {
  const event = object(value);
  const device = object(event?.device);
  const activity = object(event?.activity);
  const metrics = object(event?.metrics);
  if (!event || !device || !activity || !metrics) return null;

  const id = text(event.id, 64);
  const observedAt = text(event.observedAt, 40);
  const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  const trigger = event.trigger;
  const deviceId = text(device.id, 64);
  const name = text(device.name, 128);
  const manufacturer = text(device.manufacturer, 128);
  const model = text(device.model, 128);
  const osVersion = text(device.osVersion, 256);
  const cpuModel = text(device.cpuModel, 256);
  const processName = text(activity.processName, 128);
  const windowTitle = text(activity.windowTitle, 512, true);
  const cpuPercent = percentage(metrics.cpuPercent);
  const memoryPercent = percentage(metrics.memoryPercent);
  const batteryPercent = percentage(metrics.batteryPercent, true);
  const powerPlugged = metrics.powerPlugged;

  if (
    !id || !observedAt || !Number.isFinite(observedMs) ||
    (trigger !== "window_change" && trigger !== "heartbeat") ||
    !deviceId || !name || !manufacturer || !model || !osVersion || !cpuModel ||
    !processName || windowTitle === null || cpuPercent === undefined ||
    memoryPercent === undefined || batteryPercent === undefined ||
    (powerPlugged !== null && typeof powerPlugged !== "boolean")
  ) {
    return null;
  }

  return {
    id,
    observedAt: new Date(observedMs).toISOString(),
    trigger,
    device: { id: deviceId, name, manufacturer, model, osVersion, cpuModel },
    activity: { processName, windowTitle },
    metrics: { cpuPercent, memoryPercent, batteryPercent, powerPlugged },
  };
}

export function parseFilters(url: URL): QueryFilters {
  const from = Date.parse(url.searchParams.get("from") ?? "");
  const to = Date.parse(url.searchParams.get("to") ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new HttpError(400, "invalid_range", "from and to must be a valid ascending ISO date range");
  }
  if (to - from > MAX_REPORT_RANGE_MS) {
    throw new HttpError(400, "range_too_large", "A report can cover at most 7 days");
  }
  const deviceId = text(url.searchParams.get("device"), 64) ?? undefined;
  const app = text(url.searchParams.get("app"), 128) ?? undefined;
  const query = text(url.searchParams.get("q"), 200) ?? undefined;
  return { from, to, deviceId, app, query };
}

/**
 * Parse the bounded, server-side aggregation range used by month/year views.
 * Detailed reports intentionally keep their seven-day limit; overview queries
 * use grouped SQL and may cover one calendar year.
 */
export function parseOverviewFilters(url: URL): OverviewFilters {
  const granularity = url.searchParams.get("granularity");
  if (granularity !== "day" && granularity !== "month") {
    throw new HttpError(400, "invalid_granularity", "granularity must be day or month");
  }
  const from = Date.parse(url.searchParams.get("from") ?? "");
  const to = Date.parse(url.searchParams.get("to") ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new HttpError(400, "invalid_range", "from and to must be a valid ascending ISO date range");
  }
  const maximum = granularity === "day"
    ? 32 * 24 * 60 * 60 * 1000
    : 367 * 24 * 60 * 60 * 1000;
  if (to - from > maximum) {
    throw new HttpError(400, "range_too_large", granularity === "day"
      ? "A daily overview can cover at most 32 days"
      : "A monthly overview can cover at most 367 days");
  }
  const parsedOffset = Number(url.searchParams.get("tzOffset") ?? "0");
  const tzOffset = Number.isInteger(parsedOffset) ? Math.min(840, Math.max(-840, parsedOffset)) : 0;
  const deviceId = text(url.searchParams.get("device"), 64) ?? undefined;
  const app = text(url.searchParams.get("app"), 128) ?? undefined;
  const query = text(url.searchParams.get("q"), 200) ?? undefined;
  return { from, to, deviceId, app, query, granularity, tzOffset };
}

export function buildWhere(filters: QueryFilters, includeActivity = true): { sql: string; values: unknown[] } {
  const clauses = ["e.observed_at >= ?", "e.observed_at < ?"];
  const values: unknown[] = [filters.from, filters.to];
  if (filters.deviceId) {
    clauses.push("e.device_id = ?");
    values.push(filters.deviceId);
  }
  if (includeActivity && filters.app) {
    clauses.push("e.process_name = ?");
    values.push(filters.app);
  }
  if (includeActivity && filters.query) {
    clauses.push("e.window_title LIKE ? ESCAPE '\\'");
    values.push(`%${filters.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  return { sql: clauses.join(" AND "), values };
}
