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

  it("aggregates multiple devices and reports battery delta across the range", async () => {
    const deviceA = {
      id: "overview-multi-a", name: "A", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    const deviceB = {
      id: "overview-multi-b", name: "B", manufacturer: "Example", model: "Model B",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest([
      sample("multi-a-1", "2026-05-01T00:00:00Z", { trigger: "heartbeat", device: deviceA, metrics: { cpuPercent: 10, memoryPercent: 20, batteryPercent: 90, powerPlugged: true } }),
      sample("multi-a-2", "2026-05-01T00:01:00Z", { trigger: "heartbeat", device: deviceA, metrics: { cpuPercent: 30, memoryPercent: 20, batteryPercent: 80, powerPlugged: false } }),
      sample("multi-b-1", "2026-05-01T00:00:30Z", { trigger: "heartbeat", device: deviceB, metrics: { cpuPercent: 50, memoryPercent: 20, batteryPercent: 60, powerPlugged: false } }),
    ]);
    const response = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=day&from=2026-05-01T00%3A00%3A00.000Z&to=2026-05-02T00%3A00%3A00.000Z&tzOffset=0`,
      { headers: { cookie: await login() } },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      points: Array<{ key: string; events: number; averageCpu: number | null; maximumCpu: number | null; batteryDelta: number | null }>;
      summary: { events: number; averageCpu: number | null; maximumCpu: number | null; batteryDelta: number | null };
    }>();
    const day = body.points.find((point) => point.key === "2026-05-01")!;
    expect(day.events).toBe(3);
    // CPU averages and maxima are aggregated in SQL over all three samples.
    expect(day.maximumCpu).toBe(50);
    expect(day.averageCpu).toBe(30);
    // Two devices share the day, so the per-day battery delta is suppressed.
    expect(day.batteryDelta).toBeNull();
    // The range summary also spans two devices, so no battery delta is reported.
    expect(body.summary.events).toBe(3);
    expect(body.summary.batteryDelta).toBeNull();
  });

  it("returns an empty but complete series when a range has no records", async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=day&from=2025-01-01T00%3A00%3A00.000Z&to=2025-01-04T00%3A00%3A00.000Z&tzOffset=0`,
      { headers: { cookie: await login() } },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ points: Array<{ key: string }>; hasData: boolean; apps: unknown[] }>();
    expect(body.points.map((point) => point.key)).toEqual(["2025-01-01", "2025-01-02", "2025-01-03"]);
    expect(body.hasData).toBe(false);
    expect(body.apps).toEqual([]);
  });

  it("stores records in D1 and treats retried event IDs as duplicates", async () => {
    const event = sample("event-idempotent", "2026-07-26T01:00:00Z");
    const later = sample("event-device-later", "2026-07-26T02:00:00Z");
    const first = await ingest([event, later]).then((response) => response.json<Record<string, number>>());
    const second = await ingest([event]).then((response) => response.json<Record<string, number>>());
    expect(first).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(second).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    const device = await env.DB.prepare("SELECT first_seen, last_seen FROM devices WHERE legacy_id = ?")
      .bind("device-1").first<{ first_seen: number; last_seen: number }>();
    expect(device).toEqual({ first_seen: Date.parse(event.observedAt), last_seen: Date.parse(later.observedAt) });
  });

  it("stores a repeated window title once and decodes it back on every sample", async () => {
    const device = {
      id: "title-device", name: "Title PC", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest([
      sample("title-1", "2026-05-02T00:00:00Z", { trigger: "heartbeat", device, activity: { processName: "code.exe", windowTitle: "公司电脑💻" } }),
      sample("title-2", "2026-05-02T00:01:00Z", { trigger: "heartbeat", device, activity: { processName: "code.exe", windowTitle: "公司电脑💻" } }),
      sample("title-3", "2026-05-02T00:02:00Z", { trigger: "heartbeat", device, activity: { processName: "code.exe", windowTitle: "另一个窗口" } }),
    ]);
    const row = await env.DB.prepare(
      `SELECT samples FROM activity_days WHERE device_id = (SELECT id FROM devices WHERE legacy_id = 'title-device')`,
    ).first<{ samples: string }>();
    const tuples = JSON.parse(row!.samples) as Array<[number, string | null, ...unknown[]]>;
    expect(tuples.map((tuple) => tuple[1])).toEqual(["公司电脑💻", null, "另一个窗口"]);

    const cookie = await eventReadCookies();
    const page = await SELF.fetch(
      `${BASE}/api/v1/events?from=2026-05-02T00%3A00%3A00.000Z&to=2026-05-02T01%3A00%3A00.000Z&limit=50`,
      { headers: { cookie } },
    ).then((response) => response.json<{ items: Array<{ observedAt: number; windowTitle: string }> }>());
    expect(page.items.map((item) => item.windowTitle)).toEqual(["公司电脑💻", "公司电脑💻", "另一个窗口"]);
  });

  it("maps a hardware fingerprint to one short device id across reinstall", async () => {
    const fingerprint = "fp-test-machine-0001";
    const base = {
      name: "Fingerprint PC", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    // First install: legacy UUID id plus a fingerprint.
    await ingest([sample("fp-a", "2026-05-01T00:00:00Z", {
      trigger: "heartbeat",
      device: { id: "legacy-uuid-1111", ...base, fingerprint },
    })]);
    const first = await env.DB.prepare("SELECT id FROM devices WHERE fingerprint = ?")
      .bind(fingerprint).first<{ id: string }>();
    expect(first?.id).toBeTruthy();
    expect(/^\d+$/.test(first!.id)).toBe(true);

    // Reinstall: a brand-new local UUID but the same hardware fingerprint must
    // resolve to the same canonical device id.
    const registered = await SELF.fetch(`${BASE}/api/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-ingest-token-123456789" },
      body: JSON.stringify({ device: { id: "brand-new-uuid-2222", ...base, fingerprint } }),
    }).then((response) => response.json<{ deviceId: string }>());
    expect(registered.deviceId).toBe(first!.id);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE fingerprint = ?")
      .bind(fingerprint).first<{ n: number }>();
    expect(Number(count?.n ?? 0)).toBe(1);
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
      .then((response) => response.json<{ items: Array<{ id: string; processName: string; windowTitle: string }>; nextCursor: string | null }>());
    // Ids are synthetic now (no stored UUID), so assert on the event content.
    expect(page.items).toHaveLength(1);
    expect(page.items[0].processName).toBe("chrome.exe");
    expect(page.items[0].windowTitle).toBe("Cloudflare Dashboard");
    expect(page.items[0].id).toBeTruthy();
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

  it("collapses samples into per-day-per-app rows and serves the overview from them", async () => {
    const deviceA = {
      id: "day-a", name: "A", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    const deviceB = {
      id: "day-b", name: "B", manufacturer: "Example", model: "Model B",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest([
      sample("day-1", "2026-06-10T23:59:00Z", { trigger: "heartbeat", device: deviceA }),
      sample("day-2", "2026-06-11T00:04:00Z", { trigger: "heartbeat", device: deviceA }),
      sample("day-3", "2026-06-11T00:04:30Z", { trigger: "window_change", device: deviceA, activity: { processName: "chrome.exe", windowTitle: "Browser" } }),
      sample("day-4", "2026-06-11T00:09:00Z", { trigger: "heartbeat", device: deviceB }),
    ]);

    // Four samples across two devices and two days collapse into one row per
    // (device, day, app): deviceA/day10(code), deviceA/day11(code+chrome),
    // deviceB/day11(code) => four combinations, four samples total.
    const collapsed = await env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(sample_count) AS total FROM activity_days
        WHERE device_id IN (SELECT id FROM devices WHERE legacy_id IN ('day-a','day-b'))`,
    ).first<{ n: number; total: number }>();
    expect(Number(collapsed?.total ?? 0)).toBe(4);
    expect(Number(collapsed?.n ?? 0)).toBe(4);

    const cookie = await login();
    const body = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=day&from=2026-06-10T00%3A00%3A00.000Z&to=2026-06-12T00%3A00%3A00.000Z&tzOffset=0`,
      { headers: { cookie } },
    ).then((response) => response.json<{
      points: Array<{ key: string; totalMs: number; events: number; switches: number }>;
      summary: { events: number };
      apps: Array<{ processName: string }>;
    }>());
    expect(body.summary.events).toBe(4);
    const day10 = body.points.find((point) => point.key === "2026-06-10")!;
    // The 23:59 sample caps at 60s before the next sample closes the interval.
    expect(day10.totalMs).toBe(60_000);
    expect(body.apps.map((app) => app.processName)).toContain("chrome.exe");
  });

  it("refreshes the overview when a late sample arrives (recomputed from day rows)", async () => {
    const device = {
      id: "late-device", name: "Late", manufacturer: "Example", model: "Model A",
      osVersion: "Windows 11", cpuModel: "Example CPU",
    };
    await ingest([sample("late-1", "2026-06-20T10:00:00Z", { trigger: "heartbeat", device })]);
    await ingest([sample("late-2", "2026-06-20T10:02:00Z", { trigger: "heartbeat", device })]);

    const cookie = await login();
    const body = await SELF.fetch(
      `${BASE}/api/v1/overview?granularity=day&from=2026-06-20T00%3A00%3A00.000Z&to=2026-06-21T00%3A00%3A00.000Z&tzOffset=0`,
      { headers: { cookie } },
    ).then((response) => response.json<{ points: Array<{ key: string; totalMs: number }> }>());
    const day = body.points.find((point) => point.key === "2026-06-20")!;
    // The second heartbeat extends the first sample's duration towards its cap.
    expect(day.totalMs).toBeGreaterThanOrEqual(300_000);
  });
});
