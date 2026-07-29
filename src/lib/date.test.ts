import { describe, expect, it } from "vitest";
import { addDays, addMonths, addYears, formatDuration, inclusiveRange, localMonthRange, localYearRange } from "./date";

describe("date helpers", () => {
  it("builds inclusive local date boundaries", () => {
    const range = inclusiveRange("2026-07-26", "2026-07-26");
    expect(Date.parse(range.toIso) - Date.parse(range.fromIso)).toBe(86_400_000);
  });

  it("moves dates and formats durations", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(formatDuration(5_400_000)).toBe("1 小时 30 分");
  });

  it("moves calendar periods and builds month/year boundaries", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addYears("2026", -1)).toBe("2025");
    expect(Date.parse(localMonthRange("2026-07").toIso) - Date.parse(localMonthRange("2026-07").fromIso)).toBe(31 * 86_400_000);
    expect(Date.parse(localYearRange("2026").toIso) - Date.parse(localYearRange("2026").fromIso)).toBe(365 * 86_400_000);
  });
});
