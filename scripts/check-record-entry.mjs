import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

let chromium;
for (const base of [import.meta.url, "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/package.json"]) {
  try { chromium = createRequire(base)("playwright-core").chromium; break; } catch { /* Try bundled runtime. */ }
}
assert.ok(chromium, "playwright-core is required");
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const server = await createServer({
  configFile: false, plugins: [vue()], server: { host: "127.0.0.1", port: 0 },
  define: { "import.meta.env.VITE_SUPABASE_URL": '""', "import.meta.env.VITE_SUPABASE_ANON_KEY": '""' }
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForSelector(".dashboard-page");
  const initialCount = await page.evaluate(async () => {
    const { useTrackerStore } = await import("/src/stores/tracker.js");
    return useTrackerStore(document.querySelector("#app").__vue_app__.config.globalProperties.$pinia).records.length;
  });
  await page.getByRole("button", { name: "记录成绩", exact: true }).first().click();
  const form = page.locator(".record-form");
  const name = form.getByPlaceholder('例如：27张八1');
  await form.locator("select").first().selectOption("math1");
  await name.fill("26张八1");
  await name.blur();
  assert.equal(await form.locator('.paper-kind-segmented button.active').innerText(), "模拟卷");
  await form.getByRole("button", { name: /真题/ }).click();
  await name.fill("27张八2");
  assert.ok((await form.locator('.paper-kind-segmented button.active').innerText()).startsWith("真题"));
  await form.getByRole("button", { name: /模拟卷/ }).click();
  await form.getByLabel("得分", { exact: true }).fill("121.5");
  await form.getByLabel("满分", { exact: true }).fill("150");
  await form.getByLabel("日期", { exact: true }).fill("2026-10-29");
  assert.doesNotMatch(await form.innerText(), /得分率|失分|识别分组|练习信息|成绩与用时/);

  await mkdir(".verify", { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `No overflow at ${width}`);
    await form.screenshot({ path: `.verify/record-entry-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    const { useTrackerStore } = await import("/src/stores/tracker.js");
    const store = useTrackerStore(document.querySelector("#app").__vue_app__.config.globalProperties.$pinia);
    window.originalAddRecord = store.addRecord;
    store.addRecord = async () => { throw new Error("Test storage failure"); };
  });
  await form.getByRole("button", { name: "保存成绩", exact: true }).click();
  await page.getByText("Test storage failure", { exact: true }).waitFor();
  assert.equal(await name.inputValue(), "27张八2");
  assert.equal(await form.getByLabel("得分", { exact: true }).inputValue(), "121.5");
  await page.evaluate(async () => {
    const { useTrackerStore } = await import("/src/stores/tracker.js");
    useTrackerStore(document.querySelector("#app").__vue_app__.config.globalProperties.$pinia).addRecord = window.originalAddRecord;
  });
  await form.getByRole("button", { name: "保存并继续", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.record-form input[placeholder="例如：27张八1"]')?.value === "");
  assert.ok(await form.isVisible());
  assert.equal(await form.getByLabel("日期", { exact: true }).inputValue(), "2026-10-29");
  assert.equal(await form.getByLabel("满分", { exact: true }).inputValue(), "150");
  await name.fill("27张八2");
  await form.getByLabel("得分", { exact: true }).fill("121.5");
  assert.equal(await form.locator(".record-duplicate-hint").count(), 0);
  await name.fill("27张八3");
  await form.getByLabel("得分", { exact: true }).fill("151");
  await form.getByRole("button", { name: "保存成绩", exact: true }).click();
  assert.match(await form.getByRole("alert").innerText(), /得分不能高于满分/);
  await form.getByLabel("得分", { exact: true }).fill("120");
  // Two submit events in the same tick must still create only one record.
  await form.evaluate((el) => { el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => !document.querySelector(".record-form"));
  const records = await page.evaluate(async () => {
    const { useTrackerStore } = await import("/src/stores/tracker.js");
    return useTrackerStore(document.querySelector("#app").__vue_app__.config.globalProperties.$pinia).records;
  });
  assert.equal(records.length, initialCount + 2);
  assert.equal(records.find((record) => record.paperName === "27张八2").paperVariant, "mock");
  assert.deepEqual(errors, []);
  console.log("PASS recognition, manual override, score validation, minimal layout, save-and-continue, double-submit guard and three screen sizes");
} finally {
  await browser?.close();
  await server.close();
}
