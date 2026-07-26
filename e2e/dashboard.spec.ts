import { expect, test, type Page } from "@playwright/test";

const base = new Date();
base.setHours(8, 0, 0, 0);
const at = (minutes: number) => base.getTime() + minutes * 60_000;

const report = {
  summary: { totalMs: 14_400_000, switches: 18, events: 64, averageCpu: 22.4, maximumCpu: 79.1, batteryDelta: -16 },
  apps: [
    { processName: "code.exe", durationMs: 7_200_000 },
    { processName: "chrome.exe", durationMs: 4_500_000 },
    { processName: "WindowsTerminal.exe", durationMs: 1_800_000 },
  ],
  timeline: [
    { deviceId: "pc-1", deviceName: "工作电脑", processName: "code.exe", windowTitle: "Activity Recorder", start: at(0), end: at(90), durationMs: 5_400_000 },
    { deviceId: "pc-1", deviceName: "工作电脑", processName: "chrome.exe", windowTitle: "Cloudflare Dashboard", start: at(90), end: at(150), durationMs: 3_600_000 },
    { deviceId: "pc-1", deviceName: "工作电脑", processName: "WindowsTerminal.exe", windowTitle: "PowerShell", start: at(150), end: at(180), durationMs: 1_800_000 },
  ],
  metrics: Array.from({ length: 18 }, (_, index) => ({
    at: at(index * 10), deviceId: "pc-1", cpuPercent: 12 + (index * 7) % 55,
    memoryPercent: 43 + index * 0.6, batteryPercent: 92 - index,
    powerPlugged: index < 3,
  })),
  truncated: false,
};

const events = {
  items: report.timeline.map((item, index) => ({
    id: `event-${index}`, deviceId: item.deviceId, deviceName: item.deviceName,
    observedAt: item.start, processName: item.processName, windowTitle: item.windowTitle,
    cpuPercent: 20 + index * 8, memoryPercent: 45, batteryPercent: 90 - index * 4,
    powerPlugged: index === 0, trigger: index ? "window_change" : "heartbeat",
  })),
  nextCursor: null,
};

async function mockApi(page: Page) {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { enabled: false, configured: true, authenticated: true } }));
  await page.route("**/api/v1/filters", (route) => route.fulfill({ json: {
    devices: [{ id: "pc-1", name: "工作电脑", manufacturer: "Example", model: "Model A" }],
    apps: ["code.exe", "chrome.exe", "WindowsTerminal.exe"],
  } }));
  await page.route("**/api/v1/report?*", (route) => route.fulfill({ json: report }));
  await page.route("**/api/v1/events?*", (route) => route.fulfill({ json: events }));
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} dashboard is rendered without page overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "今天干了什么" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "活动时间线" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "应用活动分布" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "采样明细" })).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(2);
    await expect(page.locator(".app-activity-segment")).toHaveCount(3);
    await page.waitForTimeout(300);

    const hasPaintedCanvas = await page.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (!context || canvas.width === 0 || canvas.height === 0) return false;
      return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
    });
    expect(hasPaintedCanvas).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/dashboard-${viewport.name}.png`, fullPage: true });
  });
}
