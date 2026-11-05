import {
  authConfigured,
  clearDetailsSessionCookie,
  clearSessionCookie,
  createDashboardSession,
  createDetailsSession,
  dashboardAuthEnabled,
  detailsAuthEnabled,
  hasDashboardSession,
  hasDetailsSession,
  hasIngestAccess,
  secretEquals,
} from "./auth";
import { HttpError, json, methodNotAllowed, readJson, securityHeaders } from "./http";
import { computeOverviewFromEvents } from "./overview";
import { computeReport } from "./report";
import {
  decodeSamples,
  encodeSample,
  readEventsForRange,
  toActivityRow,
  utcDay,
  type SampleTuple,
  type StoredEvent,
} from "./storage";
import type { ActivityEventPayload, ActivityRow, Env } from "./types";
import { parseFilters, parseOverviewFilters, validateEvent } from "./validation";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Merge validated events into the collapsed activity_days table. Events are
 * grouped by (device, UTC day, application) so each affected key costs one read
 * plus one upsert instead of one write per sample. Existing samples with the
 * same id are treated as duplicates and skipped.
 *
 * Returns the number of newly accepted samples (duplicates excluded).
 */
async function mergeSamples(db: D1Database, valid: ActivityEventPayload[]): Promise<number> {
  interface Group {
    deviceId: string;
    day: number;
    process: string;
    incoming: StoredEvent[];
  }
  const groups = new Map<string, Group>();
  for (const event of valid) {
    const observedAt = Date.parse(event.observedAt);
    const day = utcDay(observedAt);
    const key = `${event.device.id}\u0000${day}\u0000${event.activity.processName}`;
    let group = groups.get(key);
    if (!group) {
      group = { deviceId: event.device.id, day, process: event.activity.processName, incoming: [] };
      groups.set(key, group);
    }
    group.incoming.push({
      id: event.id,
      deviceId: event.device.id,
      observedAt,
      processName: event.activity.processName,
      windowTitle: event.activity.windowTitle,
      cpuPercent: event.metrics.cpuPercent,
      memoryPercent: event.metrics.memoryPercent,
      batteryPercent: event.metrics.batteryPercent,
      powerPlugged: event.metrics.powerPlugged,
      trigger: event.trigger,
    });
  }

  if (groups.size === 0) return 0;

  // Read the existing JSON blobs for all affected keys in one query.
  const keyClauses: string[] = [];
  const keyValues: unknown[] = [];
  for (const group of groups.values()) {
    keyClauses.push("(device_id = ? AND day_utc = ? AND process_name = ?)");
    keyValues.push(group.deviceId, group.day, group.process);
  }
  const existing = await db
    .prepare(`SELECT device_id, day_utc, process_name, samples FROM activity_days WHERE ${keyClauses.join(" OR ")}`)
    .bind(...keyValues)
    .all<{ device_id: string; day_utc: number; process_name: string; samples: string }>();
  const existingByKey = new Map<string, string>();
  for (const row of existing.results ?? []) {
    existingByKey.set(`${row.device_id}\u0000${row.day_utc}\u0000${row.process_name}`, row.samples);
  }

  const statements: D1PreparedStatement[] = [];
  let accepted = 0;
  for (const [key, group] of groups) {
    // Idempotency key: a retried upload keeps the same observedAt and process,
    // so this recognises duplicates without storing a client UUID. Across the
    // full dataset this pair is unique per device.
    const seen = new Set<number>();
    const merged: SampleTuple[] = [];
    // Preserve already-stored samples (they are authoritative for dedup) ...
    for (const prior of decodeSamples(group.deviceId, group.process, existingByKey.get(key) ?? null)) {
      if (seen.has(prior.observedAt)) continue;
      seen.add(prior.observedAt);
      merged.push(encodeSample(prior));
    }
    // ... then append genuinely new samples from this batch.
    for (const event of group.incoming) {
      if (seen.has(event.observedAt)) continue;
      seen.add(event.observedAt);
      merged.push(encodeSample(event));
      accepted += 1;
    }
    // Keep samples ordered by time so the decoder can replay a timeline.
    merged.sort((a, b) => a[0] - b[0]);
    statements.push(
      db
        .prepare(
          `INSERT INTO activity_days (device_id, day_utc, process_name, sample_count, samples)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(device_id, day_utc, process_name) DO UPDATE SET
             sample_count = excluded.sample_count,
             samples = excluded.samples`,
        )
        .bind(group.deviceId, group.day, group.process, merged.length, JSON.stringify(merged)),
    );
  }

  await db.batch(statements);
  return accepted;
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

  await env.DB.batch(statements);

  // Merge the incoming samples into the per-(device, UTC day, application) JSON
  // blobs. Grouping first means one read + upsert per affected key rather than
  // one write per sample.
  const accepted = await mergeSamples(env.DB, valid);

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
  const session = await createDashboardSession(env.SESSION_SECRET);
  return json(
    { authenticated: true, session: session.value },
    200,
    { "set-cookie": session.cookie },
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
  const session = await createDetailsSession(env.SESSION_SECRET);
  return json(
    { authenticated: true, detailsSession: session.value },
    200,
    { "set-cookie": session.cookie },
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

// Read aggregation results are cached for a short window so that repeated
// dashboard loads (flipping between filters, re-opening a view, refreshing)
// do not re-scan the same rows again. The cache key includes the full query
// string, so each distinct filter combination is cached independently.
const READ_CACHE_SECONDS = 300;

async function withReadCache(
  request: Request,
  env: Env,
  compute: () => Promise<Response>,
): Promise<Response> {
  // Opt-in only: enabled via the READ_CACHE var in production. Keeping it off
  // by default means tests and preview environments always see fresh data.
  const cache = env.READ_CACHE === "1" && typeof caches !== "undefined" ? caches.default : undefined;
  if (!cache) return compute();
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("x-cache", "HIT");
    return hit;
  }
  const response = await compute();
  if (response.status === 200) {
    const body = await response.clone().text();
    const stored = new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${READ_CACHE_SECONDS}`,
      },
    });
    // Do not await: caching must never delay or fail the response.
    if (typeof (cache as { put?: unknown }).put === "function") {
      await cache.put(cacheKey, stored).catch(() => undefined);
    }
  }
  return response;
}

async function report(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const denied = await requireDashboardAccess(request, env);
  if (denied) return denied;
  return withReadCache(request, env, () => computeReportResponse(env, url));
}

async function computeReportResponse(env: Env, url: URL): Promise<Response> {
  const filters = parseFilters(url);
  const events = await readEventsForRange(env.DB, filters);
  const rows = await withDeviceNames(env, events);
  const truncated = rows.length > 20_000;
  return json(computeReport(rows.slice(0, 20_000), filters, truncated));
}

/**
 * Read day rows, decode to flat events, and attach device names. Sorted by
 * device then observed_at then id to match the previous SQL ordering.
 */
async function withDeviceNames(env: Env, events: StoredEvent[]): Promise<ActivityRow[]> {
  if (events.length === 0) return [];
  const devices = await env.DB.prepare("SELECT id, name FROM devices").all<{ id: string; name: string }>();
  const names = new Map((devices.results ?? []).map((row) => [row.id, row.name]));
  const rows = events.map((event) => toActivityRow(event, names.get(event.deviceId) ?? ""));
  rows.sort((a, b) =>
    a.device_id.localeCompare(b.device_id) || a.observed_at - b.observed_at || a.id.localeCompare(b.id));
  return rows;
}

async function overview(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const denied = await requireDashboardAccess(request, env);
  if (denied) return denied;
  return withReadCache(request, env, async () => {
    const filters = parseOverviewFilters(url);
    // Month/year overviews are computed directly from the collapsed day rows.
    // Read the full device range (no app/title filter) so each sample's duration
    // is measured against its true neighbouring sample; the app/title filters
    // are applied inside the computation, matching the original semantics.
    const events = await readEventsForRange(env.DB, filters, { applyActivityFilters: false });
    return json(computeOverviewFromEvents(events, filters));
  });
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
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(10, requestedLimit)) : 50;

  const stored = await readEventsForRange(env.DB, filters);
  const devices = await env.DB.prepare("SELECT id, name FROM devices").all<{ id: string; name: string }>();
  const names = new Map((devices.results ?? []).map((row) => [row.id, row.name]));

  // Newest first, matching the previous DESC ordering, id as tie-breaker.
  stored.sort((a, b) => b.observedAt - a.observedAt || b.id.localeCompare(a.id));
  const filtered = cursor
    ? stored.filter((event) => event.observedAt < cursor.at || (event.observedAt === cursor.at && event.id < cursor.id))
    : stored;
  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  const last = page.at(-1);
  return json({
    items: page.map((event) => ({
      id: event.id,
      deviceId: event.deviceId,
      deviceName: names.get(event.deviceId) ?? "",
      observedAt: event.observedAt,
      processName: event.processName,
      windowTitle: event.windowTitle,
      cpuPercent: event.cpuPercent,
      memoryPercent: event.memoryPercent,
      batteryPercent: event.batteryPercent,
      powerPlugged: event.powerPlugged,
      trigger: event.trigger,
    })),
    nextCursor: hasMore && last ? encodeCursor({ at: last.observedAt, id: last.id }) : null,
  });
}

async function filters(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const denied = await requireDashboardAccess(request, env);
  if (denied) return denied;
  const [devices, apps] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, manufacturer, model FROM devices ORDER BY name COLLATE NOCASE"),
    env.DB.prepare("SELECT DISTINCT process_name FROM activity_days ORDER BY process_name COLLATE NOCASE"),
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
  if (url.pathname === "/api/v1/overview") return overview(request, env, url);
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
