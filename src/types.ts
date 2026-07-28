export interface AuthStatus {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  detailsEnabled: boolean;
  detailsAuthenticated: boolean;
}

export interface DeviceOption {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
}

export interface FilterOptions {
  devices: DeviceOption[];
  apps: string[];
}

export interface Report {
  summary: {
    totalMs: number;
    switches: number;
    events: number;
    averageCpu: number | null;
    maximumCpu: number | null;
    batteryDelta: number | null;
  };
  apps: Array<{ processName: string; durationMs: number }>;
  timeline: Array<{
    deviceId: string;
    deviceName: string;
    processName: string;
    windowTitle: string;
    start: number;
    end: number;
    durationMs: number;
  }>;
  metrics: Array<{
    at: number;
    deviceId: string;
    cpuPercent: number;
    memoryPercent: number;
    batteryPercent: number | null;
    powerPlugged: boolean | null;
  }>;
  truncated: boolean;
}

export interface ActivityEvent {
  id: string;
  deviceId: string;
  deviceName: string;
  observedAt: number;
  processName: string;
  windowTitle: string;
  cpuPercent: number;
  memoryPercent: number;
  batteryPercent: number | null;
  powerPlugged: boolean | null;
  trigger: "window_change" | "heartbeat";
}

export interface EventPage {
  items: ActivityEvent[];
  nextCursor: string | null;
}
