import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

let chromium;
for (const base of [import.meta.url, "C:/Users/Administrator/.workbuddy-ai/binaries/node/workspace/package.json"]) {
  try { chromium = createRequire(base)("playwright-core").chromium; break; } catch { /* Try the bundled runtime. */ }
}
assert.ok(chromium, "playwright-core is required");
const executablePath = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find(existsSync);
const server = await createServer({
  configFile: false,
  plugins: [vue()],
  server: { host: "127.0.0.1", port: 0 },
  define: { "import.meta.env.VITE_SUPABASE_URL": '""', "import.meta.env.VITE_SUPABASE_ANON_KEY": '""' }
});
const score = (id, value, updatedAt = "2026-09-20T10:00:00.000Z") => ({
  id, paperName: "样本套卷", subjectId: "math1", score: value, fullScore: 150, date: "2026-09-20", updatedAt
});
const snapshot = (records) => ({ version: 3, subjects: [], records, mistakes: [], images: [] });
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.goto(`${base}/#/backup`);
  await page.getByRole("heading", { name: "备份与恢复", exact: true }).waitFor();
  await page.evaluate(async (row) => {
    const { db } = await import("/src/services/storage.js");
    const app = document.querySelector("#app").__vue_app__;
    const store = app.config.globalProperties.$pinia._s.get("tracker");
    await store.clearAll();
    await db.records.put(row);
    await store.load();
  }, score("local", 120));
  const archive = () => page.evaluate(async () => {
    const { db } = await import("/src/services/storage.js");
    return (await db.records.toArray()).map(({ id, score }) => [id, score]);
  });
  async function selectFile(button, payload) {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: button, exact: true }).click()
    ]);
    await chooser.setFiles({ name: "fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) });
  }

  await selectFile("合并导入", { records: {} });
  await page.getByRole("alert").getByText("备份里的「成绩」应为数组。").waitFor();
  assert.deepEqual(await archive(), [["local", 120]]);
  await selectFile("合并导入", { records: [score("local", 88, "2026-09-01"), score("new", 90), { id: "bad" }] });
  const merge = page.getByRole("dialog", { name: "预览合并导入" });
  await merge.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(await archive(), [["local", 120]]);
  assert.equal(await merge.getByRole("button", { name: "确认合并" }).isDisabled(), true);
  await merge.getByRole("checkbox", { name: "跳过无效条目，导入其余数据" }).check();
  await merge.getByRole("button", { name: "确认合并" }).click();
  await page.getByRole("status").getByText(/新增 1 条，更新 0 条，跳过 2 条/).waitFor();
  assert.deepEqual(await archive(), [["local", 120], ["new", 90]]);

  await page.goto(`${base}/#/`);
  await selectFile("恢复备份", { records: [score("home", 91)] });
  await merge.getByRole("button", { name: "确认合并" }).click();
  await page.getByText(/本机合并完成。新增 1 条/).waitFor();
  assert.equal((await archive()).some(([id]) => id === "home"), true);
  console.log("PASS both import entries, Chinese validation and explicit partial confirmation");

  await page.goto(`${base}/#/backup`);
  await selectFile("覆盖恢复", { subjects: [] });
  await page.getByRole("alert").getByText(/完整备份/).waitFor();
  const replacement = snapshot([score("replacement", 105)]);
  await selectFile("覆盖恢复", replacement);
  const overwrite = page.getByRole("dialog", { name: "预览覆盖恢复" });
  await overwrite.waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    overwrite.getByRole("button", { name: "先导出当前档案" }).click()
  ]);
  assert.match(download.suggestedFilename(), /^exam-tracker-backup-.*\.json$/);
  await page.evaluate(async (row) => {
    const { db } = await import("/src/services/storage.js");
    await db.records.put(row);
  }, score("late-edit", 110));
  await overwrite.getByRole("button", { name: "确认覆盖" }).click();
  await overwrite.getByRole("status").getByText(/预览后，本机数据发生了变化/).waitFor();
  assert.equal((await archive()).some(([id]) => id === "late-edit"), true);
  await overwrite.getByRole("button", { name: "确认覆盖" }).click();
  await page.getByText(/本机覆盖恢复完成/).waitFor();
  assert.deepEqual(await archive(), [["replacement", 105]]);
  console.log("PASS complete snapshot requirement, safety export and changed-data reconfirmation");

  const rollback = await page.evaluate(async (payload) => {
    const { db } = await import("/src/services/storage.js");
    const store = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("tracker");
    const pending = { id: "pending-delete", userId: "old-user", pendingSync: true, operationId: "op", deletedAt: new Date().toISOString(), record: { id: "pending-delete" } };
    await db.deletedRecords.put(pending);
    const put = db.deletedRecords.bulkPut;
    db.deletedRecords.bulkPut = async function (rows) {
      await put.call(this, rows);
      throw new Error("Abort the real IndexedDB transaction after writes");
    };
    try {
      await store.importData(payload, false);
      return false;
    } catch {
      return (await db.records.toArray()).map((row) => row.id).join(",") === "replacement" &&
        (await db.deletedRecords.get(pending.id))?.record?.id === pending.id;
    } finally {
      db.deletedRecords.bulkPut = put;
    }
  }, snapshot([score("must-roll-back", 72)]));
  assert.equal(rollback, true);
  await page.getByPlaceholder("清空").fill("清空");
  await page.getByRole("button", { name: "清空成绩、错题和图片" }).click();
  await page.getByText(/可恢复内容已清空/).waitFor();
  assert.deepEqual(await archive(), []);
  assert.deepEqual(await page.evaluate(async () => {
    const { db } = await import("/src/services/storage.js");
    const entry = await db.deletedRecords.get("pending-delete");
    return [entry.pendingSync, entry.operationId, entry.record];
  }), [true, "op", null]);
  console.log("PASS real IndexedDB rollback and pending deletion preservation");

  const refreshFailure = await page.evaluate(async (row) => {
    const { db } = await import("/src/services/storage.js");
    const store = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("tracker");
    const read = db.subjects.toArray;
    db.subjects.toArray = () => { throw new Error("Fixture refresh failure after commit"); };
    try {
      const result = await store.importData({ records: [row] });
      return [result.refreshFailed, (await db.records.get(row.id))?.score];
    } finally {
      db.subjects.toArray = read;
    }
  }, score("committed-before-refresh", 103));
  assert.deepEqual(refreshFailure, [true, 103]);
  console.log("PASS local commit reported separately from a failed refresh");

  await page.evaluate(async () => {
    const router = document.querySelector("#app").__vue_app__.config.globalProperties.$router;
    router.addRoute({ path: "/fixture-crash", component: { render() { throw new Error("Fixture route render failure"); } } });
    await router.push("/fixture-crash");
  });
  await page.getByRole("alert").getByText("此页面暂时无法显示").waitFor();
  await page.getByRole("link", { name: "前往备份与恢复" }).click();
  await page.getByRole("heading", { name: "备份与恢复", exact: true }).waitFor();
  console.log("PASS route failure fallback and navigation recovery");

  await page.evaluate(() => {
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(), reason: new DOMException("Fixture cancellation", "AbortError"), cancelable: true
    }));
  });
  assert.equal(await page.getByText(/有一项操作未能完成/).count(), 0);
  await page.evaluate(() => {
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(), reason: new Error("Fixture unexpected rejection"), cancelable: true
    }));
  });
  await page.getByText(/有一项操作未能完成/).waitFor();
  console.log("PASS asynchronous error reporting and cancellation filtering");

  const startup = await browser.newPage();
  startup.setDefaultTimeout(8000);
  await startup.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    window.failFixtureOpen = true;
    IDBFactory.prototype.open = function (...args) {
      if (args[0] === "exam-tracker-v3" && window.failFixtureOpen) throw new DOMException("Fixture storage unavailable", "SecurityError");
      return open.apply(this, args);
    };
  });
  await startup.goto(`${base}/#/backup`);
  await startup.getByRole("alert").getByText("暂时无法读取本机档案").waitFor();
  await startup.evaluate(() => { window.failFixtureOpen = false; });
  await startup.getByRole("button", { name: "重试读取" }).click();
  await startup.getByRole("heading", { name: "备份与恢复", exact: true }).waitFor();
  console.log("PASS startup storage failure and retry");
} finally {
  await browser?.close();
  await server.close();
}
