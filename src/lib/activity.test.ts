import { describe, expect, it } from "vitest";
import { mergeAppActivity } from "./activity";
import type { Report } from "../types";

function segment(processName: string, start: number, end: number, title: string): Report["timeline"][number] {
  return {
    deviceId: "device", deviceName: "PC", processName, windowTitle: title,
    start, end, durationMs: end - start,
  };
}

describe("mergeAppActivity", () => {
  it("merges continuous title changes within the same application", () => {
    const points = mergeAppActivity([
      segment("chrome.exe", 1_000, 2_000, "Page A"),
      segment("chrome.exe", 2_000, 4_000, "Page B"),
      segment("code.exe", 4_000, 5_000, "Project"),
      segment("chrome.exe", 5_000, 6_000, "Page C"),
    ]);
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ app: "chrome.exe", start: 1_000, end: 4_000, durationMs: 3_000 });
    expect(points[0].titles).toEqual(["Page A", "Page B"]);
  });

  it("excludes lock and desktop state markers", () => {
    expect(mergeAppActivity([
      segment("LockScreen", 1_000, 1_000, "锁屏"),
      segment("Desktop", 2_000, 2_000, "桌面"),
    ])).toEqual([]);
  });
});
