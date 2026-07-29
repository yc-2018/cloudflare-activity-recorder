export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INGEST_TOKEN?: string;
  DASHBOARD_PASSWORD?: string;
  DETAILS_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export interface DevicePayload {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  osVersion: string;
  cpuModel: string;
}

export interface ActivityEventPayload {
  id: string;
  observedAt: string;
  trigger: "window_change" | "heartbeat";
  device: DevicePayload;
  activity: {
    processName: string;
    windowTitle: string;
  };
  metrics: {
    cpuPercent: number;
    memoryPercent: number;
    batteryPercent: number | null;
    powerPlugged: boolean | null;
  };
}

export interface ActivityRow {
  id: string;
  device_id: string;
  device_name: string;
  observed_at: number;
  process_name: string;
  window_title: string;
  cpu_percent: number;
  memory_percent: number;
  battery_percent: number | null;
  power_plugged: number | null;
  trigger: "window_change" | "heartbeat";
}

export interface QueryFilters {
  from: number;
  to: number;
  deviceId?: string;
  app?: string;
  query?: string;
}

export interface OverviewFilters extends QueryFilters {
  granularity: "day" | "month";
  tzOffset: number;
}

export interface OverviewPoint {
  key: string;
  start: number;
  end: number;
  events: number;
  totalMs: number;
  switches: number;
  averageCpu: number | null;
  maximumCpu: number | null;
  batteryDelta: number | null;
}
