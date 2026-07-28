import {
  authConfigured,
  clearDetailsSessionCookie,
  clearSessionCookie,
  createDetailsSessionCookie,
  createSessionCookie,
  dashboardAuthEnabled,
  detailsAuthEnabled,
  hasDashboardSession,
  hasDetailsSession,
  hasIngestAccess,
  secretEquals,
} from "./auth";
import { HttpError, json, methodNotAllowed, readJson, securityHeaders } from "./http";
import { computeReport } from "./report";
import type { ActivityEventPayload, ActivityRow, Env } from "./types";
import { buildWhere, parseFilters, validateEvent } from "./validation";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function ingest(request: Request, env: Env): Promise<Response> {
  if (!env.INGEST_TOKEN) {
    return json({ error: "server_misconfigured", message: "INGEST_TOKEN is not configured" }, 503);
  }
  if (!(await hasIngestAccess(request, env))) {
    return json({ error: "unauthorized", message: "Invalid ingest token" }, 401);
  }
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const body = asObject(await readJson(request));
  if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 100) {
    throw new HttpError(400, "invalid_events", "events must be an array containing 1 to 100 records");
  }

  const valid: ActivityEventPayload[] = [];
  for (const candidate of body.events) {
    const event = validateEvent(candidate);
    if (event) valid.push(event);
  }
  if (valid.length === 0) {
    return json({ accepted: 0, duplicates: 0, rejected: body.events.length });
  }

  const devices = new Map<string, { event: ActivityEventPayload; firstSeen: number; lastSeen: number }>();
  for (const event of valid) {
    const observedAt = Date.parse(event.observedAt);
    const existing = devices.get(event.device.id);
    if (!existing) {
      devices.set(event.device.id, { event, firstSeen: observedAt, lastSeen: observedAt });
    } else {
      existing.firstSeen = Math.min(existing.firstSeen, observedAt);
      existing.lastSeen = Math.max(existing.lastSeen, observedAt);
      if (observedAt >= Date.parse(existing.event.observedAt)) existing.event = event;
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const item of devices.values()) {
    const event = item.event;
    statements.push(
      env.DB.prepare(
        `INSERT INTO devices
          (id, name, manufacturer, model, os_version, cpu_model, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           manufacturer = excluded.manufacturer,
           model = excluded.model,
           os_version = excluded.os_version,
           cpu_model = excluded.cpu_model,
           first_seen = MIN(devices.first_seen, excluded.first_seen),
           last_seen = MAX(devices.last_seen, excluded.last_seen)`,
      ).bind(
        event.device.id,
        event.device.name,
        event.device.manufacturer,
        event.device.model,
        event.device.osVersion,
        event.device.cpuModel,
        item.firstSeen,
        item.lastSeen,
      ),
    );
  }

  const insertOffset = statements.length;
  const receivedAt = Date.now();
  for (const event of valid) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO activity_events
          (id, device_id, observed_at, process_name, window_title, cpu_percent,
           memory_percent, battery_percent, power_plugged, trigger, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        event.id,
        event.device.id,
        Date.parse(event.observedAt),
        event.activity.processName,
        event.activity.windowTitle,
        event.metrics.cpuPercent,
        event.metrics.memoryPercent,
        event.metrics.batteryPercent,
        event.metrics.powerPlugged === null ? null : Number(event.metrics.powerPlugged),
        event.trigger,
        receivedAt,
      ),
    );
  }

  const results = await env.DB.batch(statements);
  const accepted = results
    .slice(insertOffset)
    .reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  return json({
    accepted,
    duplicates: valid.length - accepted,
    rejected: body.events.length - valid.length,
  });
}

async function authStatus(request: Request, env: Env): Promise<Response> {
  const enabled = dashboardAuthEnabled(env);
  const detailsEnabled = detailsAuthEnabled(env);
  const [authenticated, detailsAuthenticated] = await Promise.all([
    hasDashboardSession(request, env),
    hasDetailsSession(request, env),
  ]);
  return json({
    enabled,
    detailsEnabled,
    configured: authConfigured(env),
    authenticated,
    detailsAuthenticated,
  });
}

async function login(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!dashboardAuthEnabled(env)) return json({ authenticated: true });
  if (!env.SESSION_SECRET) {
    return json({ error: "server_misconfigured", message: "SESSION_SECRET is not configured" }, 503);
  }
  const body = asObject(await readJson(request, 10_000));
  const password = typeof body?.password === "string" ? body.password : "";
  if (!env.DASHBOARD_PASSWORD || !(await secretEquals(password, env.DASHBOARD_PASSWORD))) {
    return json({ error: "invalid_password", message: "密码不正确" }, 401);
  }
  return json(
    { authenticated: true },
    200,
    { "set-cookie": await createSessionCookie(env.SESSION_SECRET) },
  );
}

function logout(request: Request): Response {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookie() });
}

async function detailsLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!detailsAuthEnabled(env)) return json({ authenticated: true });
  if (!env.SESSION_SECRET) {
    return json({ error: "server_misconfigured", message: "SESSION_SECRET is not configured" }, 503);
  }
  const body = asObject(await readJson(request, 10_000));
  const password = typeof body?.password === "string" ? body.password : "";
  if (!env.DETAILS_PASSWORD || !(await secretEquals(password, env.DETAILS_PASSWORD))) {
    return json({ error: "invalid_password", message: "采样明细密码不正确" }, 401);
  }
  return json(
    { authenticated: true },
    200,
    { "set-cookie": await createDetailsSessionCookie(env.SESSION_SECRET) },
  );
}

