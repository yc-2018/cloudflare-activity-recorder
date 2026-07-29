import { useState, type PointerEvent } from "react";
import { formatDuration } from "../lib/date";
import type { OverviewPoint } from "../types";
import { FloatingTooltip } from "./FloatingTooltip";

interface OverviewChartProps {
  points: OverviewPoint[];
  fromIndex: number;
  toIndex: number;
  granularity: "day" | "month";
  onSelect: (point: OverviewPoint) => void;
}

function labelFor(point: OverviewPoint, granularity: "day" | "month") {
  if (granularity === "day") return String(Number(point.key.slice(-2)));
  return `${Number(point.key.slice(5, 7))}月`;
}

function fullLabel(point: OverviewPoint, granularity: "day" | "month") {
  if (granularity === "day") return point.key;
  return `${point.key}月`;
}

export function OverviewChart({ points, fromIndex, toIndex, granularity, onSelect }: OverviewChartProps) {
  const [hover, setHover] = useState<{ point: OverviewPoint; x: number; y: number } | null>(null);
  if (!points.length) return <div className="empty-chart">当前范围没有统计数据</div>;

  const visible = points.slice(fromIndex, toIndex + 1);
  const maximum = Math.max(...visible.map((point) => point.totalMs), 0);
  const eventMaximum = Math.max(...visible.map((point) => point.events), 0);
  const scaleMaximum = maximum || eventMaximum || 1;

  function move(event: PointerEvent<HTMLButtonElement>, point: OverviewPoint) {
    setHover({ point, x: event.clientX, y: event.clientY });
  }

  return (
    <div className="overview-chart" onPointerLeave={() => setHover(null)}>
      <div className="overview-bars" role="list" aria-label={granularity === "day" ? "按天统计" : "按月统计"}>
        {visible.map((point) => {
          const height = maximum
            ? Math.max(3, (point.totalMs / scaleMaximum) * 100)
            : Math.max(3, (point.events / scaleMaximum) * 100);
          return (
            <button
              type="button"
              role="listitem"
              className="overview-bar"
              key={point.key}
              aria-label={`${fullLabel(point, granularity)}，${formatDuration(point.totalMs)}，${point.events} 条记录`}
              onPointerMove={(event) => move(event, point)}
              onFocus={(event) => setHover({ point, x: event.currentTarget.getBoundingClientRect().left, y: event.currentTarget.getBoundingClientRect().top })}
              onBlur={() => setHover(null)}
              onClick={() => onSelect(point)}
            >
              <span className="overview-bar-track"><span className="overview-bar-fill" style={{ height: `${height}%` }} /></span>
              <span className="overview-bar-label">{labelFor(point, granularity)}</span>
            </button>
          );
        })}
      </div>
      {hover && (
        <FloatingTooltip x={hover.x} y={hover.y} revision={`${hover.point.key}-${hover.x}-${hover.y}`}>
          <strong className="hover-tooltip-title">{fullLabel(hover.point, granularity)}</strong>
          <dl className="hover-tooltip-facts">
            <div><dt>时长</dt><dd>{formatDuration(hover.point.totalMs)}</dd></div>
            <div><dt>事件</dt><dd>{hover.point.events}</dd></div>
            <div><dt>切换</dt><dd>{hover.point.switches}</dd></div>
            <div><dt>CPU</dt><dd>{hover.point.averageCpu === null ? "--" : `${hover.point.averageCpu}%`}</dd></div>
          </dl>
          <span className="overview-tooltip-hint">点击查看{granularity === "day" ? "当天" : "当月"}</span>
        </FloatingTooltip>
      )}
    </div>
  );
}
