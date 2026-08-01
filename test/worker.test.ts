import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../worker";
import type { Env } from "../worker/types";

const BASE = "https://activity-recorder.test";

function sample(id: string, observedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    observedAt,
    trigger: "window_change",
    device: {
      id: "device-1",
      name: "工作电脑",
      manufacturer: "Example",
      model: "Model A",
      osVersion: "Windows 11",
      cpuModel: "Example CPU",
    },
    activity: { processName: "code.exe", windowTitle: "Activity Recorder" },
    metrics: { cpuPercent: 12.5, memoryPercent: 43.2, batteryPercent: 78, powerPlugged: true },
    ...overrides,
  };
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-dashboard-password" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

async function detailsLogin(): Promise<string> {
  const response = await SELF.fetch(`${BASE}/api/auth/details/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-details-password" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

async function eventReadCookies(): Promise<string> {
  return `${await login()}; ${await detailsLogin()}`;
}

async function ingest(events: unknown[], token = "test-ingest-token-123456789") {
  return SELF.fetch(`${BASE}/api/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
}

describe("Worker API", () => {
  it("rejects an invalid ingest token", async () => {
    const response = await ingest([sample("bad-auth", "2026-07-26T00:00:00Z")], "incorrect-token");
    expect(response.status).toBe(401);
  });

  it("requires the dashboard password and issues a signed session", async () => {
    const status = await SELF.fetch(`${BASE}/api/auth/status`).then((response) => response.json<Record<string, boolean>>());
    expect(status).toMatchObject({
      enabled: true,
      configured: true,
      authenticated: false,
      detailsEnabled: true,
      detailsAuthenticated: false,
    });

    const denied = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(denied.status).toBe(401);

    const cookie = await login();
    const allowed = await SELF.fetch(`${BASE}/api/v1/filters`, { headers: { cookie } });
    expect(allowed.status).toBe(200);
  });

  it("accepts the signed session header when a browser cannot retain cookies", async () => {
    const response = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-dashboard-password" }),
    });
    const body = await response.json<{ session: string }>();
    expect(body.session).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Expires=");

    const allowed = await SELF.fetch(`${BASE}/api/v1/filters`, {
      headers: { "x-activity-session": body.session },
    });
    expect(allowed.status).toBe(200);
  });

  it("requires the independent details password for event rows", async () => {
    const dashboardCookie = await login();
    const query = "from=2026-07-26T00%3A00%3A00.000Z&to=2026-07-27T00%3A00%3A00.000Z";
    const denied = await SELF.fetch(`${BASE}/api/v1/events?${query}`, { headers: { cookie: dashboardCookie } });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: "details_auth_required" });

    const detailsCookie = await detailsLogin();
    const allowed = await SELF.fetch(`${BASE}/api/v1/events?${query}`, {
      headers: { cookie: `${dashboardCookie}; ${detailsCookie}` },
    });
    expect(allowed.status).toBe(200);
  });

  it("allows dashboard reads when no dashboard password is configured", async () => {
    const publicEnv: Env = {
      DB: env.DB,
      ASSETS: env.ASSETS,
      INGEST_TOKEN: env.INGEST_TOKEN,
      SESSION_SECRET: env.SESSION_SECRET,
    };
    const statusResponse = await worker.fetch(new Request(`${BASE}/api/auth/status`), publicEnv);
    expect(await statusResponse.json()).toMatchObject({ enabled: false, configured: true, authenticated: true });
    const filtersResponse = await worker.fetch(new Request(`${BASE}/api/v1/filters`), publicEnv);
    expect(filtersResponse.status).toBe(200);
  });

  it("allows event details with only the dashboard password configured", async () => {
    const mainOnlyEnv: Env = {
      DB: env.DB,
      ASSETS: env.ASSETS,
      INGEST_TOKEN: env.INGEST_TOKEN,
      DASHBOARD_PASSWORD: env.DASHBOARD_PASSWORD,
      SESSION_SECRET: env.SESSION_SECRET,
    };
    const loginResponse = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
    }), mainOnlyEnv);
    const cookie = loginResponse.headers.get("set-cookie")!.split(";")[0];
    const response = await worker.fetch(new Request(
      `${BASE}/api/v1/events?from=2026-07-26T00%3A00%3A00.000Z&to=2026-07-27T00%3A00%3A00.000Z`,
      { headers: { cookie } },
    ), mainOnlyEnv);
    expect(response.status).toBe(200);
  });

  it("keeps month/year overview behind only the dashboard password", async () => {
    const denied = await SELF.fetch(`${BASE}/api/v1/overview?granularity=day&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z`);
    expect(denied.status).toBe(401);
    const allowed = await SELF.fetch(`${BASE}/api/v1/overview?granularity=day&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z`, { headers: { cookie: await login() } });
    expect(allowed.status).toBe(200);
  });

  it("keeps overviews public but day details locked when only a details password is configured", async () => {
    const detailsOnlyEnv: Env = {
      DB: env.DB,
      ASSETS: env.ASSETS,
      INGEST_TOKEN: env.INGEST_TOKEN,
      DETAILS_PASSWORD: env.DETAILS_PASSWORD,
      SESSION_SECRET: env.SESSION_SECRET,
    };
    const query = "from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z";
    const overviewResponse = await worker.fetch(new Request(
      `${BASE}/api/v1/overview?granularity=day&${query}`,
    ), detailsOnlyEnv);
    expect(overviewResponse.status).toBe(200);
    const eventResponse = await worker.fetch(new Request(
      `${BASE}/api/v1/events?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-02T00%3A00%3A00.000Z`,
    ), detailsOnlyEnv);
    expect(eventResponse.status).toBe(401);
    expect(await eventResponse.json()).toMatchObject({ error: "details_auth_required" });
  });

  it("aggregates overview points and splits a sample at a day boundary", async () => {
    const device = {
      id: "overview-device", name: "Overview PC", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest([
      sample("overview-boundary-a", "2026-07-01T23:59:00Z", { trigger: "heartbeat", device }),
      sample("overview-boundary-b", "2026-07-02T00:04:00Z", { trigger: "heartbeat", device }),
    ]);
    const response = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=day&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-03T00%3A00%3A00.000Z&tzOffset=0`,
      { headers: { cookie: await login() } },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ points: Array<{ key: string; totalMs: number; events: number }>; summary: { totalMs: number }; hasData: boolean }>();
    expect(body.points).toHaveLength(2);
    expect(body.hasData).toBe(true);
    expect(body.points.find((point) => point.key === "2026-07-01")).toMatchObject({ totalMs: 60_000, events: 1 });
    expect(body.points.find((point) => point.key === "2026-07-02")).toMatchObject({ totalMs: 540_000, events: 1 });
    expect(body.summary.totalMs).toBe(600_000);
  });

  it("groups a year overview by local month", async () => {
    const device = {
      id: "overview-month-device", name: "Overview Month PC", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest([
      sample("overview-month-a", "2026-01-31T23:59:00Z", { trigger: "heartbeat", device }),
      sample("overview-month-b", "2026-02-01T00:01:00Z", { trigger: "heartbeat", device }),
    ]);
    const response = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=month&from=2026-01-01T00%3A00%3A00.000Z&to=2027-01-01T00%3A00%3A00.000Z&tzOffset=0`,
      { headers: { cookie: await login() } },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ points: Array<{ key: string; totalMs: number }>; hasData: boolean }>();
    expect(body.points).toHaveLength(12);
    expect(body.hasData).toBe(true);
    expect(body.points.find((point) => point.key === "2026-01")).toMatchObject({ totalMs: 60_000 });
    expect(body.points.find((point) => point.key === "2026-02")).toMatchObject({ totalMs: 360_000 });
  });

  it("keeps neighboring applications in duration calculations when filtering", async () => {
    const device = {
      id: "overview-filter-device", name: "Overview Filter PC", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest([
      sample("overview-filter-a", "2026-03-01T00:00:00Z", { trigger: "heartbeat", device }),
      sample("overview-filter-b", "2026-03-01T00:01:00Z", { trigger: "heartbeat", device, activity: { processName: "chrome.exe", windowTitle: "Browser" } }),
    ]);
    const response = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=day&from=2026-03-01T00%3A00%3A00.000Z&to=2026-03-02T00%3A00%3A00.000Z&tzOffset=0&app=code.exe`,
      { headers: { cookie: await login() } },
    );
    const body = await response.json<{ points: Array<{ key: string; totalMs: number }> }>();
    expect(body.points.find((point) => point.key === "2026-03-01")?.totalMs).toBe(60_000);
  });

  it("returns the ten longest-running applications for overview views", async () => {
    const device = {
      id: "overview-ranking-device", name: "Overview Ranking PC", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest(Array.from({ length: 11 }, (_, index) => sample(
      `overview-ranking-${String(index).padStart(2, "0")}`,
      new Date(Date.parse("2026-04-01T00:00:00Z") + index * 60_000).toISOString(),
      {
        device,
        activity: {
          processName: `process-${String(index).padStart(2, "0")}.exe`,
          windowTitle: `Application ${index}`,
        },
      },
    )));
    const response = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=day&from=2026-04-01T00%3A00%3A00.000Z&to=2026-04-02T00%3A00%3A00.000Z&tzOffset=0`,
      { headers: { cookie: await login() } },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ apps: Array<{ processName: string; durationMs: number }> }>();
    expect(body.apps).toHaveLength(10);
    expect(body.apps[0]).toEqual({ processName: "process-10.exe", durationMs: 300_000 });
    expect(body.apps.map((item) => item.processName)).toContain("process-00.exe");
    expect(body.apps.map((item) => item.processName)).not.toContain("process-09.exe");
  });

  it("stores records in D1 and treats retried event IDs as duplicates", async () => {
    const event = sample("event-idempotent", "2026-07-26T01:00:00Z");
    const later = sample("event-device-later", "2026-07-26T02:00:00Z");
    const first = await ingest([event, later]).then((response) => response.json<Record<string, number>>());
    const second = await ingest([event]).then((response) => response.json<Record<string, number>>());
    expect(first).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(second).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    const device = await env.DB.prepare("SELECT first_seen, last_seen FROM devices WHERE id = ?")
      .bind("device-1").first<{ first_seen: number; last_seen: number }>();
    expect(device).toEqual({ first_seen: Date.parse(event.observedAt), last_seen: Date.parse(later.observedAt) });
  });

  it("uses an opaque cursor to paginate events", async () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      sample(`page-${String(index).padStart(2, "0")}`, new Date(Date.parse("2026-07-26T06:00:00Z") + index * 60_000).toISOString()),
    );
    await ingest(records);
    const cookie = await eventReadCookies();
    const query = "from=2026-07-26T06%3A00%3A00.000Z&to=2026-07-26T07%3A00%3A00.000Z&limit=10";
    const first = await SELF.fetch(`${BASE}/api/v1/events?${query}`, { headers: { cookie } })
      .then((response) => response.json<{ items: unknown[]; nextCursor: string | null }>());
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBeTruthy();
    const second = await SELF.fetch(`${BASE}/api/v1/events?${query}&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers: { cookie } })
      .then((response) => response.json<{ items: unknown[]; nextCursor: string | null }>());
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it("filters a cross-day report and paginates matching events", async () => {
    await ingest([
      sample("cross-day-a", "2026-07-25T23:59:00Z"),
      sample("cross-day-b", "2026-07-26T00:01:00Z", {
        activity: { processName: "chrome.exe", windowTitle: "Cloudflare Dashboard" },
      }),
      sample("cross-day-c", "2026-07-26T00:03:00Z", {
        activity: { processName: "chrome.exe", windowTitle: "Unrelated page" },
      }),
    ]);
    const cookie = await eventReadCookies();
    const query = "from=2026-07-26T00%3A00%3A00.000Z&to=2026-07-27T00%3A00%3A00.000Z&app=chrome.exe&q=Cloudflare";
    const reportResponse = await SELF.fetch(`${BASE}/api/v1/report?${query}`, { headers: { cookie } });
    expect(reportResponse.status).toBe(200);
    const report = await reportResponse.json<{ summary: { events: number }; timeline: unknown[] }>();
    expect(report.summary.events).toBe(1);
    expect(report.timeline).toHaveLength(1);

    const page = await SELF.fetch(`${BASE}/api/v1/events?${query}&limit=10`, { headers: { cookie } })
      .then((response) => response.json<{ items: Array<{ id: string }>; nextCursor: string | null }>());
    expect(page.items.map((item) => item.id)).toEqual(["cross-day-b"]);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects report ranges longer than seven days", async () => {
    const cookie = await login();
    const response = await SELF.fetch(
      `${BASE}/api/v1/report?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-09T00%3A00%3A00.000Z`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "range_too_large" });
  });

  it("rejects malformed records without discarding valid records in the batch", async () => {
    const response = await ingest([
      sample("mixed-valid", "2026-07-26T05:00:00Z"),
      { id: "invalid" },
    ]).then((result) => result.json<Record<string, number>>());
    expect(response).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
  });
});
