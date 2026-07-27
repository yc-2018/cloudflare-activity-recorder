import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { mergeAppActivity } from "../lib/activity";
import { formatDuration } from "../lib/date";
import type { Report } from "../types";
import { FloatingTooltip } from "./FloatingTooltip";

const colors = ["#26736a", "#d4573f", "#b58324", "#5573a3", "#7c5d8f", "#52744a", "#a05462"];

interface AppActivityTimelineProps {
  timeline: Report["timeline"];
  from: number;
  to: number;
}

interface CursorState {
  time: number;
  lineLeft: number;
  x: number;
  y: number;
  active: ReturnType<typeof mergeAppActivity>;
}

export function AppActivityTimeline({ timeline, from, to }: AppActivityTimelineProps) {
  const [cursor, setCursor] = useState<CursorState | null>(null);
  const grouped = useMemo(() => {
    const intervals = mergeAppActivity(timeline);
    const byApp = new Map<string, typeof intervals>();
    const durationByApp = new Map<string, number>();
    for (const interval of intervals) {
      const items = byApp.get(interval.app) ?? [];
      items.push(interval);
      byApp.set(interval.app, items);
      durationByApp.set(interval.app, (durationByApp.get(interval.app) ?? 0) + interval.durationMs);
    }
    const apps = [...byApp.keys()].sort(
      (left, right) => (durationByApp.get(right) ?? 0) - (durationByApp.get(left) ?? 0),
    );
    return { apps, byApp, intervals };
  }, [timeline]);
  const { apps, byApp, intervals } = grouped;
  const span = Math.max(1, to - from);
  const updateCursor = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const track = event.currentTarget.querySelector<HTMLElement>(".app-activity-track");
    if (!track) return;
    const trackBounds = track.getBoundingClientRect();
    if (event.clientX < trackBounds.left || event.clientX > trackBounds.right || trackBounds.width <= 0) {
      setCursor(null);
      return;
    }
    const x = Math.max(trackBounds.left, Math.min(event.clientX, trackBounds.right));
    const ratio = (x - trackBounds.left) / trackBounds.width;
    const time = from + span * ratio;
    const bodyBounds = event.currentTarget.getBoundingClientRect();
    setCursor({
      time,
      lineLeft: x - bodyBounds.left,
      x,
      y: event.clientY,
      active: intervals.filter((interval) => time >= interval.start && time <= interval.end),
    });
  }, [from, intervals, span]);
  const rows = useMemo(() => apps.map((app, appIndex) => (
    <div className="app-activity-row" key={app}>
      <div className="app-activity-label">{app}</div>
      <div className="app-activity-track">
        {byApp.get(app)!.map((interval, index) => {
          const clippedStart = Math.max(from, interval.start);
          const clippedEnd = Math.min(to, interval.end);
          const left = Math.max(0, (clippedStart - from) / span * 100);
          const width = Math.max(0, (clippedEnd - clippedStart) / span * 100);
          return (
            <span
              className="app-activity-segment"
              key={`${interval.start}-${index}`}
              style={{ left: `${left}%`, width: `${width}%`, background: colors[appIndex % colors.length] }}
              aria-hidden="true"
            />
          );
        })}
      </div>
    </div>
  )), [apps, byApp, from, span, to]);
  if (!intervals.length) return <div className="empty-chart">暂无应用活动分布</div>;

  return (
    <div className="app-activity-scroll">
      <div className="app-activity-timeline">
        <div className="app-activity-axis" aria-hidden="true">
          {[0, 25, 50, 75, 100].map((percent) => (
            <span key={percent} style={{ left: `${percent}%` }}>
              {new Date(from + span * percent / 100).toLocaleString([], {
                month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
              })}
            </span>
          ))}
        </div>
        <div className="app-activity-body" onPointerMove={updateCursor} onPointerLeave={() => setCursor(null)}>
          {rows}
          {cursor && <span className="app-activity-crosshair" style={{ left: cursor.lineLeft }} aria-hidden="true" />}
        </div>
      </div>
      {cursor && (
        <FloatingTooltip x={cursor.x} y={cursor.y} revision={`${Math.round(cursor.time)}-${cursor.active.length}`}>
          <time className="hover-tooltip-time">{new Date(cursor.time).toLocaleString()}</time>
          {cursor.active.length ? (
            <div className="hover-tooltip-activities">
              {cursor.active.slice(0, 6).map((interval, index) => (
                <div className="hover-tooltip-activity" key={`${interval.app}-${interval.start}-${index}`}>
                  <strong>{interval.app}</strong>
                  <span>{interval.deviceName} · {formatDuration(interval.durationMs)}</span>
                  {interval.titles[0] && <small>{interval.titles[0]}</small>}
                </div>
              ))}
              {cursor.active.length > 6 && <div className="hover-tooltip-more">另有 {cursor.active.length - 6} 条活动</div>}
            </div>
          ) : <div className="hover-tooltip-empty">此时间点没有活动记录</div>}
        </FloatingTooltip>
      )}
    </div>
  );
}
