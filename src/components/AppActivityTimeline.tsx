import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { RotateCcw } from "lucide-react";
import { mergeAppActivity } from "../lib/activity";
import { formatDuration } from "../lib/date";
import type { Report } from "../types";
import { FloatingTooltip } from "./FloatingTooltip";

const colors = ["#26736a", "#d4573f", "#b58324", "#5573a3", "#7c5d8f", "#52744a", "#a05462"];
const MINIMUM_VIEW_MS = 5 * 60_000;

function colorFor(value: string): string {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

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
  const [view, setView] = useState({ from, to });
  useEffect(() => {
    setView({ from, to });
    setCursor(null);
  }, [from, to]);

  const allIntervals = useMemo(() => mergeAppActivity(timeline), [timeline]);
  const grouped = useMemo(() => {
    const intervals = allIntervals.filter((interval) => interval.end >= view.from && interval.start <= view.to);
    const byApp = new Map<string, typeof intervals>();
    const durationByApp = new Map<string, number>();
    for (const interval of intervals) {
      const items = byApp.get(interval.app) ?? [];
      items.push(interval);
      byApp.set(interval.app, items);
      const visibleDuration = Math.max(0, Math.min(view.to, interval.end) - Math.max(view.from, interval.start));
      durationByApp.set(interval.app, (durationByApp.get(interval.app) ?? 0) + visibleDuration);
    }
    const apps = [...byApp.keys()].sort(
      (left, right) => (durationByApp.get(right) ?? 0) - (durationByApp.get(left) ?? 0),
    );
    return { apps, byApp, intervals };
  }, [allIntervals, view.from, view.to]);
  const { apps, byApp, intervals } = grouped;
  const fullSpan = Math.max(1, to - from);
  const span = Math.max(1, view.to - view.from);
  const minimumView = Math.min(MINIMUM_VIEW_MS, fullSpan);
  const rangeStep = Math.max(1, Math.min(60_000, Math.floor(fullSpan / 1_000)));
  const isFiltered = view.from > from || view.to < to;
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
    const time = view.from + span * ratio;
    const bodyBounds = event.currentTarget.getBoundingClientRect();
    setCursor({
      time,
      lineLeft: x - bodyBounds.left,
      x,
      y: event.clientY,
      active: intervals.filter((interval) => time >= interval.start && time <= interval.end),
    });
  }, [intervals, span, view.from]);
  const rows = useMemo(() => apps.map((app) => (
    <div className="app-activity-row" key={app}>
      <div className="app-activity-label">{app}</div>
      <div className="app-activity-track">
        {byApp.get(app)!.map((interval, index) => {
          const clippedStart = Math.max(view.from, interval.start);
          const clippedEnd = Math.min(view.to, interval.end);
          const left = Math.max(0, (clippedStart - view.from) / span * 100);
          const width = Math.max(0, (clippedEnd - clippedStart) / span * 100);
          return (
            <span
              className="app-activity-segment"
              key={`${interval.start}-${index}`}
              style={{ left: `${left}%`, width: `${width}%`, background: colorFor(app) }}
              aria-hidden="true"
            />
          );
        })}
      </div>
    </div>
  )), [apps, byApp, span, view.from, view.to]);
  if (!allIntervals.length) return <div className="empty-chart">暂无应用活动分布</div>;

  return (
    <div className="app-activity-widget">
      {intervals.length ? (
        <div className="app-activity-scroll">
          <div className="app-activity-timeline">
            <div className="app-activity-axis" aria-hidden="true">
              {[0, 25, 50, 75, 100].map((percent) => (
                <span key={percent} style={{ left: `${percent}%` }}>
                  {formatTimestamp(view.from + span * percent / 100)}
                </span>
              ))}
            </div>
            <div className="app-activity-body" onPointerMove={updateCursor} onPointerLeave={() => setCursor(null)}>
              {rows}
              {cursor && <span className="app-activity-crosshair" style={{ left: cursor.lineLeft }} aria-hidden="true" />}
            </div>
          </div>
        </div>
      ) : <div className="empty-chart app-activity-empty">所选时间范围没有应用活动</div>}

      <div className="app-activity-range-filter">
        <div className="app-activity-range-heading">
          <div>
            <span>显示范围</span>
            <strong>{formatTimestamp(view.from)} - {formatTimestamp(view.to)}</strong>
          </div>
          <button
            className="icon-button app-activity-range-reset"
            type="button"
            aria-label="恢复完整时间范围"
            title="恢复完整时间范围"
            disabled={!isFiltered}
            onClick={() => {
              setView({ from, to });
              setCursor(null);
            }}
          >
            <RotateCcw size={15} />
          </button>
        </div>
        <div className="app-activity-range-slider">
          <span className="app-activity-range-rail" aria-hidden="true" />
          <span
            className="app-activity-range-selection"
            style={{
              left: `${(view.from - from) / fullSpan * 100}%`,
              width: `${(view.to - view.from) / fullSpan * 100}%`,
            }}
            aria-hidden="true"
          />
          <input
            className="app-activity-range-input"
            type="range"
            min={from}
            max={to}
            step={rangeStep}
            value={view.from}
            aria-label="应用活动显示开始时间"
            aria-valuetext={formatTimestamp(view.from)}
            onChange={(event) => {
              const value = Math.min(Number(event.currentTarget.value), view.to - minimumView);
              setView((current) => ({ ...current, from: value }));
              setCursor(null);
            }}
          />
          <input
            className="app-activity-range-input"
            type="range"
            min={from}
            max={to}
            step={rangeStep}
            value={view.to}
            aria-label="应用活动显示结束时间"
            aria-valuetext={formatTimestamp(view.to)}
            onChange={(event) => {
              const value = Math.max(Number(event.currentTarget.value), view.from + minimumView);
              setView((current) => ({ ...current, to: value }));
              setCursor(null);
            }}
          />
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
