import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Report } from "../types";
import { AppActivityTimeline, defaultActivityView } from "./AppActivityTimeline";
import { Timeline } from "./Timeline";

function segment(
  processName: string,
  start: number,
  end: number,
  windowTitle: string,
): Report["timeline"][number] {
  return {
    deviceId: "device-1",
    deviceName: "工作电脑",
    processName,
    windowTitle,
    start,
    end,
    durationMs: end - start,
  };
}

describe("activity timeline tooltips", () => {
  it("defaults today's distribution range to the current time", () => {
    const hour = 60 * 60_000;
    expect(defaultActivityView(0, 24 * hour, 9 * hour)).toEqual({ from: 0, to: 9 * hour });
    expect(defaultActivityView(0, 24 * hour, 30 * hour)).toEqual({ from: 0, to: 24 * hour });
  });

  it("shows an immediate custom tooltip for a timeline segment", () => {
    const { container } = render(
      <Timeline
        timeline={[segment("code.exe", 1_000, 5_000, "Activity Recorder")]}
        from={0}
        to={10_000}
      />,
    );
    const item = container.querySelector<HTMLElement>(".timeline-segment")!;

    expect(item).not.toHaveAttribute("title");
    fireEvent.pointerMove(item, { clientX: 120, clientY: 80 });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("code.exe");
    expect(tooltip).toHaveTextContent("Activity Recorder");
    expect(tooltip).toHaveTextContent("工作电脑");

    fireEvent.pointerLeave(item);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("tracks a time across every app row without clickable app controls", () => {
    const { container } = render(
      <AppActivityTimeline
        timeline={[
          segment("code.exe", 1_000, 4_000, "Project"),
          segment("chrome.exe", 6_000, 9_000, "Cloudflare"),
        ]}
        from={0}
        to={10_000}
      />,
    );
    const body = container.querySelector<HTMLElement>(".app-activity-body")!;
    const track = container.querySelector<HTMLElement>(".app-activity-track")!;
    track.getBoundingClientRect = () => ({
      x: 100, y: 0, left: 100, right: 1_100, top: 0, bottom: 20,
      width: 1_000, height: 20, toJSON: () => ({}),
    });
    body.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, right: 1_100, top: 0, bottom: 80,
      width: 1_100, height: 80, toJSON: () => ({}),
    });

    expect(within(body).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.pointerMove(body, { clientX: 300, clientY: 50 });
    expect(container.querySelector(".app-activity-crosshair")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("code.exe");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Project");

    fireEvent.pointerMove(body, { clientX: 550, clientY: 50 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("此时间点没有活动记录");

    fireEvent.pointerLeave(body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("filters the app distribution by a local time range and resets it", () => {
    const minute = 60_000;
    const { container } = render(
      <AppActivityTimeline
        timeline={[
          segment("code.exe", 2 * minute, 10 * minute, "Project"),
          segment("chrome.exe", 40 * minute, 50 * minute, "Cloudflare"),
        ]}
        from={0}
        to={60 * minute}
      />,
    );

    expect(container.querySelectorAll(".app-activity-row")).toHaveLength(2);
    fireEvent.change(within(container).getByRole("slider", { name: "应用活动显示开始时间" }), {
      target: { value: 30 * minute },
    });
    expect(container.querySelectorAll(".app-activity-row")).toHaveLength(1);
    expect(container.querySelector(".app-activity-label")).toHaveTextContent("chrome.exe");

    fireEvent.change(within(container).getByRole("slider", { name: "应用活动显示结束时间" }), {
      target: { value: 35 * minute },
    });
    expect(screen.getByText("所选时间范围没有应用活动")).toBeInTheDocument();

    fireEvent.click(within(container).getByRole("button", { name: "恢复完整时间范围" }));
    expect(container.querySelectorAll(".app-activity-row")).toHaveLength(2);
  });
});