function detailsLogout(request: Request): Response {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  return json({ authenticated: false }, 200, { "set-cookie": clearDetailsSessionCookie() });
}

async function requireDashboardAccess(request: Request, env: Env): Promise<Response | null> {
  if (!authConfigured(env)) {
    return json({ error: "server_misconfigured", message: "SESSION_SECRET is not configured" }, 503);
  }
  if (!(await hasDashboardSession(request, env))) {
    return json({ error: "unauthorized", message: "Dashboard login required" }, 401);
  }
  return null;
}

async function requireDetailsAccess(request: Request, env: Env): Promise<Response | null> {
  if (!authConfigured(env)) {
    return json({ error: "server_misconfigured", message: "SESSION_SECRET is not configured" }, 503);
  }
  if (!(await hasDetailsSession(request, env))) {
    return json({ error: "details_auth_required", message: "采样明细密码验证后才能查看" }, 401);
  }
  return null;
}

async function report(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const denied = await requireDashboardAccess(request, env);
  if (denied) return denied;
  const filters = parseFilters(url);
  const where = buildWhere(filters);
  const result = await env.DB.prepare(
    `SELECT e.id, e.device_id, d.name AS device_name, e.observed_at,
            e.process_name, e.window_title, e.cpu_percent, e.memory_percent,
            e.battery_percent, e.power_plugged, e.trigger
       FROM activity_events e
       JOIN devices d ON d.id = e.device_id
      WHERE ${where.sql}
      ORDER BY e.device_id, e.observed_at, e.id
      LIMIT 20001`,
  ).bind(...where.values).all<ActivityRow>();
  const rows = result.results.slice(0, 20_000);
  return json(computeReport(rows, filters, result.results.length > 20_000));
}

interface Cursor {
  at: number;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const unpadded = value.replaceAll("-", "+").replaceAll("_", "/");
    const normalized = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(normalized)) as unknown;
    const object = asObject(parsed);
    if (typeof object?.at !== "number" || typeof object.id !== "string") return null;
    return { at: object.at, id: object.id };
  } catch {
    throw new HttpError(400, "invalid_cursor", "cursor is invalid");
  }
}

async function events(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const denied = await requireDashboardAccess(request, env);
  if (denied) return denied;
  const detailsDenied = await requireDetailsAccess(request, env);
  if (detailsDenied) return detailsDenied;
  const filters = parseFilters(url);
  const where = buildWhere(filters);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(10, requestedLimit)) : 50;
  if (cursor) {
    where.sql += " AND (e.observed_at < ? OR (e.observed_at = ? AND e.id < ?))";
    where.values.push(cursor.at, cursor.at, cursor.id);
  }
  const result = await env.DB.prepare(
    `SELECT e.id, e.device_id, d.name AS device_name, e.observed_at,
            e.process_name, e.window_title, e.cpu_percent, e.memory_percent,
            e.battery_percent, e.power_plugged, e.trigger
       FROM activity_events e
       JOIN devices d ON d.id = e.device_id
      WHERE ${where.sql}
      ORDER BY e.observed_at DESC, e.id DESC
      LIMIT ?`,
  ).bind(...where.values, limit + 1).all<ActivityRow>();
  const hasMore = result.results.length > limit;
  const page = result.results.slice(0, limit);
  const last = page.at(-1);
  return json({
    items: page.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      observedAt: row.observed_at,
      processName: row.process_name,
      windowTitle: row.window_title,
      cpuPercent: row.cpu_percent,
      memoryPercent: row.memory_percent,
      batteryPercent: row.battery_percent,
      powerPlugged: row.power_plugged === null ? null : Boolean(row.power_plugged),
      trigger: row.trigger,
    })),
    nextCursor: hasMore && last ? encodeCursor({ at: last.observed_at, id: last.id }) : null,
  });
}

async function filters(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const denied = await requireDashboardAccess(request, env);
  if (denied) return denied;
  const [devices, apps] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, manufacturer, model FROM devices ORDER BY name COLLATE NOCASE"),
    env.DB.prepare("SELECT DISTINCT process_name FROM activity_events ORDER BY process_name COLLATE NOCASE"),
  ]);
  return json({
    devices: devices.results as Array<{ id: string; name: string; manufacturer: string; model: string }>,
    apps: (apps.results as Array<{ process_name: string }>).map((row) => row.process_name),
  });
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/auth/status") return authStatus(request, env);
  if (url.pathname === "/api/auth/login") return login(request, env);
  if (url.pathname === "/api/auth/logout") return logout(request);
  if (url.pathname === "/api/auth/details/login") return detailsLogin(request, env);
  if (url.pathname === "/api/auth/details/logout") return detailsLogout(request);
  if (url.pathname === "/api/v1/events" && request.method === "POST") return ingest(request, env);
  if (url.pathname === "/api/v1/events") return events(request, env, url);
  if (url.pathname === "/api/v1/report") return report(request, env, url);
  if (url.pathname === "/api/v1/filters") return filters(request, env);
  return json({ error: "not_found", message: "API route not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return securityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      console.error("Unhandled request error", error);
      return json({ error: "internal_error", message: "Unexpected server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
