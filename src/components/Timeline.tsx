import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Report } from "../types";
import { formatDuration } from "../lib/date";
import { FloatingTooltip } from "./FloatingTooltip";

function colorFor(value: string): string {
  const colors = ["#26736a", "#d4573f", "#b58324", "#5573a3", "#7c5d8f", "#52744a", "#a05462"];
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

interface TimelineProps {
  timeline: Report["timeline"];
  from: number;
  to: number;
}

export function Timeline({ timeline, from, to }: TimelineProps) {
  const [hovered, setHovered] = useState<{
    item: Report["timeline"][number];
    x: number;
    y: number;
  } | null>(null);
  const span = Math.max(1, to - from);
  const devices = useMemo(() => {
    const grouped = new Map<string, { name: string; items: Report["timeline"] }>();
    for (const item of timeline) {
      const device = grouped.get(item.deviceId) ?? { name: item.deviceName, items: [] };
      device.items.push(item);
      grouped.set(item.deviceId, device);
    }
    return [...grouped.entries()];
  }, [timeline]);
  const showTooltip = useCallback((event: ReactPointerEvent<HTMLElement>, item: Report["timeline"][number]) => {
    setHovered({ item, x: event.clientX, y: event.clientY });
  }, []);
  const rows = useMemo(() => devices.map(([deviceId, device]) => (
    <div className="timeline-row" key={deviceId}>
      <div className="timeline-device" title={device.name}>{device.name}</div>
      <div className="timeline-track">
        {device.items.map((item, index) => {
          const left = Math.max(0, (item.start - from) / span * 100);
          const width = Math.max(0.2, (item.end - item.start) / span * 100);
          return (
            <div
              className="timeline-segment"
              key={`${item.start}-${index}`}
              style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: colorFor(item.processName) }}
              tabIndex={0}
              aria-label={`${item.processName}，${item.windowTitle || "无标题"}，${formatDuration(item.durationMs)}`}
              onPointerEnter={(event) => showTooltip(event, item)}
              onPointerMove={(event) => showTooltip(event, item)}
              onPointerLeave={() => setHovered(null)}
              onFocus={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setHovered({ item, x: bounds.left + bounds.width / 2, y: bounds.bottom });
              }}
              onBlur={() => setHovered(null)}
            >
              {width > 7 && <span>{item.processName}</span>}
            </div>
          );
        })}
      </div>
    </div>
  )), [devices, from, showTooltip, span]);
  if (!timeline.length) return <div className="empty-chart">此范围没有活动时间线</div>;
  return (
    <div className="timeline-scroll">
      <div className="timeline" style={{ minWidth: 760 }}>
        <div className="timeline-axis" aria-hidden="true">
          {[0, 25, 50, 75, 100].map((percent) => (
            <span key={percent} style={{ left: `${percent}%` }}>
              {new Date(from + span * percent / 100).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </span>
          ))}
        </div>
        {rows}
      </div>
      {hovered && (
        <FloatingTooltip x={hovered.x} y={hovered.y} revision={`${hovered.item.start}-${hovered.x}-${hovered.y}`}>
          <strong className="hover-tooltip-title">{hovered.item.processName}</strong>
          <div className="hover-tooltip-description">{hovered.item.windowTitle || "（无标题）"}</div>
          <dl className="hover-tooltip-facts">
            <div><dt>时间</dt><dd>{new Date(hovered.item.start).toLocaleString()} - {new Date(hovered.item.end).toLocaleTimeString()}</dd></div>
            <div><dt>时长</dt><dd>{formatDuration(hovered.item.durationMs)}</dd></div>
            <div><dt>设备</dt><dd>{hovered.item.deviceName}</dd></div>
          </dl>
        </FloatingTooltip>
      )}
    </div>
  );
}
