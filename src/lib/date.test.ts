import { describe, expect, it } from "vitest";
import { addDays, formatDuration, inclusiveRange } from "./date";

describe("date helpers", () => {
  it("builds inclusive local date boundaries", () => {
    const range = inclusiveRange("2026-07-26", "2026-07-26");
    expect(Date.parse(range.toIso) - Date.parse(range.fromIso)).toBe(86_400_000);
  });

  it("moves dates and formats durations", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(formatDuration(5_400_000)).toBe("1 小时 30 分");
  });
});
