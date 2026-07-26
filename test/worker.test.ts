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
    expect(status).toMatchObject({ enabled: true, configured: true, authenticated: false });

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
    const cookie = await login();
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
    const cookie = await login();
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

  it("rejects malformed records without discarding valid records in the batch", async () => {
    const response = await ingest([
      sample("mixed-valid", "2026-07-26T05:00:00Z"),
      { id: "invalid" },
    ]).then((result) => result.json<Record<string, number>>());
    expect(response).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
  });
});
