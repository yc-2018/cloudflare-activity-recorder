import { describe, expect, it, vi } from "vitest";
import { computeReport } from "./report";
import type { ActivityRow } from "./types";

function row(id: string, at: number, app = "code.exe", title = "Project"): ActivityRow {
  return {
    id, device_id: "device", device_name: "PC", observed_at: at,
    process_name: app, window_title: title, cpu_percent: 20,
    memory_percent: 40, battery_percent: 80, power_plugged: 0, trigger: "heartbeat",
  };
}

describe("computeReport", () => {
  it("merges continuous heartbeats and caps a missing interval at five minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const report = computeReport(
      [row("a", 1_000_000), row("b", 1_300_000), row("c", 1_900_000, "chrome.exe", "Web")],
      { from: 900_000, to: 2_500_000 },
    );
    expect(report.timeline[0].durationMs).toBe(600_000);
    expect(report.timeline[1].durationMs).toBe(100_000);
    expect(report.summary.totalMs).toBe(700_000);
    expect(report.summary.switches).toBe(1);
    vi.restoreAllMocks();
  });

  it("keeps lock and desktop markers out of tracked time and app rankings", () => {
    const report = computeReport(
      [row("a", 1_000_000, "LockScreen", "锁屏"), row("b", 1_600_000, "Desktop", "桌面")],
      { from: 900_000, to: 2_000_000 },
    );
    expect(report.summary.totalMs).toBe(0);
    expect(report.apps).toEqual([]);
    expect(report.timeline.map((item) => item.durationMs)).toEqual([0, 0]);
  });
});
