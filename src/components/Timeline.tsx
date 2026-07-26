import type { Report } from "../types";
import { formatDuration } from "../lib/date";

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
  const devices = [...new Map(timeline.map((item) => [item.deviceId, item.deviceName])).entries()];
  if (!timeline.length) return <div className="empty-chart">此范围没有活动时间线</div>;
  const span = Math.max(1, to - from);
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
        {devices.map(([deviceId, deviceName]) => (
          <div className="timeline-row" key={deviceId}>
            <div className="timeline-device" title={deviceName}>{deviceName}</div>
            <div className="timeline-track">
              {timeline.filter((item) => item.deviceId === deviceId).map((item, index) => {
                const left = Math.max(0, (item.start - from) / span * 100);
                const width = Math.max(0.2, (item.end - item.start) / span * 100);
                return (
                  <div
                    className="timeline-segment"
                    key={`${item.start}-${index}`}
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: colorFor(item.processName) }}
                    title={`${item.processName}\n${item.windowTitle || "（无标题）"}\n${formatDuration(item.durationMs)}`}
                  >
                    {width > 7 && <span>{item.processName}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
