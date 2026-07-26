import { mergeAppActivity } from "../lib/activity";
import { formatDuration } from "../lib/date";
import type { Report } from "../types";

const colors = ["#26736a", "#d4573f", "#b58324", "#5573a3", "#7c5d8f", "#52744a", "#a05462"];

interface AppActivityTimelineProps {
  timeline: Report["timeline"];
  from: number;
  to: number;
  onSelectApp?: (app: string) => void;
}

export function AppActivityTimeline({ timeline, from, to, onSelectApp }: AppActivityTimelineProps) {
  const intervals = mergeAppActivity(timeline);
  if (!intervals.length) return <div className="empty-chart">暂无应用活动分布</div>;

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
  const span = Math.max(1, to - from);

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
        {apps.map((app, appIndex) => (
          <div className="app-activity-row" key={app}>
            <button className="app-activity-label" onClick={() => onSelectApp?.(app)} title={`只看 ${app}`}>{app}</button>
            <div className="app-activity-track">
              {byApp.get(app)!.map((interval, index) => {
                const clippedStart = Math.max(from, interval.start);
                const clippedEnd = Math.min(to, interval.end);
                const left = Math.max(0, (clippedStart - from) / span * 100);
                const width = Math.max(0, (clippedEnd - clippedStart) / span * 100);
                const startLabel = new Date(interval.start).toLocaleString();
                const endLabel = new Date(interval.end).toLocaleString();
                const detail = [
                  app,
                  `${startLabel} - ${endLabel}`,
                  formatDuration(interval.durationMs),
                  interval.deviceName,
                  ...interval.titles,
                ].join("\n");
                return (
                  <button
                    className="app-activity-segment"
                    key={`${interval.start}-${index}`}
                    style={{ left: `${left}%`, width: `${width}%`, background: colors[appIndex % colors.length] }}
                    onClick={() => onSelectApp?.(app)}
                    title={detail}
                    aria-label={`${app}，${startLabel} 至 ${endLabel}，${formatDuration(interval.durationMs)}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
