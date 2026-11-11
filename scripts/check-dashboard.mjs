import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { isInDateRange, localDateKey } from "../src/utils/dateRange.js";

// Exercise calendar boundaries in both positive and negative UTC offsets.
const originalTimezone = process.env.TZ;
for (const timezone of ["Asia/Shanghai", "America/Los_Angeles"]) {
  process.env.TZ = timezone;
  const now = new Date(2026, 9, 30, 15);
  assert.equal(localDateKey("2026-10-30"), "2026-10-30");
  assert.equal(isInDateRange("2026-10-01", 30, now), true);
  assert.equal(isInDateRange("2026-09-30", 30, now), false);
  assert.equal(isInDateRange("2026-10-31", 30, now), false);
  assert.equal(isInDateRange("invalid", 0, now), false);
  assert.equal(isInDateRange(null, 0, now), false);
  assert.equal(isInDateRange("2020-01-01", 0, now), true);
}
if (originalTimezone === undefined) delete process.env.TZ;
else process.env.TZ = originalTimezone;
console.log("PASS local date boundaries in two timezones");

let chromium;
for (const base of [import.meta.url, "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/package.json"]) {
  try { chromium = createRequire(base)("playwright-core").chromium; break; } catch { /* Try the bundled runtime. */ }
}
assert.ok(chromium, "playwright-core is required for UI checks");
const executablePath = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find(existsSync);
assert.ok(executablePath, "Chrome or Edge is required for UI checks");

// Use a separate origin and in-memory Pinia fixtures; never touch the user's database.
const server = await createServer({
  configFile: false,
  optimizeDeps: {
    include: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"]
  },
  plugins: [vue()],
  server: { host: "127.0.0.1", port: 0 },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": '""',
    "import.meta.env.VITE_SUPABASE_ANON_KEY": '""'
  }
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 480 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForSelector(".dashboard-page");
  await page.evaluate(async () => {
    const { useTrackerStore } = await import("/src/stores/tracker.js");
    const store = useTrackerStore(document.querySelector("#app").__vue_app__.config.globalProperties.$pinia);
    const key = (offset) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    window.dashboardStore = store;
    store.records = [
      { id: "check-math", subjectId: "math1", paperName: "Current mathematics", date: key(0), score: 90, fullScore: 150 },
      { id: "check-english", subjectId: "english1", paperName: "Current English", date: key(-1), score: 80, fullScore: 100 },
      { id: "check-old", subjectId: "math1", paperName: "Old mathematics", date: key(-120), score: 60, fullScore: 150 }
    ];
    store.mistakes = [{ id: "check-mistake", subjectId: "math1", title: "Review", createdAt: key(-2), status: "待复盘" }];
  });
  await page.waitForFunction(() => document.querySelectorAll(".ds-record-card").length === 2);
  assert.equal(await page.locator(".ds-stat-value").nth(3).innerText(), "3天");
  await page.locator(".chart-status").first().waitFor();
  assert.equal(await page.locator(".chart-box canvas").count(), 0, "Charts stay deferred below the viewport");
  await page.locator(".chart-grid").scrollIntoViewIfNeeded();
  await page.waitForSelector(".chart-box canvas");
  await page.evaluate(async () => {
    window.dashboardCharts = await import("/src/services/scoreChartRuntime.js");
    window.chartOptions = () => [...document.querySelectorAll(".chart-box")].map((element) => window.dashboardCharts.getInstanceByDom(element)?.getOption());
  });
  await page.waitForFunction(() => window.chartOptions().every((option) => option?.series[0].data.length === 2));
  assert.deepEqual(await page.evaluate(() => window.chartOptions()[0].series[0].data), [80, 60]);
  await page.evaluate(() => { window.dashboardStore.records[0].score = 120; });
  await page.waitForFunction(() => window.chartOptions()[0].series[0].data[1] === 80);
  console.log("PASS filtered recent records, mistake activity, chart date range and score editing");

  await page.locator(".dashboard-filter select").selectOption("english1");
  await page.waitForFunction(() => document.querySelectorAll(".ds-record-card").length === 1);
  await page.waitForFunction(() => window.chartOptions()[0]?.series[0].data.length === 1);
  assert.equal(await page.locator(".ds-stat-value").nth(2).innerText(), "0道");
  await page.locator(".dashboard-filter select").selectOption("politics");
  await page.waitForSelector(".dashboard-page .ds-empty");
  assert.ok(await page.getByText("当前筛选范围内没有成绩").isVisible());
  await page.locator(".dashboard-filter select").selectOption("math1");
  await page.waitForFunction(() => window.chartOptions()[0]?.series[0].data[0] === 120);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.waitForFunction(() => window.chartOptions()[0]?.series[0].data.length === 2);
  assert.equal(await page.locator(".ds-record-card").count(), 2);
  assert.deepEqual(errors, []);
  console.log("PASS subject filters, empty state, chart disposal and recreation, all-time range");
} finally {
  await browser?.close();
  await server.close();
}
