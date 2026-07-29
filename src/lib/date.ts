export function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localDateString(date);
}

export function addMonths(value: string, amount: number): string {
  const date = new Date(`${value.slice(0, 7)}-01T12:00:00`);
  date.setMonth(date.getMonth() + amount);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function addYears(value: string, amount: number): string {
  const year = Number(value.slice(0, 4));
  return String(year + amount);
}

export function localMonthRange(month: string): { fromIso: string; toIso: string } {
  const next = addMonths(month, 1);
  return {
    fromIso: new Date(`${month}-01T00:00:00`).toISOString(),
    toIso: new Date(`${next}-01T00:00:00`).toISOString(),
  };
}

export function localYearRange(year: string): { fromIso: string; toIso: string } {
  const next = String(Number(year) + 1);
  return {
    fromIso: new Date(`${year}-01-01T00:00:00`).toISOString(),
    toIso: new Date(`${next}-01-01T00:00:00`).toISOString(),
  };
}

export function monthDays(month: string): number {
  const start = new Date(`${month}-01T12:00:00`);
  const next = new Date(start);
  next.setMonth(next.getMonth() + 1);
  return Math.round((next.getTime() - start.getTime()) / 86_400_000);
}

export function inclusiveRange(from: string, to: string): { fromIso: string; toIso: string } {
  return {
    fromIso: new Date(`${from}T00:00:00`).toISOString(),
    toIso: new Date(`${addDays(to, 1)}T00:00:00`).toISOString(),
  };
}

export function rangeDays(from: string, to: string): number {
  const start = new Date(`${from}T12:00:00`).getTime();
  const end = new Date(`${to}T12:00:00`).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}
