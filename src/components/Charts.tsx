import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  TimeScale,
  Title,
  Tooltip,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";
import type { DeviceOption, Report } from "../types";
import { formatDuration } from "../lib/date";

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, TimeScale, Tooltip, Legend, Title, Filler);

const grid = "rgba(22, 34, 43, 0.08)";
const text = "#59656f";

export function AppDurationChart({ apps, onSelectApp }: { apps: Report["apps"]; onSelectApp?: (app: string) => void }) {
  if (!apps.length) return <div className="empty-chart">暂无应用时长数据</div>;
  return (
    <Bar
      data={{
        labels: apps.map((item) => item.processName),
        datasets: [{
          label: "使用分钟",
          data: apps.map((item) => Math.round(item.durationMs / 60_000)),
          backgroundColor: "#26736a",
          borderRadius: 3,
          barThickness: 18,
        }],
      }}
      options={{
        indexAxis: "y",
        maintainAspectRatio: false,
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (context) => formatDuration(apps[context.dataIndex].durationMs) } },
        },
        onClick: (_event, elements) => {
          const selected = elements[0];
          if (selected && onSelectApp) onSelectApp(apps[selected.index].processName);
        },
        onHover: (event, elements) => {
          const target = event.native?.target as HTMLElement | null;
          if (target) target.style.cursor = elements.length && onSelectApp ? "pointer" : "default";
        },
        scales: {
          x: { beginAtZero: true, grid: { color: grid }, ticks: { color: text, precision: 0 } },
          y: { grid: { display: false }, ticks: { color: text } },
        },
      }}
    />
  );
}

export function MetricsChart({ metrics }: { metrics: Report["metrics"] }) {
  if (!metrics.length) return <div className="empty-chart">暂无系统指标数据</div>;
  const labels = metrics.map((item) => new Date(item.at).toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }));
  return (
    <Line
      data={{
        labels,
        datasets: [
          { label: "CPU", data: metrics.map((item) => item.cpuPercent), borderColor: "#d4573f", backgroundColor: "#d4573f", pointRadius: 0, borderWidth: 1.8, tension: 0.2 },
          { label: "内存", data: metrics.map((item) => item.memoryPercent), borderColor: "#26736a", backgroundColor: "#26736a", pointRadius: 0, borderWidth: 1.8, tension: 0.2 },
          {
            label: "电量",
            data: metrics.map((item) => item.batteryPercent),
            borderColor: "#b58324",
            backgroundColor: "#b58324",
            pointRadius: metrics.map((item) => item.powerPlugged ? 3 : 0),
            pointStyle: "triangle",
            borderWidth: 1.8,
            spanGaps: true,
            tension: 0.2,
          },
        ],
      }}
      options={{
        maintainAspectRatio: false,
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom", labels: { color: text, usePointStyle: true, boxWidth: 8 } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: text, maxTicksLimit: 8, maxRotation: 0 } },
          y: { min: 0, max: 100, grid: { color: grid }, ticks: { color: text, callback: (value) => `${value}%` } },
        },
      }}
    />
  );
}

interface DeviceMetricsChartsProps {
  metrics: Report["metrics"];
  devices: DeviceOption[];
}

export function DeviceMetricsCharts({ metrics, devices }: DeviceMetricsChartsProps) {
  const names = new Map(devices.map((device) => [device.id, device.name]));
  const grouped = new Map<string, Report["metrics"]>();
  for (const metric of metrics) {
    const items = grouped.get(metric.deviceId) ?? [];
    items.push(metric);
    grouped.set(metric.deviceId, items);
  }

  const groups = [...grouped.entries()].map(([deviceId, items]) => ({
    deviceId,
    deviceName: names.get(deviceId) ?? deviceId,
    metrics: items,
  }));

  if (groups.length <= 1) {
    return <div className="chart-body metrics-chart-body"><MetricsChart metrics={metrics} /></div>;
  }

  return (
    <div className="device-metrics-grid" aria-label="按设备显示的系统状态">
      {groups.map((group) => (
        <section className="device-metrics-card" key={group.deviceId} aria-label={`${group.deviceName} 系统状态`}>
          <h3 title={group.deviceName}>{group.deviceName}</h3>
          <div className="device-metrics-chart"><MetricsChart metrics={group.metrics} /></div>
        </section>
      ))}
    </div>
  );
}
