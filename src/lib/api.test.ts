import { afterEach, describe, expect, it, vi } from "vitest";
import { api, saveDashboardSession, saveDetailsSession } from "./api";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("mobile session fallback", () => {
  it("sends stored signed sessions when cookies are unavailable", async () => {
    saveDashboardSession("dashboard-token");
    saveDetailsSession("details-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/auth/status");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(init.credentials).toBe("include");
    expect(headers.get("x-activity-session")).toBe("dashboard-token");
    expect(headers.get("x-activity-details-session")).toBe("details-token");
  });
});
