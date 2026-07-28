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
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    enabled: false, configured: true, authenticated: true,
    detailsEnabled: false, detailsAuthenticated: true,
  } }));
  await page.route("**/api/v1/filters", (route) => route.fulfill({ json: {
    devices: [{ id: "pc-1", name: "工作电脑", manufacturer: "Example", model: "Model A" }],
    apps: ["code.exe", "chrome.exe", "WindowsTerminal.exe"],
  } }));
  await page.route("**/api/v1/report?*", (route) => route.fulfill({ json: report }));
  await page.route("**/api/v1/events?*", (route) => route.fulfill({ json: events }));
}

test("details password locks only the event table", async ({ page }) => {
  let detailsAuthenticated = false;
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    enabled: false,
    configured: true,
    authenticated: true,
    detailsEnabled: true,
    detailsAuthenticated,
  } }));
  await page.route("**/api/auth/details/login", async (route) => {
    const body = route.request().postDataJSON() as { password?: string };
    if (body.password !== "details-secret") {
      await route.fulfill({ status: 401, json: { message: "采样明细密码不正确" } });
      return;
    }
    detailsAuthenticated = true;
    await route.fulfill({ json: { authenticated: true } });
  });
  await page.route("**/api/auth/details/logout", (route) => {
    detailsAuthenticated = false;
    return route.fulfill({ json: { authenticated: false } });
  });
  await page.route("**/api/v1/filters", (route) => route.fulfill({ json: {
    devices: [{ id: "pc-1", name: "工作电脑", manufacturer: "Example", model: "Model A" }],
    apps: ["code.exe", "chrome.exe", "WindowsTerminal.exe"],
  } }));
  await page.route("**/api/v1/report?*", (route) => route.fulfill({ json: report }));
  await page.route("**/api/v1/events?*", (route) => route.fulfill({ json: events }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "活动时间线" })).toBeVisible();
  await expect(page.getByText("采样明细已保护")).toBeVisible();
  await expect(page.locator(".table-panel table")).toHaveCount(0);
  await page.screenshot({ path: "test-results/dashboard-details-locked-desktop.png", fullPage: true });

  await page.getByLabel("采样明细密码").fill("wrong");
  await page.getByRole("button", { name: "解锁明细" }).click();
  await expect(page.getByRole("alert")).toContainText("采样明细密码不正确");

  await page.getByLabel("采样明细密码").fill("details-secret");
  await page.getByRole("button", { name: "解锁明细" }).click();
  await expect(page.locator(".table-panel table")).toBeVisible();

  await page.getByRole("button", { name: "锁定采样明细" }).click();
  await expect(page.getByText("采样明细已保护")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByLabel("采样明细密码")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/dashboard-details-locked-mobile.png", fullPage: true });
});

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
    await expect(page.locator(".app-activity-body button")).toHaveCount(0);
    const rangeStart = page.getByRole("slider", { name: "应用活动显示开始时间" });
    const rangeReset = page.getByRole("button", { name: "恢复完整时间范围" });
    await expect(rangeStart).toBeVisible();
    await expect(page.getByRole("slider", { name: "应用活动显示结束时间" })).toBeVisible();
    await expect(rangeReset).toBeDisabled();
    await rangeStart.focus();
    await page.keyboard.press("ArrowRight");
    await expect(rangeReset).toBeEnabled();
    await rangeReset.click();
    await expect(rangeReset).toBeDisabled();

    await page.locator(".timeline-segment").first().hover();
    await expect(page.getByRole("tooltip")).toContainText("Activity Recorder");

    await page.locator(".app-activity-segment").first().hover();
    await expect(page.locator(".app-activity-crosshair")).toBeVisible();
    await expect(page.getByRole("tooltip")).toContainText("code.exe");
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
