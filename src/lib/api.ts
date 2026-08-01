export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DASHBOARD_SESSION_KEY = "activity_dashboard_session";
const DETAILS_SESSION_KEY = "activity_details_session";

function sessionValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSessionValue(key: string, value: string | null): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Some privacy modes disable web storage; the HttpOnly cookie remains primary.
  }
}

export function saveDashboardSession(value: string): void {
  setSessionValue(DASHBOARD_SESSION_KEY, value);
}

export function saveDetailsSession(value: string): void {
  setSessionValue(DETAILS_SESSION_KEY, value);
}

export function clearDashboardSession(): void {
  setSessionValue(DASHBOARD_SESSION_KEY, null);
}

export function clearDetailsSession(): void {
  setSessionValue(DETAILS_SESSION_KEY, null);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const dashboardSession = sessionValue(DASHBOARD_SESSION_KEY);
  const detailsSession = sessionValue(DETAILS_SESSION_KEY);
  if (dashboardSession && !headers.has("x-activity-session")) headers.set("x-activity-session", dashboardSession);
  if (detailsSession && !headers.has("x-activity-details-session")) headers.set("x-activity-details-session", detailsSession);
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) throw new ApiError(response.status, body.message ?? `请求失败 (${response.status})`);
  return body as T;
}
