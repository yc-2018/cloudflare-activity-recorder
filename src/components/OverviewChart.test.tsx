import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OverviewPoint } from "../types";
import { OverviewChart } from "./OverviewChart";

const points: OverviewPoint[] = [
  { key: "2026-07-01", start: 0, end: 86_400_000, events: 2, totalMs: 600_000, switches: 1, averageCpu: 20, maximumCpu: 40, batteryDelta: -1 },
  { key: "2026-07-02", start: 86_400_000, end: 172_800_000, events: 0, totalMs: 0, switches: 0, averageCpu: null, maximumCpu: null, batteryDelta: null },
];

describe("OverviewChart", () => {
  it("shows custom hover facts and drills into a selected bucket", () => {
    const select = vi.fn();
    const { container } = render(<OverviewChart points={points} fromIndex={0} toIndex={1} granularity="day" onSelect={select} />);
    const bars = container.querySelectorAll<HTMLButtonElement>(".overview-bar");
    expect(bars).toHaveLength(2);
    fireEvent.pointerMove(bars[0], { clientX: 120, clientY: 80 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("2026-07-01");
    expect(screen.getByRole("tooltip")).toHaveTextContent("10 分钟");
    fireEvent.click(bars[0]);
    expect(select).toHaveBeenCalledWith(points[0]);
  });
});
